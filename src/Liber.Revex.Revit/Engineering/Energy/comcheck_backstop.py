#!/usr/bin/env python3
"""Bounded client for the official PNNL Legacy COMcheck-Web Backstop engine.

The generated project CXL is uploaded only to the configured official COMcheck
endpoint. Cookies are process-local, never logged, and discarded after one run.
"""

from __future__ import annotations

import http.cookiejar
import html
import json
import os
from pathlib import Path
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET


DEFAULT_BASE_URL = "https://legacy-comcheck.energycode.pnl.gov/CheckWeb/"
OFFICIAL_HOST = "legacy-comcheck.energycode.pnl.gov"
BACKSTOP_CODE = "2020 NYCECC Appendix CA Modeling Envelope Backstop"


class ComcheckBackstopError(RuntimeError):
    pass


def _scan_js_quoted_value(text: str, start: int) -> tuple[str, int] | None:
    """Read one JS single/double-quoted value in linear time, retaining escapes."""
    index = max(0, int(start))
    length = len(text)
    while index < length and text[index].isspace():
        index += 1
    if index >= length or text[index] not in ("'", '"'):
        return None
    quote = text[index]
    index += 1
    value: list[str] = []
    while index < length:
        char = text[index]
        if char == "\\":
            value.append(char)
            index += 1
            if index < length:
                value.append(text[index])
                index += 1
            continue
        if char == quote:
            return "".join(value), index + 1
        value.append(char)
        index += 1
    return None


def _quoted_values(text: str) -> list[str]:
    values: list[str] = []
    index = 0
    while index < len(text):
        if text[index] not in ("'", '"'):
            index += 1
            continue
        parsed = _scan_js_quoted_value(text, index)
        if parsed is None:
            index += 1
            continue
        value, index = parsed
        values.append(value)
    return values


