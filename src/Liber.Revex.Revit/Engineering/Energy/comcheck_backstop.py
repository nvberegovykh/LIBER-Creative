#!/usr/bin/env python3
"""REVEX client for the official PNNL COMcheck-Web envelope Backstop.

Production starts a clean project in COMcheck's own browser application and
translates the current T/Z/EN-derived CheckXML into that project.  It never uses
the broken legacy ``uploadProject`` DWR method.  The small direct-DWR client is
kept only for the isolated local mock used by release contract tests.
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
import xml.etree.ElementTree as ET

DEFAULT_BASE_URL = "https://legacy-comcheck.energycode.pnl.gov/CheckWeb/"
OFFICIAL_HOST = "legacy-comcheck.energycode.pnl.gov"
BACKSTOP_CODE = "2020 NYCECC Appendix CA Modeling Envelope Backstop"


class ComcheckBackstopError(RuntimeError):
    pass


def _dwr_error(text: str) -> str | None:
    if "handleBatchException" not in text and "handleException" not in text:
        return None
    # DWR error objects are JavaScript, not JSON.  Scan their quoted values
    # linearly so malformed server text cannot trigger regex backtracking.
    for key in ("message", "javaClassName"):
        start = text.find(key)
        if start < 0:
            continue
        colon = text.find(":", start + len(key), start + len(key) + 80)
        if colon < 0:
            continue
        quote_pos = next((i for i in range(colon + 1, min(len(text), colon + 80))
                          if text[i] in "'\""), -1)
        if quote_pos < 0:
            continue
        quote = text[quote_pos]
        out: list[str] = []
        escaped = False
        for char in text[quote_pos + 1:quote_pos + 4097]:
            if escaped:
                out.append({"n": " ", "r": " "}.get(char, char))
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                value = "".join(out).strip()
                if value:
                    return value[:2000]
                break
            else:
                out.append(char)
    return "COMcheck-Web returned an unspecified DWR error."


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
            # COMcheck's own start_app.js makes this call before the upload UI can
            # be used. It creates/restores the server-side USER_PROJECT bound to
            # the HTTP/DWR session; omitting it makes uploadProject throw
            # gov.energycodes.check.common.exception.InvalidSessionException.
            current = self._dwr_call(
                "ProjectService", "getCurrentProject",
                "dwr/call/plaincall/ProjectService.getCurrentProject.dwr",
            )
            if "handleCallback" not in current:
                raise ComcheckBackstopError("COMcheck-Web did not initialize its current-project application session.")
            self.log("APPLICATION_SESSION_READY", service=OFFICIAL_HOST, method="ProjectService.getCurrentProject")

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
    location = _child(root, "location")
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
        # The Appendix CA enum is a New York City compliance location.  T/Z
        # identity commonly supplies ``NY`` and a borough, neither of which is
        # a value in COMcheck's compliance-location selects.
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
                // Building uses have no parent/child relationship. Calling the
                // generic addComponent() still walks the fresh table's empty
                // placeholder rows as if they were envelope parents. Use the
                // table's own server adapter directly, then perform the exact
                // successful local-list/finish half of addComponent().
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
              // COMcheck's implementation iterates the keys of this argument;
              // an Array therefore makes it look for row["0"].value.  Supply
              // the keyed object used by its own multi-field edit path.
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
              // addToServer is COMcheck's authoritative EnvelopeView.add adapter.
              // The rest of addComponent/finish only performs parent discovery,
              // dialog closure, and redraw work that is invalid in a headless
              // clean-project translation. Insert the accepted row into the
              // same local model explicitly so later children resolve correctly.
              const status=envelopeTable.addToServer(row,parent);
              if(status!==true)return {ok:false,error:'addToServer returned false'};
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
    report = filing_dir / "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf"
    if str(os.environ.get("REVEX_ALLOW_COMCHECK_TEST_ENDPOINT", "")).lower() == "true":
        # Deterministic local contract test only; production never calls the
        # legacy file-upload method that is broken on the live service.
        client = ComcheckClient(base_url, log)
        client.start()
        client.upload_project(cxl)
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
