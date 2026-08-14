#!/usr/bin/env python3
"""REVEX client for the official PNNL Legacy COMcheck-Web envelope Backstop.

The production wire format mirrors DWR 3's own browser XHR transport. The
current-project CheckXML is the only project payload transmitted. Cookies and
script-session identifiers are process-local and never logged.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
from pathlib import Path
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_BASE_URL = "https://legacy-comcheck.energycode.pnl.gov/CheckWeb/"
OFFICIAL_HOST = "legacy-comcheck.energycode.pnl.gov"
BACKSTOP_CODE = "2020 NYCECC Appendix CA Modeling Envelope Backstop"


class ComcheckBackstopError(RuntimeError):
    pass


def _dwr_error(text: str) -> str | None:
    if "handleBatchException" not in text and "handleException" not in text:
        return None
    match = re.search(r"message\s*:\s*['\"]((?:\\.|[^'\"])*)['\"]", text, re.S)
    if not match:
        return "COMcheck-Web returned an unspecified DWR error."
    value = match.group(1)
    value = value.replace("\\'", "'").replace('\\"', '"').replace("\\n", " ").replace("\\r", " ")
    return value[:2000]


def _callback_string(text: str) -> str | None:
    match = re.search(
        r"(?:remote\.)?(?:_?handleCallback|handleCallback)\s*\(\s*['\"]\d+['\"]\s*,\s*['\"]\d+['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)",
        text,
        re.S,
    )
    return match.group(1) if match else None


def _tokenify(number: int) -> str:
    chars = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ*$"
    remainder = max(1, int(number))
    out: list[str] = []
    while remainder > 0:
        out.append(chars[remainder & 0x3F])
        remainder //= 64
    return "".join(out)


def _new_page_id() -> str:
    return f"{_tokenify(int(time.time() * 1000))}-{_tokenify(int(random.random() * 1e16))}"


def _multipart(fields: dict[str, str], file_field: str, path: Path) -> tuple[bytes, str]:
    boundary = f"----REVEX-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode("ascii"),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("ascii"),
            str(value).encode("utf-8"), b"\r\n",
        ])
    filename = path.name.replace('"', "_")
    chunks.extend([
        f"--{boundary}\r\n".encode("ascii"),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode("utf-8"),
        b"Content-Type: application/octet-stream\r\n\r\n",
        path.read_bytes(), b"\r\n",
        f"--{boundary}--\r\n".encode("ascii"),
    ])
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class ComcheckClient:
    def __init__(self, base_url: str, log, timeout_seconds: int = 120):
        normalized = str(base_url or DEFAULT_BASE_URL).strip().rstrip("/") + "/"
        parsed = urllib.parse.urlparse(normalized)
        self.allow_nonofficial = str(os.environ.get("REVEX_ALLOW_COMCHECK_TEST_ENDPOINT", "")).lower() == "true"
        if parsed.scheme != "https" and not (self.allow_nonofficial and parsed.scheme == "http"):
            raise ComcheckBackstopError("COMcheck Backstop endpoint must use HTTPS.")
        if parsed.hostname != OFFICIAL_HOST and not self.allow_nonofficial:
            raise ComcheckBackstopError(f"COMcheck Backstop endpoint must be the official {OFFICIAL_HOST} service.")
        self.base_url = normalized
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.page_path = (parsed.path.rstrip("/") or "") + "/index.html"
        self.timeout_seconds = max(10, min(int(timeout_seconds), 300))
        self.log = log
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        self.dwr_id = ""
        self.script_session_id = ""
        self.page_id = _new_page_id()
        self.instance_id = "0"
        self.batch_id = 0
        self.session_ready = False

    def _headers(self, content_type: str | None = None) -> dict[str, str]:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 REVEX/0.8.19-r49",
            "Accept": "application/pdf,text/javascript,text/html;q=0.9,*/*;q=0.8",
            "Origin": self.origin,
            "Referer": urllib.parse.urljoin(self.base_url, "index.html"),
            "X-Requested-With": "XMLHttpRequest",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        }
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    def _request(self, method: str, relative: str, *, body: bytes | None = None,
                 content_type: str | None = None, expected: str = "text") -> bytes:
        url = urllib.parse.urljoin(self.base_url, relative)
        last_error: BaseException | None = None
        for attempt in range(1, 4):
            started = time.monotonic()
            self.log("HTTP_STARTED", method=method, endpoint=relative, attempt=attempt,
                     hardLimitSeconds=self.timeout_seconds)
            request = urllib.request.Request(url, data=body, headers=self._headers(content_type), method=method)
            try:
                with self.opener.open(request, timeout=self.timeout_seconds) as response:
                    payload = response.read()
                    status = int(getattr(response, "status", 200))
                    response_type = str(response.headers.get("Content-Type") or "")
                elapsed = round((time.monotonic() - started) * 1000)
                self.log("HTTP_COMPLETED", method=method, endpoint=relative, attempt=attempt,
                         httpStatus=status, elapsedMs=elapsed, bytes=len(payload), contentType=response_type)
                if expected == "pdf" and not payload.startswith(b"%PDF-"):
                    raise ComcheckBackstopError(f"COMcheck report endpoint returned {response_type or 'non-PDF content'}.")
                return payload
            except (urllib.error.URLError, TimeoutError, ComcheckBackstopError) as exc:
                last_error = exc
                self.log("HTTP_RETRY" if attempt < 3 else "HTTP_FAILED", method=method,
                         endpoint=relative, attempt=attempt, error=str(exc),
                         elapsedMs=round((time.monotonic() - started) * 1000))
                if attempt < 3:
                    time.sleep(attempt * 2)
        raise ComcheckBackstopError(f"COMcheck Backstop request failed: {last_error}")

    @staticmethod
    def _plain_body(fields: dict[str, str]) -> bytes:
        return ("\n".join(f"{key}={value}" for key, value in fields.items()) + "\n").encode("utf-8")

    def _base_fields(self, service: str, method: str) -> dict[str, str]:
        fields = {
            "callCount": "1",
            "nextReverseAjaxIndex": "0",
            "windowName": "",
            "c0-scriptName": service,
            "c0-methodName": method,
            "c0-id": "0",
            "batchId": str(self.batch_id),
            "instanceId": self.instance_id,
            "page": urllib.parse.quote(self.page_path, safe=""),
            "scriptSessionId": self.script_session_id,
        }
        self.batch_id += 1
        return fields

    def _dwr_call(self, service: str, method: str, relative: str, *, extra: dict[str, str] | None = None) -> str:
        fields = self._base_fields(service, method)
        if extra:
            fields.update(extra)
        reply = self._request(
            "POST", relative,
            body=self._plain_body(fields), content_type="text/plain; charset=UTF-8",
        ).decode("utf-8", errors="replace")
        error = _dwr_error(reply)
        if error:
            raise ComcheckBackstopError(f"COMcheck DWR {service}.{method} failed: {error}")
        return reply

    def start(self) -> None:
        self._request("GET", "index.html")
        if not self.allow_nonofficial:
            self._request("GET", "dwr/engine.js")

        fields = self._base_fields("__System", "generateId")
        reply = self._request(
            "POST", "dwr/call/plaincall/__System.generateId.dwr",
            body=self._plain_body(fields), content_type="text/plain; charset=UTF-8",
        ).decode("utf-8", errors="replace")
        error = _dwr_error(reply)
        if error:
            self.log("SESSION_GENERATE_ID_REJECTED", errorClass="DWR", error=error,
                     responsePrefix=reply[:180])
            raise ComcheckBackstopError(f"COMcheck-Web DWR session bootstrap failed: {error}")
        dwr_id = _callback_string(reply)
        if not dwr_id:
            self.log("SESSION_GENERATE_ID_UNPARSED", bytes=len(reply), callbackPresent="handleCallback" in reply,
                     responsePrefix=reply[:180])
            raise ComcheckBackstopError("COMcheck-Web did not establish a DWR session.")
        self.dwr_id = dwr_id

        if not any(cookie.name == "DWRSESSIONID" for cookie in self.cookies):
            parsed = urllib.parse.urlparse(self.base_url)
            self.cookies.set_cookie(http.cookiejar.Cookie(
                version=0, name="DWRSESSIONID", value=self.dwr_id, port=None, port_specified=False,
                domain=str(parsed.hostname), domain_specified=True, domain_initial_dot=False,
                path="/CheckWeb", path_specified=True, secure=parsed.scheme == "https", expires=None,
                discard=True, comment=None, comment_url=None, rest={}, rfc2109=False,
            ))
        self.script_session_id = f"{self.dwr_id}/{self.page_id}"

        if not self.allow_nonofficial:
            self._dwr_call("__System", "pageLoaded", "dwr/call/plaincall/__System.pageLoaded.dwr")

        self.session_ready = True
        self.log("SESSION_READY", service=OFFICIAL_HOST, protocol="DWR3_XHR",
                 dwrSessionPresent=True, instanceId=self.instance_id, page=self.page_path)

    def upload_project(self, cxl: Path) -> None:
        if not self.session_ready:
            raise ComcheckBackstopError("COMcheck DWR session is not ready.")
        fields = self._base_fields("ProjectService", "uploadProject")
        fields["c0-param0"] = "string:" + urllib.parse.quote(cxl.name, safe="")
        body, content_type = _multipart(fields, "c0-param1", cxl)
        reply = self._request(
            "POST", "dwr/call/htmlcall/ProjectService.uploadProject.dwr",
            body=body, content_type=content_type,
        ).decode("utf-8", errors="replace")
        error = _dwr_error(reply)
        if error:
            raise ComcheckBackstopError(f"COMcheck CXL import failed: {error}")
        if "handleCallback" not in reply:
            raise ComcheckBackstopError("COMcheck CXL import returned no project callback.")
        self.log("PROJECT_IMPORTED", filename=cxl.name, bytes=cxl.stat().st_size)

    def calculate_backstop(self, evidence_path: Path) -> dict:
        reply_bytes = self._request(
            "POST", "dwr/call/plaincall/ProjectService.calculateEnvelopeCompliance.dwr",
            body=self._plain_body({
                **self._base_fields("ProjectService", "calculateEnvelopeCompliance"),
                "c0-param0": "boolean:true",
            }),
            content_type="text/plain; charset=UTF-8",
        )
        reply = reply_bytes.decode("utf-8", errors="replace")
        evidence_path.write_bytes(reply_bytes)
        error = _dwr_error(reply)
        if error:
            raise ComcheckBackstopError(f"COMcheck Backstop calculation failed: {error}")
        if "handleCallback" not in reply or "envelopeStatus" not in reply:
            raise ComcheckBackstopError("COMcheck Backstop calculation returned no envelope result.")
        status_match = re.search(r"envelopeStatus\s*:\s*\{(?P<body>.*?)\}(?:,|\))", reply, re.S)
        status_body = status_match.group("body") if status_match else reply
        passes = re.search(r"passes\s*:\s*(true|false)", status_body)
        index = re.search(r"complianceIndex\s*:\s*(-?\d+(?:\.\d+)?)", status_body)
        summary = {
            "engine": "PNNL Legacy COMcheck-Web",
            "code": BACKSTOP_CODE,
            "passes": passes.group(1) == "true" if passes else None,
            "complianceIndex": float(index.group(1)) if index else None,
            "responseEvidence": evidence_path.name,
        }
        self.log("BACKSTOP_CALCULATED", **summary)
        return summary

    def download_report(self, destination: Path) -> None:
        query = urllib.parse.urlencode({
            "envelopeCertificate": "true",
            "intLightingCertificate": "false",
            "extLightingCertificate": "false",
            "mechanicalCertificate": "false",
            "mechanicalReqDescription": "false",
        })
        report_page = self._request("GET", f"report.html?{query}").decode("utf-8", errors="replace")
        if "report/current/pdf" not in report_page:
            raise ComcheckBackstopError("COMcheck-Web did not make the official compliance report available.")
        destination.write_bytes(self._request("GET", "report/current/pdf", expected="pdf"))
        self.log("OFFICIAL_REPORT_DOWNLOADED", filename=destination.name, bytes=destination.stat().st_size)


def run_official_backstop(cxl: Path, filing_dir: Path, project_identity: dict, log,
                          base_url: str = DEFAULT_BASE_URL) -> tuple[Path, Path, dict]:
    evidence = filing_dir / "COMcheck_BACKSTOP_ENGINE_RESPONSE.js"
    report = filing_dir / "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf"
    client = ComcheckClient(base_url, log)
    client.start()
    client.upload_project(cxl)
    summary = client.calculate_backstop(evidence)
    client.download_report(report)

    from pypdf import PdfReader
    reader = PdfReader(str(report))
    if not reader.pages:
        raise ComcheckBackstopError("Official COMcheck report contains no pages.")
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    normalized = re.sub(r"\s+", " ", text).strip()
    expected_identity = [str(project_identity.get(key) or "").strip() for key in ("title", "address")]
    expected_identity = [value for value in expected_identity if value]
    if expected_identity and not any(value.casefold() in normalized.casefold() for value in expected_identity):
        raise ComcheckBackstopError("Official COMcheck report does not identify the current active-Revit T/Z project.")
    if not any(token in normalized.casefold() for token in ("nycecc", "appendix ca", "modeling envelope backstop")):
        raise ComcheckBackstopError("Official COMcheck report does not identify the required NYCECC Backstop code path.")
    summary.update({
        "status": "OFFICIAL_REPORT_READY",
        "officialDoeReport": True,
        "report": report.name,
        "reportPages": len(reader.pages),
        "service": OFFICIAL_HOST,
    })
    (filing_dir / "COMcheck_BACKSTOP_RESULT.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return report, evidence, summary