def _dwr_error(text: str) -> str | None:
    if "handleBatchException" not in text and "handleException" not in text:
        return None
    # htmlcall replies commonly wrap DWR JavaScript inside HTML and may quote the exception
    # object with either single or double quotes. Parse quoted strings explicitly so hostile or
    # malformed server text cannot trigger regex backtracking in the release process.
    value = ""
    search_from = 0
    while True:
        message_at = text.find("message", search_from)
        if message_at < 0:
            break
        cursor = message_at + len("message")
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
        if cursor < len(text) and text[cursor] == ":":
            parsed = _scan_js_quoted_value(text, cursor + 1)
            if parsed is not None:
                value = parsed[0]
                break
        search_from = message_at + len("message")
    if not value:
        # Some DWR builds pass a human message as a positional string rather than object.message.
        for marker in ("handleBatchException(", "handleException("):
            call_at = text.find(marker)
            if call_at < 0:
                continue
            close_at = text.find(")", call_at + len(marker))
            segment = text[call_at + len(marker): close_at if close_at >= 0 else len(text)]
            positional = _quoted_values(segment)
            if positional:
                value = positional[-1]
                break
    if not value:
        compact = re.sub(r"\s+", " ", html.unescape(text)).strip()
        return ("COMcheck-Web DWR import exception (raw response retained): " + compact[:1200]) if compact else "COMcheck-Web returned an unspecified DWR error."
    value = (value.replace("\\'", "'").replace('\\"', '"')
                  .replace("\\n", " ").replace("\\r", " ").replace("\\t", " "))
    value = re.sub(r"\s+", " ", html.unescape(value)).strip()
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
    _DWR_TOKEN_CHARS = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ*$"

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
        self._reset_transport()

    def _reset_transport(self) -> None:
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        self.dwr_id = ""
        self.script_session_id = ""
        self.http_session_id = ""
        self.http_session_cookie_name = "JSESSIONID"
        # This process emulates exactly one initialized DWR engine instance. Browser preInit()
        # registers that first engine as index 0 before any request is sent.
        self.instance_id = "0"
        self.page_path = "/CheckWeb/index.html"
        self.page_url = urllib.parse.urljoin(self.base_url, "index.html")
        self.batch_id = 0
        self.engine_mode = "DWR3_COOKIE"
        # DWR 3 deliberately does not echo the Java HTTP session as a request field;
        # it correlates the application session from the cookie and uses DWRSESSIONID
        # separately for the DWR/CSRF session. Older engines may still emit an explicit
        # httpSessionId field, so this is selected from the served engine.js contract.
        self.include_http_session_field = False

    def _cookie_value(self, name: str) -> str:
        target = str(name or "").casefold()
        for cookie in self.cookies:
            if str(cookie.name).casefold() == target:
                return str(cookie.value or "")
        return ""

    @classmethod
    def _dwr_tokenify(cls, value: int) -> str:
        number = max(0, int(value))
        if number == 0:
            return cls._DWR_TOKEN_CHARS[0]
        base = len(cls._DWR_TOKEN_CHARS)
        output = []
        while number:
            number, rem = divmod(number, base)
            output.append(cls._DWR_TOKEN_CHARS[rem])
        # DWR engine.js appends least-significant base-64 digits and does not reverse them.
        return "".join(output)

    @classmethod
    def _new_dwr_page_id(cls) -> str:
        # DWR 3 engine.js uses a timestamp/random token pair for the browser page id.
        random_component = secrets.randbelow(10_000_000_000_000_000)
        return f"{cls._dwr_tokenify(int(time.time() * 1000))}-{cls._dwr_tokenify(random_component)}"

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
            if method.upper() == "POST":
                parsed = urllib.parse.urlparse(self.base_url)
                headers["Origin"] = f"{parsed.scheme}://{parsed.netloc}"
                headers["Referer"] = self.page_url
            if content_type:
                headers["Content-Type"] = content_type
            request = urllib.request.Request(url, data=body, headers=headers, method=method)
            try:
                with self.opener.open(request, timeout=self.timeout_seconds) as response:
                    payload = response.read()
                    status = int(getattr(response, "status", 200))
                    response_type = str(response.headers.get("Content-Type") or "")
                    final_url = str(response.geturl() or url)
                elapsed = round((time.monotonic() - started) * 1000)
                self.log("HTTP_COMPLETED", method=method, endpoint=relative, attempt=attempt,
                         httpStatus=status, elapsedMs=elapsed, bytes=len(payload), contentType=response_type)
                if expected == "pdf" and not payload.startswith(b"%PDF-"):
                    raise ComcheckBackstopError(f"COMcheck report endpoint returned {response_type or 'non-PDF content'}.")
                if relative == "index.html":
                    self.page_url = final_url
                    parsed_page = urllib.parse.urlparse(final_url)
                    self.page_path = parsed_page.path + (("?" + parsed_page.query) if parsed_page.query else "")
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
        # DWR Batch.java accepts only letters, digits, and underscore for instanceId. A served
        # engine.js starts at -1 only before browser preInit(); sending that literal is invalid.
        if not re.fullmatch(r"[A-Za-z0-9_]+", str(self.instance_id or "")):
            raise ComcheckBackstopError(
                f"COMcheck DWR engine instance id is not browser-initialized: {self.instance_id!r}."
            )
        fields = {
            "callCount": "1",
            "page": urllib.parse.quote(self.page_path, safe=""),
            "scriptSessionId": self.script_session_id,
            "c0-scriptName": service,
            "c0-methodName": method,
            "c0-id": "0",
            "batchId": str(self.batch_id),
            "instanceId": self.instance_id,
            "windowName": "",
        }
        # DWR 2-era engines could add an explicit HTTP-session field. DWR 3's browser
        # prepareToSend() does not; adding it ourselves changes the signed/session request
        # contract and current COMcheck rejects that bootstrap. Follow the engine actually
        # served by the official site instead of forcing one protocol generation.
        if self.include_http_session_field and self.http_session_id:
            fields["httpSessionId"] = urllib.parse.quote(self.http_session_id, safe="")
        self.batch_id += 1
        return fields

    @staticmethod
    def _engine_uses_http_session_field(engine_text: str) -> bool:
        if not engine_text:
            return False
        # Match code that actually populates the outbound batch map, not comments or the
        # session-cookie configuration variable. This keeps DWR3 cookie correlation clean.
        patterns = (
            r"batch\.map(?:\[\s*[\"']httpSessionId[\"']\s*\]|\.httpSessionId)\s*=",
            r"map\s*\[\s*[\"']httpSessionId[\"']\s*\]\s*=",
            r"map\.httpSessionId\s*=",
        )
        return any(re.search(pattern, engine_text) for pattern in patterns)

    @staticmethod
    def _parse_engine_contract(engine_text: str) -> tuple[str, str, str]:
        cookie_match = re.search(r'_sessionCookieName\s*=\s*["\']([^"\']+)', engine_text)
        cookie_name = cookie_match.group(1) if cookie_match else "JSESSIONID"
        instance_match = re.search(r'_instanceId\s*=\s*(-?\d+)', engine_text)
        instance_literal = instance_match.group(1) if instance_match else ""
        # The DWR 3 engine source initializes _instanceId to -1, then preInit() registers the
        # engine in window.dwr._ and replaces it with the engine index before the first request.
        # REVEX has one engine-equivalent client, so its browser-effective instance is 0. Never
        # transmit the pre-initialization -1 literal: Batch.java rejects the hyphen as invalid.
        instance_id = instance_literal if instance_literal and not instance_literal.startswith("-") else "0"
        orig_match = re.search(r'_origScriptSessionId\s*=\s*["\']([^"\']+)', engine_text)
        orig_script = orig_match.group(1) if orig_match else ""
        return cookie_name, instance_id, orig_script

    def start(self, *, reset: bool = False) -> None:
        if reset:
            self._reset_transport()
        self._request("GET", "index.html")

        # Read the exact engine contract served by COMcheck so this client follows whichever
        # supported DWR generation the official site is currently running instead of pinning
        # browser-session internals in REVEX.
        engine_text = ""
        try:
            engine_text = self._request("GET", "dwr/engine.js").decode("utf-8", errors="replace")
        except ComcheckBackstopError as exc:
            self.log("SESSION_ENGINE_FALLBACK", reason=str(exc))
        cookie_name, instance_id, orig_script = self._parse_engine_contract(engine_text)
        self.http_session_cookie_name = cookie_name
        self.instance_id = instance_id
        self.http_session_id = self._cookie_value(cookie_name)
        self.include_http_session_field = self._engine_uses_http_session_field(engine_text)

        dwr_cookie = self._cookie_value("DWRSESSIONID")
        modern_dwr = "DWRSESSIONID" in engine_text or "setDwrSession" in engine_text or not orig_script
        if modern_dwr:
            self.engine_mode = "DWR3_COOKIE"
            if not dwr_cookie:
                fields = self._base_fields("__System", "generateId")
                reply = self._request(
                    "POST", "dwr/call/plaincall/__System.generateId.dwr",
                    body=self._plain_body(fields), content_type="text/plain"
                ).decode("utf-8", errors="replace")
                dwr_error = _dwr_error(reply)
                if dwr_error:
                    self.log("SESSION_GENERATE_ID_REJECTED", error=dwr_error[:1000])
                    raise ComcheckBackstopError(f"COMcheck-Web DWR session bootstrap failed: {dwr_error}")
                # DWR 3 has shipped multiple callback renderings in the wild:
                #   dwr.engine.remote.handleCallback("0","0","TOKEN")
                #   dwr.engine.remote.handleCallback( "0", "0", "TOKEN" )
                # and some servlet/container combinations set DWRSESSIONID directly while
                # returning a wrapper callback whose argument formatting differs. Prefer the
                # server cookie when present; otherwise extract the callback token without
                # depending on whitespace or the exact remote-handler prefix.
                dwr_cookie = self._cookie_value("DWRSESSIONID")
                if dwr_cookie:
                    self.dwr_id = dwr_cookie
                else:
                    callback_at = reply.find("handleCallback")
                    token = ""
                    if callback_at >= 0:
                        open_at = reply.find("(", callback_at + len("handleCallback"))
                        close_at = reply.find(")", open_at + 1) if open_at >= 0 else -1
                        args = reply[open_at + 1: close_at if close_at >= 0 else len(reply)] if open_at >= 0 else ""
                        quoted = _quoted_values(args)
                        # The first two quoted callback arguments are normally batch/call ids.
                        # Choose the last non-trivial quoted value so protocol wrappers and
                        # optional arguments do not make session establishment brittle.
                        for value in reversed(quoted):
                            decoded = (value.replace("\\'", "'").replace('\\"', '"')
                                            .replace("\\n", "").replace("\\r", ""))
                            if decoded and not decoded.isdigit():
                                token = decoded
                                break
                    if not token:
                        # Preserve a safe structural fingerprint for diagnosis, never the
                        # session token/cookies themselves.
                        compact = re.sub(r'\s+', ' ', reply).strip()
                        self.log("SESSION_GENERATE_ID_UNPARSED", bytes=len(reply.encode("utf-8")),
                                 callbackPresent="handleCallback" in reply,
                                 responsePrefix=compact[:120])
                        raise ComcheckBackstopError("COMcheck-Web did not establish a DWR session.")
                    self.dwr_id = token
                if not dwr_cookie:
                    parsed = urllib.parse.urlparse(self.base_url)
                    self.cookies.set_cookie(http.cookiejar.Cookie(
                        version=0, name="DWRSESSIONID", value=self.dwr_id, port=None, port_specified=False,
                        domain=str(parsed.hostname), domain_specified=True, domain_initial_dot=False,
                        path="/CheckWeb", path_specified=True, secure=parsed.scheme == "https", expires=None,
                        discard=True, comment=None, comment_url=None, rest={}, rfc2109=False
                    ))
                    dwr_cookie = self.dwr_id
            else:
                self.dwr_id = dwr_cookie
            self.script_session_id = f"{dwr_cookie}/{self._new_dwr_page_id()}"
        else:
            self.engine_mode = "DWR_LEGACY_ORIG_SCRIPT"
            # Older DWR engines derive the script-session id from the server-generated original
            # page id plus a browser random integer in [0,999].
            self.script_session_id = f"{orig_script}{secrets.randbelow(1000)}"

        # GET index.html establishes the Java HttpSession. Refresh the cookie after generateId
        # in case the container created/rotated it there. Only legacy engines that explicitly
        # populate httpSessionId in engine.js will receive that field in later calls.
        refreshed_http = self._cookie_value(cookie_name)
        if refreshed_http:
            self.http_session_id = refreshed_http
        if not self.http_session_id:
            raise ComcheckBackstopError(
                f"COMcheck-Web did not establish its {cookie_name} HTTP application session."
            )
        self.log("SESSION_READY", service=OFFICIAL_HOST, protocol=self.engine_mode,
                 httpSessionCookie=cookie_name, httpSessionPresent=True,
                 httpSessionField=self.include_http_session_field,
                 dwrSessionPresent=bool(dwr_cookie), instanceId=self.instance_id,
                 page=self.page_path)

    def _upload_once(self, cxl: Path, evidence_path: Path | None, attempt: int) -> str | None:
        fields = self._base_fields("ProjectService", "uploadProject")
        fields["c0-param0"] = "string:" + urllib.parse.quote(cxl.name, safe="")
        body, content_type = _multipart(fields, "c0-param1", cxl)
        reply_bytes = self._request(
            "POST", "dwr/call/htmlcall/ProjectService.uploadProject.dwr",
            body=body, content_type=content_type
        )
        if evidence_path is not None:
            attempt_path = evidence_path.with_name(f"{evidence_path.stem}.attempt{attempt}{evidence_path.suffix}")
            attempt_path.write_bytes(reply_bytes)
            evidence_path.write_bytes(reply_bytes)
        reply = reply_bytes.decode("utf-8", errors="replace")
        return _dwr_error(reply)

    def upload_project(self, cxl: Path, evidence_path: Path | None = None) -> None:
        for session_attempt in range(1, 3):
            error = self._upload_once(cxl, evidence_path, session_attempt)
            if not error:
                self.log("PROJECT_IMPORTED", filename=cxl.name, bytes=cxl.stat().st_size,
                         uploadResponse=(evidence_path.name if evidence_path is not None else None),
                         sessionAttempt=session_attempt)
                return
            if "InvalidSessionException" in error and session_attempt == 1:
                self.log("SESSION_REJECTED_REBOOTSTRAP", errorClass="InvalidSessionException",
                         retry=2, projectDataResent=False)
                # Throw away all cookie/session state and establish a browser-equivalent session
                # from the official site before retrying the exact same immutable CXL once.
                self.start(reset=True)
                continue
            raise ComcheckBackstopError(f"COMcheck CXL import failed: {error}")
        raise ComcheckBackstopError("COMcheck CXL import failed after a fresh official session bootstrap.")

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



