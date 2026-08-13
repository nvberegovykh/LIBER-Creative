#!/usr/bin/env python3
"""Bounded client for the official PNNL Legacy COMcheck-Web Backstop engine.

The generated project CXL is uploaded only to the configured official COMcheck
endpoint. Cookies are process-local, never logged, and discarded after one run.
"""

from __future__ import annotations

import http.cookiejar
import json
from pathlib import Path
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
    match = re.search(r"message\s*:\s*'((?:\\.|[^'])*)'", text, re.S)
    if not match:
        return "COMcheck-Web returned an unspecified DWR error."
    value = match.group(1).replace("\\'", "'").replace("\\n", " ").replace("\\r", " ")
    return value[:2000]


def _multipart(fields: dict[str, str], file_field: str, path: Path) -> tuple[bytes, str]:
    boundary = f"----REVEX-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode("utf-8"), b"\r\n",
        ])
    filename = path.name.replace('"', "_")
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        path.read_bytes(), b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class ComcheckClient:
    def __init__(self, base_url: str, log, timeout_seconds: int = 120):
        normalized = str(base_url or DEFAULT_BASE_URL).strip().rstrip("/") + "/"
        parsed = urllib.parse.urlparse(normalized)
        allow_nonofficial = str(__import__("os").environ.get("REVEX_ALLOW_COMCHECK_TEST_ENDPOINT", "")).lower() == "true"
        if parsed.scheme != "https" and not (allow_nonofficial and parsed.scheme == "http"):
            raise ComcheckBackstopError("COMcheck Backstop endpoint must use HTTPS.")
        if parsed.hostname != OFFICIAL_HOST and not allow_nonofficial:
            raise ComcheckBackstopError(f"COMcheck Backstop endpoint must be the official {OFFICIAL_HOST} service.")
        self.base_url = normalized
        self.timeout_seconds = max(10, min(int(timeout_seconds), 300))
        self.log = log
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        self.dwr_id = ""
        self.script_session_id = ""
        self.batch_id = 0

    def _request(self, method: str, relative: str, *, body: bytes | None = None,
                 content_type: str | None = None, expected: str = "text") -> bytes:
        url = urllib.parse.urljoin(self.base_url, relative)
        last_error: BaseException | None = None
        for attempt in range(1, 4):
            started = time.monotonic()
            self.log("HTTP_STARTED", method=method, endpoint=relative, attempt=attempt,
                     hardLimitSeconds=self.timeout_seconds)
            headers = {
                "User-Agent": "REVEX/0.8.19-r49 COMcheck Backstop",
                "Accept": "application/pdf,text/javascript,text/html;q=0.9,*/*;q=0.8",
            }
            if content_type:
                headers["Content-Type"] = content_type
            request = urllib.request.Request(url, data=body, headers=headers, method=method)
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
            "page": urllib.parse.quote("/CheckWeb/index.html", safe=""),
            "httpSessionId": "",
            "scriptSessionId": self.script_session_id,
            "c0-scriptName": service,
            "c0-methodName": method,
            "c0-id": "0",
            "batchId": str(self.batch_id),
            "instanceId": "0",
        }
        self.batch_id += 1
        return fields

    def start(self) -> None:
        self._request("GET", "index.html")
        fields = self._base_fields("__System", "generateId")
        reply = self._request(
            "POST", "dwr/call/plaincall/__System.generateId.dwr",
            body=self._plain_body(fields), content_type="text/plain"
        ).decode("utf-8", errors="replace")
        match = re.search(r'handleCallback\("\d+","\d+","([^"]+)"\)', reply)
        if not match:
            raise ComcheckBackstopError("COMcheck-Web did not establish a DWR session.")
        self.dwr_id = match.group(1)
        parsed = urllib.parse.urlparse(self.base_url)
        self.cookies.set_cookie(http.cookiejar.Cookie(
            version=0, name="DWRSESSIONID", value=self.dwr_id, port=None, port_specified=False,
            domain=str(parsed.hostname), domain_specified=True, domain_initial_dot=False,
            path="/CheckWeb", path_specified=True, secure=parsed.scheme == "https", expires=None, discard=True,
            comment=None, comment_url=None, rest={}, rfc2109=False
        ))
        self.script_session_id = f"{self.dwr_id}/revex-{uuid.uuid4().hex}"
        self.log("SESSION_READY", service=OFFICIAL_HOST)

    def upload_project(self, cxl: Path) -> None:
        fields = self._base_fields("ProjectService", "uploadProject")
        fields["c0-param0"] = "string:" + urllib.parse.quote(cxl.name, safe="")
        body, content_type = _multipart(fields, "c0-param1", cxl)
        reply = self._request(
            "POST", "dwr/call/htmlcall/ProjectService.uploadProject.dwr",
            body=body, content_type=content_type
        ).decode("utf-8", errors="replace")
        error = _dwr_error(reply)
        if error:
            raise ComcheckBackstopError(f"COMcheck CXL import failed: {error}")
        if "handleCallback" not in reply:
            raise ComcheckBackstopError("COMcheck CXL import returned no project callback.")
        self.log("PROJECT_IMPORTED", filename=cxl.name, bytes=cxl.stat().st_size)

    def calculate_backstop(self, evidence_path: Path) -> dict:
        fields = self._base_fields("ProjectService", "calculateEnvelopeCompliance")
        fields["c0-param0"] = "boolean:true"
        reply_bytes = self._request(
            "POST", "dwr/call/plaincall/ProjectService.calculateEnvelopeCompliance.dwr",
            body=self._plain_body(fields), content_type="text/plain"
        )
        reply = reply_bytes.decode("utf-8", errors="replace")
        evidence_path.write_bytes(reply_bytes)
        error = _dwr_error(reply)
        if error:
            raise ComcheckBackstopError(f"COMcheck Backstop calculation failed: {error}")
        if "handleCallback" not in reply or "envelopeStatus" not in reply:
            raise ComcheckBackstopError("COMcheck Backstop calculation returned no envelope result.")
        status_match = re.search(
            r"envelopeStatus\s*:\s*\{(?P<body>.*?)\}(?:,|\))", reply, re.S
        )
        body = status_match.group("body") if status_match else reply
        passes = re.search(r"passes\s*:\s*(true|false)", body)
        index = re.search(r"complianceIndex\s*:\s*(-?\d+(?:\.\d+)?)", body)
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