def _local_name(node: ET.Element) -> str:
    return node.tag.rsplit("}", 1)[-1]


def _child(node: ET.Element | None, name: str) -> ET.Element | None:
    if node is None:
        return None
    return next((item for item in list(node) if _local_name(item) == name), None)


def _descendants(node: ET.Element | None, name: str) -> list[ET.Element]:
    if node is None:
        return []
    return [item for item in node.iter() if _local_name(item) == name]


def _text(node: ET.Element | None, name: str, default: str = "") -> str:
    item = _child(node, name)
    return str(item.text or "").strip() if item is not None else default


def _number(node: ET.Element | None, name: str, default: float = 0.0) -> float:
    try:
        return float(_text(node, name, str(default)))
    except (TypeError, ValueError):
        return default


def _boolean(node: ET.Element | None, name: str, default: bool = False) -> bool:
    value = _text(node, name, "true" if default else "false").lower()
    return value in ("true", "1", "yes")


def _component_values(node: ET.Element, component: str, type_field: str) -> dict:
    """Translate one CheckXML component to COMcheck's current browser row model."""
    values: dict[str, object] = {
        "component": component,
        "type": _text(node, type_field),
        "userDescription": _text(node, "assemblyType") or _text(node, "description"),
        "nonEditableDescription": _text(node, "description"),
        "otherType": "NONE",
        "alterationExemption": "EXEMPT_NOT_APPLICABLE",
        "grossArea": _number(node, "grossArea"),
        "orientation": _text(node, "orientation", "UNSPECIFIED_ORIENTATION"),
        "constructionType": _text(node, "constructionType", "RESIDENTIAL"),
        "cavR": _number(node, "cavityRvalue"),
        "contR": _number(node, "continuousRvalue"),
        "propUFactor": _number(node, "propUvalue"),
        "shgc": _number(node, "propShgc"),
        "vlt": _number(node, "propVt"),
        "productId": _text(node, "productId", "REVEX EN evidence"),
        "perfDataType": _text(node, "perfDataType", "PERF_TYPE_OTHER"),
        "frameType": _text(node, "frameType", "NONE"),
        "glazingType": _text(node, "glazingType", "NONE"),
        "glazingMaterialType": _text(node, "glazingMaterialType", "NONE"),
        "solarType": _text(node, "solarType", "NONE"),
        "windowOpenType": _text(node, "windowOpenType", "NONE"),
        "feetAg": _number(node, "feetAg"),
        "doorOpenType": _text(node, "doorOpenType", "NONE"),
        "doorEntranceType": _text(node, "doorEntranceType", "NONE"),
        "concreteThickness": _number(node, "concreteThickness"),
        "concreteDensity": _number(node, "concreteDensity"),
        "cmuType": _text(node, "cmuType", "NONE"),
        "furringType": _text(node, "furringType", "NONE"),
        "nextToUnconditionedSpace": _boolean(node, "nextToUncondSpace"),
        "insulationPosition": _text(node, "insulationPosition", "NONE"),
        "insulationDepth": _number(node, "depthOfInsulation"),
        "hasEdgeInsulation": _boolean(node, "hasEdgeInsulation"),
        "roofInsulType": _text(node, "roofInsulType", "NONE"),
        "floorExposedFrameType": _text(node, "floorExposedFrameType", "NONE"),
        "agWallConstructionDetailsType": _text(node, "agWallConstructionDetailsType", "NONE"),
        "isSiteShading": _boolean(node, "isSiteShading"),
    }
    return values


def _fresh_project_spec(cxl: Path) -> dict:
    root = ET.parse(cxl).getroot()
    control = _child(root, "control")
    project = _child(root, "project")
    lighting = _child(root, "lighting")

    whole = next((item for item in _descendants(lighting, "wholeBldgUse")
                  if _text(item, "wholeBldgType") not in ("", "WHOLE_BUILDING_INVALID_USE")), None)
    if whole is None:
        whole = next(iter(_descendants(lighting, "wholeBldgUse")), None)
    building_use = {
        "type": _text(whole, "wholeBldgType", "WHOLE_BUILDING_MULTIFAMILY"),
        "constructionType": _text(whole, "constructionType", "RESIDENTIAL"),
        "floorArea": _number(whole, "floorArea"),
        "powerDensity": _number(whole, "powerDensity"),
    }
    if building_use["type"] == "WHOLE_BUILDING_INVALID_USE":
        building_use["type"] = "WHOLE_BUILDING_MULTIFAMILY"

    walls: list[dict] = []
    for wall in _descendants(root, "agWall"):
        wall_spec = _component_values(wall, "AG_WALL", "wallType")
        wall_spec["children"] = [
            *[_component_values(item, "WINDOW", "frameType") for item in _descendants(_child(wall, "windows"), "window")],
            *[_component_values(item, "DOOR", "doorType") for item in _descendants(_child(wall, "doors"), "door")],
        ]
        walls.append(wall_spec)

    return {
        "code": _text(control, "code", "CEZ_NYSTRETCH_NYC_90_1_11_G"),
        "title": _text(project, "projectTitle"),
        "address": _text(project, "projectAddress"),
        "projectCity": _text(project, "projectCity"),
        "projectState": _text(project, "projectState"),
        "projectZip": _text(project, "projectZipCode"),
        "state": "New York",
        "city": "New York",
        "height": _number(root, "feetBldgHeight"),
        "stories": int(round(_number(root, "numberOfStories"))),
        "buildingUse": building_use,
        "walls": walls,
        "roofs": [_component_values(item, "ROOF", "roofType") for item in _descendants(root, "roof")],
        "floors": [_component_values(item, "FLOOR", "floorType") for item in _descendants(root, "floor")],
        "sourceCounts": {
            "walls": len(walls),
            "windows": sum(1 for item in root.iter() if _local_name(item) == "window"),
            "doors": sum(1 for item in root.iter() if _local_name(item) == "door"),
            "roofs": sum(1 for item in root.iter() if _local_name(item) == "roof"),
            "floors": sum(1 for item in root.iter() if _local_name(item) == "floor"),
        },
    }


class FreshProjectBrowserClient:
    """Build a clean current-session COMcheck project through the supported UI model."""

    def __init__(self, base_url: str, log, timeout_seconds: int = 120):
        normalized = str(base_url or DEFAULT_BASE_URL).strip().rstrip("/") + "/"
        parsed = urllib.parse.urlparse(normalized)
        if parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST:
            raise ComcheckBackstopError(f"COMcheck Backstop endpoint must be the official {OFFICIAL_HOST} service.")
        self.base_url = normalized
        self.log = log
        self.timeout_seconds = max(30, min(int(timeout_seconds), 300))
        self.driver = None

    def _start_driver(self):
        try:
            from selenium import webdriver
        except ImportError as exc:
            raise ComcheckBackstopError("Selenium is required for the clean COMcheck project translator.") from exc
        options = webdriver.ChromeOptions()
        options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument("--window-size=1440,1200")
        binary = str(os.environ.get("REVEX_CHROME_BINARY") or "").strip()
        if binary:
            options.binary_location = binary
        try:
            driver = webdriver.Chrome(options=options)
        except Exception as exc:
            raise ComcheckBackstopError(f"The clean COMcheck translator could not start Chromium: {exc}") from exc
        driver.set_page_load_timeout(self.timeout_seconds)
        driver.set_script_timeout(self.timeout_seconds)
        self.driver = driver
        return driver

    def _wait(self, predicate, message: str, timeout: int | None = None) -> None:
        from selenium.webdriver.support.ui import WebDriverWait
        try:
            WebDriverWait(self.driver, timeout or self.timeout_seconds).until(predicate)
        except Exception as exc:
            raise ComcheckBackstopError(message) from exc

    def _set_clean_project_header(self, spec: dict) -> None:
        driver = self.driver
        driver.execute_script("dwr.engine.setAsync(false)")
        driver.execute_script("$('#code').val(arguments[0]).trigger('change')", spec["code"])
        self._wait(
            lambda d: d.execute_script("return USER_PROJECT.project.buildingDetails.energyCode.value") == spec["code"],
            "COMcheck did not activate the 2020 NYCECC Appendix CA Backstop code.",
        )
        driver.execute_script("$('#state').val(arguments[0]).trigger('change')", spec["state"])
        driver.execute_script("$('#cities').val(arguments[0]).trigger('change')", spec["city"])
        driver.execute_script(
            """
            const set=(id,value)=>{const e=document.getElementById(id);if(e){e.value=String(value??'');$(e).trigger('change')}};
            set('projectTitle',arguments[0]);
            set('projectAddress',arguments[1]);
            set('projectCity',arguments[2]);
            set('projectState',arguments[3]);
            set('projectZipCode',arguments[4]);
            set('feetBldgHeight',arguments[5]);
            set('numberOfStories',arguments[6]);
            const orient=document.getElementById('orientationSwitch');
            if(orient&&!orient.checked){orient.checked=true;$(orient).trigger('change')}
            """,
            spec["title"], spec["address"], spec["projectCity"],
            spec["projectState"], spec["projectZip"], spec["height"], spec["stories"],
        )
        self.log(
            "FRESH_PROJECT_HEADER_READY", code=spec["code"], state=spec["state"], city=spec["city"],
            title=spec["title"], stories=spec["stories"], height=spec["height"],
        )

    def _set_building_use(self, use: dict) -> str:
        result = self.driver.execute_script(
            """
            const use=arguments[0], rows=buildingUseTable.getList();
            const snapshot=()=>rows.map((r,i)=>({i,fields:r?Object.keys(r):[],component:r&&r.component&&r.component.value}));
            try{
              let row=rows.find(r=>r&&r.component&&r.type);
              if(!row){
                const fields={
                  component:createInputField('WHOLE_BLDG'),
                  type:createInputField(use.type),
                  constructionType:createInputField(use.constructionType),
                  floorArea:createInputField(Number(use.floorArea||0)),
                  powerDensity:createInputField(Number(use.powerDensity||0))
                };
                row=buildingUseTable.buildNewComponent(fields);
                const status=buildingUseTable.addToServer(row,null);
                if(status!==true)return {ok:false,error:'addToServer returned false',rows:snapshot()};
                enableSave();
                rows.push(row);
                buildingUseTable.finish(row,'add');
              }else{
                if(!row.constructionType)row.constructionType=createInputField(use.constructionType);
                if(!row.floorArea)row.floorArea=createInputField(0);
                if(!row.powerDensity)row.powerDensity=createInputField(0);
                row.type.value=use.type;
                row.constructionType.value=use.constructionType;
                row.floorArea.value=Number(use.floorArea||0);
                row.powerDensity.value=Number(use.powerDensity||0);
                buildingUseTable.updateServerComponent(row,{
                  type:true,constructionType:true,floorArea:true,powerDensity:true
                });
                buildingUseTable.redraw([row]);
              }
              return {
                ok:true,id:row.id,key:row.key&&row.key.value,type:row.type&&row.type.value,
                area:row.floorArea&&row.floorArea.value,fields:Object.keys(row),rows:snapshot()
              };
            }catch(error){
              return {ok:false,error:String(error),stack:String(error&&error.stack||''),rows:snapshot()};
            }
            """,
            use,
        )
        if (not result or not result.get("ok") or result.get("type") != use["type"]
                or float(result.get("area") or 0) <= 0 or not result.get("key")):
            raise ComcheckBackstopError(f"COMcheck rejected the clean project building use: {result}")
        key = str(result["key"])
        self.log("FRESH_BUILDING_USE_READY", buildingType=use["type"], floorArea=use["floorArea"])
        return key

    def _add_component(self, component: dict, parent_index: int | None, building_use_key: str) -> int:
        values = dict(component)
        values.pop("children", None)
        values["bldgUseKey"] = building_use_key
        result = self.driver.execute_script(
            """
            const values=arguments[0],parentIndex=arguments[1],fields={};
            try{
              for(const [key,value] of Object.entries(values))fields[key]=createInputField(value);
              const child=values.component==='WINDOW'||values.component==='DOOR';
              const list=envelopeTable.getList();
              const parent=child?list[parentIndex]:null;
              if(child&&!parent)return {ok:false,error:'missing parent '+parentIndex};
              const row=envelopeTable.buildNewComponent(fields);
              let response=null,remoteError=null;
              const describe=(message,error)=>({
                message:String(message||error||'EnvelopeView.add failed'),
                javaClassName:String(error&&error.javaClassName||''),
                detail:String(error&&error.message||'')
              });
              EnvelopeView.add(row,parent&&parent.id,{
                callback:value=>{response=value},
                exceptionHandler:(message,error)=>{remoteError=describe(message,error)},
                errorHandler:(message,error)=>{remoteError=describe(message,error)}
              });
              if(remoteError)return {ok:false,error:'EnvelopeView.add rejected row',remoteError};
              if(!response)return {ok:false,error:'EnvelopeView.add returned no row'};
              $.extend(row,response);
              enableSave();
              if(child)parent.children.push(row);else list.push(row);
              const index=child?-1:list.indexOf(row);
              return {
                ok:true,index,id:row.id,component:row.component&&row.component.value,
                type:row.type&&row.type.value,rows:list.length,parentId:parent&&parent.id
              };
            }catch(error){
              return {ok:false,error:String(error),stack:String(error&&error.stack||'')};
            }
            """,
            values, parent_index,
        )
        if result is None:
            def retained(driver):
                return driver.execute_script(
                    """
                    const component=arguments[0],label=arguments[1],list=envelopeTable.getList();
                    const matches=r=>r&&r.component&&r.component.value===component&&
                      r.userDescription&&r.userDescription.value===label;
                    return list.some(matches)||list.some(r=>(r.children||[]).some(matches));
                    """,
                    values.get("component"), values.get("userDescription"),
                )
            self._wait(
                retained,
                f"COMcheck did not retain fresh {values.get('component')} {values.get('userDescription')}.",
                timeout=20,
            )
            result = self.driver.execute_script(
                """
                const component=arguments[0],label=arguments[1],list=envelopeTable.getList();
                const matches=r=>r&&r.component&&r.component.value===component&&
                  r.userDescription&&r.userDescription.value===label;
                for(let i=list.length-1;i>=0;i--){
                  if(matches(list[i]))return {ok:true,index:i,id:list[i].id,component,type:list[i].type&&list[i].type.value,rows:list.length,recovered:true};
                  const children=list[i].children||[];
                  for(let j=children.length-1;j>=0;j--)if(matches(children[j]))
                    return {ok:true,index:-1,id:children[j].id,component,type:children[j].type&&children[j].type.value,rows:list.length,recovered:true};
                }
                return {ok:false,error:'accepted row disappeared from refreshed model'};
                """,
                values.get("component"), values.get("userDescription"),
            )
        if not result or not result.get("ok"):
            raise ComcheckBackstopError(
                f"COMcheck rejected fresh {values.get('component')} {values.get('userDescription')}: {result}"
            )
        return int(result["index"])

    def _build_envelope(self, spec: dict, building_use_key: str) -> None:
        created = {"walls": 0, "windows": 0, "doors": 0, "roofs": 0, "floors": 0}
        for wall in spec["walls"]:
            parent_index = self._add_component(wall, None, building_use_key)
            created["walls"] += 1
            for child in wall.get("children") or []:
                self._add_component(child, parent_index, building_use_key)
                created["windows" if child["component"] == "WINDOW" else "doors"] += 1
        for roof in spec["roofs"]:
            self._add_component(roof, None, building_use_key)
            created["roofs"] += 1
        for floor in spec["floors"]:
            self._add_component(floor, None, building_use_key)
            created["floors"] += 1
        if created != spec["sourceCounts"]:
            raise ComcheckBackstopError(f"Clean COMcheck translation count mismatch: {created} != {spec['sourceCounts']}")
        self.log("FRESH_ENVELOPE_READY", **created)

    def _download_with_browser_cookies(self, relative: str, expected: str = "text") -> bytes:
        cookies = "; ".join(f"{item['name']}={item['value']}" for item in self.driver.get_cookies())
        user_agent = self.driver.execute_script("return navigator.userAgent")
        request = urllib.request.Request(
            urllib.parse.urljoin(self.base_url, relative),
            headers={"Cookie": cookies, "User-Agent": user_agent, "Referer": urllib.parse.urljoin(self.base_url, "index.html")},
        )
        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            payload = response.read()
        if expected == "pdf" and not payload.startswith(b"%PDF-"):
            raise ComcheckBackstopError("COMcheck report endpoint returned non-PDF content.")
        return payload

    def _export_clean_cxl(self) -> bytes:
        result = self.driver.execute_async_script(
            """
            const done=arguments[arguments.length-1];
            ProjectService.downloadProject({
              callback:path=>done({ok:true,path:String(path)}),
              exceptionHandler:(message,error)=>done({ok:false,error:String(message||error||'download failed')}),
              errorHandler:(message,error)=>done({ok:false,error:String(message||error||'download failed')})
            });
            """
        )
        if not result or not result.get("ok") or not result.get("path"):
            raise ComcheckBackstopError(f"COMcheck did not export the translated clean project: {result}")
        return self._download_with_browser_cookies(str(result["path"]))

    def _calculate(self, evidence_path: Path) -> dict:
        result = self.driver.execute_async_script(
            """
            const done=arguments[arguments.length-1];
            ProjectService.calculateEnvelopeCompliance(true,{
              callback:r=>{const e=r&&r.envelopeStatus||{};done({ok:true,passes:e.passes,complianceIndex:e.complianceIndex,userAlerts:r&&r.userAlerts||[]})},
              exceptionHandler:(message,error)=>done({ok:false,error:String(message||error||'calculation failed')}),
              errorHandler:(message,error)=>done({ok:false,error:String(message||error||'calculation failed')})
            });
            """
        )
        evidence_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        if not result or not result.get("ok"):
            raise ComcheckBackstopError(f"COMcheck Backstop calculation failed: {result}")
        summary = {
            "engine": "PNNL Legacy COMcheck-Web clean project translator",
            "code": BACKSTOP_CODE,
            "passes": result.get("passes"),
            "complianceIndex": result.get("complianceIndex"),
            "responseEvidence": evidence_path.name,
            "transport": "FRESH_PROJECT_BROWSER_MODEL",
        }
        self.log("BACKSTOP_CALCULATED", **summary)
        return summary

    def run(self, cxl: Path, evidence_path: Path, report_path: Path) -> dict:
        spec = _fresh_project_spec(cxl)
        if spec["code"] != "CEZ_NYSTRETCH_NYC_90_1_11_G":
            raise ComcheckBackstopError(f"Wrong COMcheck Backstop code in current-project input: {spec['code']}")
        if not spec["walls"] or not spec["roofs"] or not spec["floors"]:
            raise ComcheckBackstopError("Current-project CXL cannot form a complete clean COMcheck envelope.")
        driver = self._start_driver()
        try:
            driver.get(urllib.parse.urljoin(self.base_url, "index.html"))
            self._wait(
                lambda d: d.execute_script("return typeof USER_PROJECT!=='undefined'&&USER_PROJECT!==null&&typeof envelopeTable!=='undefined'"),
                "COMcheck did not initialize a fresh browser project.",
            )
            self._set_clean_project_header(spec)
            building_use_key = self._set_building_use(spec["buildingUse"])
            self._build_envelope(spec, building_use_key)
            clean_bytes = self._export_clean_cxl()
            if b"ComCheckBuildingSchema" not in clean_bytes:
                raise ComcheckBackstopError("COMcheck clean project export is not CheckXML.")
            cxl.write_bytes(clean_bytes)
            self.log("CLEAN_PROJECT_EXPORTED", filename=cxl.name, bytes=len(clean_bytes), oneTimeSchemaMigration=True)
            summary = self._calculate(evidence_path)
            query = urllib.parse.urlencode({
                "envelopeCertificate": "true", "intLightingCertificate": "false",
                "extLightingCertificate": "false", "mechanicalCertificate": "false",
                "mechanicalReqDescription": "false",
            })
            page = self._download_with_browser_cookies(f"report.html?{query}").decode("utf-8", errors="replace")
            if "report/current/pdf" not in page:
                raise ComcheckBackstopError("COMcheck did not make the translated-project report available.")
            report_path.write_bytes(self._download_with_browser_cookies("report/current/pdf", expected="pdf"))
            self.log("OFFICIAL_REPORT_DOWNLOADED", filename=report_path.name, bytes=report_path.stat().st_size)
            return summary
        finally:
            driver.quit()

def run_official_backstop(cxl: Path, filing_dir: Path, project_identity: dict, log,
                          base_url: str = DEFAULT_BASE_URL) -> tuple[Path, Path, dict]:
    evidence = filing_dir / "COMcheck_BACKSTOP_ENGINE_RESPONSE.js"
    upload_evidence = filing_dir / "COMcheck_UPLOAD_RESPONSE.html"
    report = filing_dir / "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf"
    if str(os.environ.get("REVEX_ALLOW_COMCHECK_TEST_ENDPOINT", "")).lower() == "true":
        # Deterministic local contract test only. Production never uses the broken legacy upload transport.
        client = ComcheckClient(base_url, log)
        client.start()
        client.upload_project(cxl, upload_evidence)
        summary = client.calculate_backstop(evidence)
        client.download_report(report)
    else:
        summary = FreshProjectBrowserClient(base_url, log).run(cxl, evidence, report)

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
