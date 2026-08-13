#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, subprocess, sys, tempfile, threading, time, uuid
from pathlib import Path
from flask import Flask, jsonify, request
from google.cloud import storage
from werkzeug.exceptions import HTTPException

APP = Flask(__name__)
PIPELINE = Path(os.environ.get("REVEX_PIPELINE", "/opt/revex/energy/revex_energy_pipeline.py"))
TOKEN = os.environ.get("REVEX_ENERGY_RUNNER_TOKEN", "").strip()  # optional defense-in-depth; Cloud Run IAM is primary
MIN_INTEGRITY = 0.80
QUALITY_TARGET = 0.95
COMCHECK_CONSENT_SCHEMA = "liber.revex.comcheck-consent.v1"
COMCHECK_SERVICE = "PNNL_COMCHECK_BACKSTOP"
COMCHECK_ENDPOINT = "https://legacy-comcheck.energycode.pnl.gov/CheckWeb/"
COMCHECK_SCOPE = "GENERATED_CURRENT_PROJECT_CXL_ONLY"


def worker_log(stage: str, **detail) -> None:
    print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "stage": stage, **detail}), flush=True)


@APP.errorhandler(Exception)
def unhandled_worker_error(error):
    if isinstance(error, HTTPException):
        return error
    worker_log("WORKER_UNHANDLED", error=str(error), errorType=type(error).__name__)
    return jsonify({"error": str(error), "stage": "WORKER_UNHANDLED", "errorType": type(error).__name__}), 500


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def safe_name(value: str) -> str:
    name = Path(str(value or "artifact")).name
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name) or "artifact"


def require_comcheck_consent(data: dict, project_id: str, source_revision: str) -> dict:
    consent = dict(data.get("comcheckConsent") or {})
    valid = (
        consent.get("schema") == COMCHECK_CONSENT_SCHEMA
        and consent.get("approved") is True
        and str(consent.get("projectId") or "") == project_id
        and str(consent.get("sourceEngineeringRevision") or "") == source_revision
        and str(consent.get("approvedByUid") or "").strip()
        and str(consent.get("approvedAt") or "").strip()
        and consent.get("service") == COMCHECK_SERVICE
        and consent.get("endpoint") == COMCHECK_ENDPOINT
        and consent.get("scope") == COMCHECK_SCOPE
    )
    if not valid:
        raise ValueError("COMcheck consent does not match the authenticated project, immutable Engineering revision, official endpoint and generated-CXL-only scope")
    return consent


def firebase_url(bucket_name: str, object_path: str, token: str) -> str:
    from urllib.parse import quote
    return f"https://firebasestorage.googleapis.com/v0/b/{quote(bucket_name,safe='')}/o/{quote(object_path,safe='')}?alt=media&token={quote(token,safe='')}"


def upload_with_token(bucket, local: Path, object_path: str, content_type: str | None = None) -> dict:
    token = str(uuid.uuid4())
    blob = bucket.blob(object_path)
    blob.metadata = {"firebaseStorageDownloadTokens": token}
    blob.upload_from_filename(str(local), content_type=content_type)
    return {"path": object_path, "url": firebase_url(bucket.name, object_path, token), "bytes": local.stat().st_size, "sha256": sha256(local)}

PAGE_FACT_SCHEMA = {
    "type": "object",
    "properties": {
        "pageType": {"type": "string", "enum": ["EN", "T", "Z", "OTHER"]},
        "sheetNumber": {"type": "string"},
        "sheetName": {"type": "string"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "project": {
            "type": "object",
            "properties": {
                "title": {"type": ["string", "null"]}, "address": {"type": ["string", "null"]},
                "city": {"type": ["string", "null"]}, "state": {"type": ["string", "null"]},
                "zip": {"type": ["string", "null"]}, "energyCode": {"type": ["string", "null"]},
                "houseNumber": {"type": ["string", "null"]}, "streetName": {"type": ["string", "null"]},
                "borough": {"type": ["string", "null"]}, "block": {"type": ["string", "null"]},
                "lot": {"type": ["string", "null"]}, "bin": {"type": ["string", "null"]},
                "communityBoard": {"type": ["string", "null"]}, "jobType": {"type": ["string", "null"]},
                "architecturalJobNumber": {"type": ["string", "null"]},
                "mechanicalJobNumber": {"type": ["string", "null"]},
                "plumbingJobNumber": {"type": ["string", "null"]}
            }, "required": ["title", "address", "city", "state", "zip", "energyCode", "houseNumber", "streetName", "borough", "block", "lot", "bin", "communityBoard", "jobType", "architecturalJobNumber", "mechanicalJobNumber", "plumbingJobNumber"]
        },
        "bulk": {
            "type": "object",
            "properties": {
                "stories": {"type": ["integer", "null"]}, "buildingHeightFt": {"type": ["number", "null"]},
                "grossFloorAreaFt2": {"type": ["number", "null"]}, "conditionedFloorAreaFt2": {"type": ["number", "null"]}
            }, "required": ["stories", "buildingHeightFt", "grossFloorAreaFt2", "conditionedFloorAreaFt2"]
        },
        "envelope": {
            "type": "array", "items": {"type": "object", "properties": {
                "kind": {"type": "string", "enum": ["wall", "roof", "floor", "window", "door"]},
                "assemblyType": {"type": ["string", "null"]}, "parentAssemblyType": {"type": ["string", "null"]},
                "description": {"type": ["string", "null"]}, "orientation": {"type": ["string", "null"]},
                "grossAreaFt2": {"type": ["number", "null"]}, "uFactor": {"type": ["number", "null"]},
                "shgc": {"type": ["number", "null"]}, "cavityR": {"type": ["number", "null"]},
                "continuousR": {"type": ["number", "null"]}, "product": {"type": ["string", "null"]},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1}, "evidence": {"type": "string"}
            }, "required": ["kind", "assemblyType", "parentAssemblyType", "description", "orientation", "grossAreaFt2", "uFactor", "shgc", "cavityR", "continuousR", "product", "confidence", "evidence"]}
        },
        "lighting": {
            "type": "object", "properties": {
                "wholeBuildingType": {"type": ["string", "null"]}, "floorAreaFt2": {"type": ["number", "null"]},
                "lpdWPerFt2": {"type": ["number", "null"]},
                "fixtures": {"type": "array", "items": {"type": "object", "properties": {
                    "description": {"type": ["string", "null"]}, "wattage": {"type": ["number", "null"]},
                    "quantity": {"type": ["number", "null"]}, "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence": {"type": "string"}
                }, "required": ["description", "wattage", "quantity", "confidence", "evidence"]}},
                "exteriorUses": {"type": "array", "items": {"type": "object", "properties": {
                    "description": {"type": ["string", "null"]}, "useType": {"type": ["string", "null"]},
                    "quantity": {"type": ["number", "null"]}, "quantityUnits": {"type": ["string", "null"]},
                    "fixtureWattage": {"type": ["number", "null"]}, "fixtureQuantity": {"type": ["number", "null"]},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1}, "evidence": {"type": "string"}
                }, "required": ["description", "useType", "quantity", "quantityUnits", "fixtureWattage", "fixtureQuantity", "confidence", "evidence"]}}
            }, "required": ["wholeBuildingType", "floorAreaFt2", "lpdWPerFt2", "fixtures", "exteriorUses"]
        },
        "evidence": {"type": "array", "items": {"type": "string"}}
    },
    "required": ["pageType", "sheetNumber", "sheetName", "confidence", "project", "bulk", "envelope", "lighting", "evidence"]
}


def _identity_value(fields: dict, aliases: tuple[str, ...], *, reject: tuple[str, ...] = ()) -> str | None:
    candidates = []
    for key, raw in fields.items():
        value = str(raw or "").strip()
        normalized = "".join(ch.lower() for ch in str(key) if ch.isalnum())
        if not value or any(token in normalized for token in reject):
            continue
        match = max((len(alias) for alias in aliases if alias in normalized), default=0)
        if not match:
            continue
        authority = 3 if normalized.startswith("project") else 2 if "titleblock" in normalized else 1
        candidates.append((authority, match, -len(normalized), value))
    return sorted(candidates, reverse=True)[0][3] if candidates else None


def load_structured_identity(manifest: dict, local_by_name: dict[str, Path]) -> dict:
    row = next((item for item in list(manifest.get("artifacts") or [])
                if str(item.get("role") or "").lower() == "revit-project-identity"), None)
    if row is None:
        raise ValueError("Engineering revision is missing active-document project identity evidence")
    path = local_by_name.get(safe_name(row.get("name") or "").lower())
    if path is None or not path.is_file():
        raise ValueError("active-document project identity evidence artifact is missing")
    identity = json.loads(path.read_text(encoding="utf-8"))
    binding = dict(manifest.get("projectBinding") or {})
    if identity.get("schema") != "liber.revex.revit-project-identity.v1":
        raise ValueError("invalid active-document project identity schema")
    if identity.get("authority") != "active-revit-document-t-z-title-evidence":
        raise ValueError("project identity authority is not the active Revit document")
    digest = str(identity.get("digest") or identity.get("Digest") or "").strip().lower()
    expected = str(binding.get("identityEvidenceDigest") or "").strip().lower()
    if not digest or digest != expected:
        raise ValueError("project identity evidence digest does not match the bound active Revit document")
    fields = dict(identity.get("fields") or identity.get("Fields") or {})
    normalized = {
        "title": _identity_value(fields, ("projectname", "buildingname", "projecttitle"), reject=("uniqu",)),
        "address": _identity_value(fields, ("projectaddress", "siteaddress", "address"), reject=("business", "email")),
        "houseNumber": _identity_value(fields, ("housenumber", "houseno", "streetnumber")),
        "streetName": _identity_value(fields, ("streetname",)),
        "borough": _identity_value(fields, ("borough",)),
        "city": _identity_value(fields, ("projectcity", "city"), reject=("business",)),
        "state": _identity_value(fields, ("projectstate", "stateprovince", "state"), reject=("status",)),
        "zip": _identity_value(fields, ("zipcode", "postalcode", "projectzip", "zip")),
        "block": _identity_value(fields, ("taxblock", "block")),
        "lot": _identity_value(fields, ("taxlot", "lot")),
        "bin": _identity_value(fields, ("buildingidentificationnumber", "binnumber", "bin")),
        "communityBoard": _identity_value(fields, ("communityboard", "cbno", "cbnumber")),
        "jobType": _identity_value(fields, ("jobtype", "filingtype")),
        "architecturalJobNumber": _identity_value(fields, ("architecturaljobnumber", "architecturaljobno", "dobjobnumber")),
        "mechanicalJobNumber": _identity_value(fields, ("mechanicaljobnumber", "mechanicaljobno")),
        "plumbingJobNumber": _identity_value(fields, ("plumbingjobnumber", "plumbingjobno")),
    }
    normalized["title"] = normalized["title"] or str(identity.get("displayName") or identity.get("DisplayName") or "").strip() or None
    normalized["documentModel"] = str(identity.get("model") or "").strip() or None
    normalized["evidenceDigest"] = digest
    normalized["evidenceSheets"] = list(identity.get("sheets") or identity.get("Sheets") or [])
    return normalized


def scan_revit_page_facts(manifest: dict, local_by_name: dict[str, Path], source_dir: Path, project_id: str) -> Path:
    """AI is deliberately restricted to immutable Revit T/Z/EN sheet PDFs.

    It cannot create, repair, classify, or override Revit/gbXML geometry. The output is
    structured page facts with visible-sheet evidence and confidence only; deterministic
    downstream code decides whether a filing input is complete.
    """
    output = source_dir / "revit-page-facts.json"
    structured_identity = load_structured_identity(manifest, local_by_name)
    declared = list(manifest.get("artifacts") or [])
    index_row = next((row for row in declared if str(row.get("role") or "").lower() == "revit-page-index"), None)
    pdf_rows = [row for row in declared if str(row.get("role") or "").lower() == "revit-page-pdf"]
    if not index_row or not pdf_rows:
        output.write_text(json.dumps({
            "schema": "liber.revex.revit-page-facts.v1", "scanVersion": "20260813r49",
            "status": "NO_RELEVANT_PAGES", "aiScope": "REVIT_T_Z_EN_PAGE_SCAN_ONLY", "pages": [],
            "structuredIdentity": structured_identity,
            "message": "No immutable T/Z/EN Revit page PDFs were included; COMcheck project input will remain incomplete."
        }, indent=2), encoding="utf-8")
        return output

    index_path = local_by_name.get(safe_name(index_row.get("name") or "").lower())
    index = {}
    if index_path and index_path.is_file():
        try: index = json.loads(index_path.read_text(encoding="utf-8"))
        except Exception: index = {}
    indexed = {str(row.get("file") or "").lower(): row for row in list(index.get("pages") or [])}

    project = os.environ.get("REVEX_VERTEX_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT") or project_id
    location = os.environ.get("REVEX_VERTEX_LOCATION", "global")
    model = os.environ.get("REVEX_PAGE_SCAN_MODEL", "gemini-2.5-flash")
    pages = []
    errors = []
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(vertexai=True, project=project, location=location,
                              http_options=types.HttpOptions(api_version="v1", timeout=120000))
    except Exception as exc:
        output.write_text(json.dumps({
            "schema": "liber.revex.revit-page-facts.v1", "scanVersion": "20260813r49",
            "status": "AI_UNAVAILABLE", "aiScope": "REVIT_T_Z_EN_PAGE_SCAN_ONLY", "pages": [],
            "structuredIdentity": structured_identity, "error": str(exc)
        }, indent=2), encoding="utf-8")
        return output

    for row in pdf_rows:
        name = safe_name(row.get("name") or "")
        pdf = local_by_name.get(name.lower())
        if pdf is None or not pdf.is_file():
            errors.append(f"missing page artifact: {name}")
            continue
        meta = indexed.get(name.lower(), {})
        discipline = str(meta.get("discipline") or ("EN" if "_EN_" in name.upper() else "Z" if "_Z_" in name.upper() else "T" if "_T_" in name.upper() else "OTHER"))
        prompt = (
            f"Read this immutable Revit {discipline} sheet only. Extract facts that are visibly stated on the page. "
            "For EN sheets extract energy/compliance facts such as envelope assemblies and areas, U/SHGC/R values, lighting, and the applicable energy-code designation. Set all project identity fields to null on EN pages. "
            "For T and Z sheets extract the current project identity exactly as printed in the title block or schedule: project title, full address, house number, street name, borough, city, state, ZIP, block, lot, BIN, community board, job type, and architectural/mechanical/plumbing job numbers; also extract building bulk such as stories, building height, and gross/conditioned floor area. "
            "Never copy identity from an EN sheet into T/Z identity fields and never use a reference/template project identity. "
            "Do not infer hidden geometry, do not calculate missing values, do not use outside knowledge, and do not reinterpret drawing graphics as authoritative geometry. "
            "If a value is not visibly supported, return null or omit the row. Evidence strings must be short visible labels/text from the sheet, not invented explanations."
        )
        parsed = None
        last_error = None
        for attempt in range(1, 4):
            worker_log("PAGE_SCAN_STARTED", file=name, discipline=discipline, attempt=attempt, hardLimitSeconds=120)
            started = time.monotonic()
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=[types.Part.from_bytes(data=pdf.read_bytes(), mime_type="application/pdf"), prompt],
                    config={"temperature": 0, "response_mime_type": "application/json", "response_json_schema": PAGE_FACT_SCHEMA}
                )
                parsed = response.parsed if isinstance(getattr(response, "parsed", None), dict) else json.loads(response.text or "{}")
                worker_log("PAGE_SCAN_COMPLETED", file=name, discipline=discipline, attempt=attempt,
                           elapsedSeconds=round(time.monotonic() - started, 1))
                break
            except Exception as exc:
                last_error = exc
                worker_log("PAGE_SCAN_RETRY" if attempt < 3 else "PAGE_SCAN_FAILED", file=name,
                           discipline=discipline, attempt=attempt,
                           elapsedSeconds=round(time.monotonic() - started, 1), error=str(exc)[:1000])
                if attempt < 3:
                    time.sleep(attempt * 2)
        if parsed is None:
            errors.append(f"{name}: {last_error}")
            continue
        parsed["sheetNumber"] = str(meta.get("sheetNumber") or parsed.get("sheetNumber") or "")
        parsed["sheetName"] = str(meta.get("sheetName") or parsed.get("sheetName") or "")
        parsed["pageType"] = discipline if discipline in ("EN", "T", "Z") else str(parsed.get("pageType") or "OTHER")
        parsed["sourceFile"] = name
        parsed["sourceSha256"] = sha256(pdf)
        pages.append(parsed)
    try: client.close()
    except Exception: pass

    status = "COMPLETE" if pages and not errors else "PARTIAL" if pages else "FAILED"
    output.write_text(json.dumps({
        "schema": "liber.revex.revit-page-facts.v1", "scanVersion": "20260813r49", "status": status,
        "aiScope": "REVIT_T_Z_EN_PAGE_SCAN_ONLY", "geometryAuthority": False, "model": model,
        "project": project, "location": location, "structuredIdentity": structured_identity,
        "pages": pages, "errors": errors
    }, indent=2), encoding="utf-8")
    return output


def require_integrity(manifest: dict, project_id: str, source_revision: str) -> None:
    if manifest.get("schema") != "liber.revex.engineering-sync.v1" or manifest.get("architecture") != "REVIT_EVIDENCE_GRAPH_V1":
        raise ValueError("invalid Engineering Sync architecture")
    if str(manifest.get("projectId") or "") != project_id or str(manifest.get("revision") or "") != source_revision:
        raise ValueError("Engineering Sync project/revision identity mismatch")
    binding = dict(manifest.get("projectBinding") or {})
    if (binding.get("version") != "active-revit-evidence-v1"
            or str(binding.get("source") or "") not in ("explicit-user-selection", "stored-active-document")
            or not str(binding.get("documentUniqueId") or "").strip()
            or not str(binding.get("documentFingerprint") or "").strip()
            or len(str(binding.get("identityEvidenceDigest") or "").strip()) != 64):
        raise ValueError("Engineering Sync is not bound to verified active-Revit-document evidence")
    publication = manifest.get("publicationIntegrity") or {}
    ratios = publication.get("ratios") or {}
    if float(publication.get("threshold") or 0) < MIN_INTEGRITY or not ratios or any(float(v or 0) < MIN_INTEGRITY for v in ratios.values()):
        raise ValueError("Engineering Sync is below the >=80% hard-stop publication gate")
    declared_quality_target = float(publication.get("qualityTarget") or publication.get("threshold") or 0)
    if declared_quality_target < QUALITY_TARGET:
        raise ValueError("Engineering Sync manifest is missing the >=80% hard-stop / >=95% quality-target integrity contract")
    if manifest.get("writeBackToRevitAfterExport") is not False or manifest.get("pdfInsertion") is not False:
        raise ValueError("Engineering Sync attempts to cross the Revit authority boundary")


def validate_artifact_contract(manifest: dict, local_by_name: dict[str, Path]) -> tuple[Path, Path, Path | None, Path | None]:
    declared = list(manifest.get("artifacts") or [])
    declared_names = set()
    gbxml = weather = report = summary = None
    for row in declared:
        name = safe_name(row.get("name") or "")
        if not name or name.lower() in declared_names:
            raise ValueError(f"duplicate or invalid Engineering artifact name: {name}")
        declared_names.add(name.lower())
        local = local_by_name.get(name.lower())
        if local is None or not local.is_file():
            raise ValueError(f"declared Engineering artifact is missing: {name}")
        expected_bytes = int(row.get("bytes") or 0)
        expected_hash = str(row.get("sha256") or "").lower()
        if expected_bytes and local.stat().st_size != expected_bytes:
            raise ValueError(f"Engineering artifact byte count mismatch: {name}")
        if expected_hash and sha256(local).lower() != expected_hash:
            raise ValueError(f"Engineering artifact SHA-256 mismatch: {name}")
        role = str(row.get("role") or "").lower()
        if role == "gbxml": gbxml = local
        elif role == "weather-epw": weather = local
        elif role == "gbxml-report": report = local
        elif role == "gbxml-summary": summary = local

    extras = set(local_by_name) - declared_names - {"engineering-sync.json"}
    if extras:
        raise ValueError("immutable Engineering revision contains undeclared artifact(s): " + ", ".join(sorted(extras)))
    if gbxml is None or weather is None:
        raise ValueError("Engineering manifest must declare one gbXML and one weather-epw artifact")

    first = weather.open("r", encoding="utf-8", errors="ignore").readline().strip()
    parts = [part.strip() for part in first.split(",")]
    if len(parts) < 10 or parts[0].upper() != "LOCATION" or not parts[1]:
        raise ValueError("weather artifact has no valid EPW LOCATION header")
    try:
        lat, lon, tz, elev = float(parts[6]), float(parts[7]), float(parts[8]), float(parts[9])
    except Exception as exc:
        raise ValueError("weather EPW LOCATION coordinates/time-zone/elevation are invalid") from exc
    if not (-90 <= lat <= 90 and -180 <= lon <= 180 and -14 <= tz <= 14):
        raise ValueError("weather EPW LOCATION metadata is out of range")
    weather_meta = manifest.get("weather") or {}
    if str(weather_meta.get("sha256") or "").lower() != sha256(weather).lower():
        raise ValueError("weather metadata/hash does not match the immutable EPW artifact")
    for key, actual in (("city", parts[1]), ("stateProvince", parts[2]), ("country", parts[3]), ("dataSource", parts[4]), ("wmo", parts[5])):
        declared = str(weather_meta.get(key) or "").strip()
        if declared and declared.casefold() != actual.casefold():
            raise ValueError(f"weather metadata field {key} does not match the immutable EPW header")
    return gbxml, weather, report, summary


@APP.get("/healthz")
def healthz():
    return jsonify({
        "ok": True, "service": "REVEX Energy Worker", "version": "0.8.19-r49",
        "execution": "managed-server", "openStudio": "3.10 pinned in image",
        "comcheck": "official PNNL Backstop engine",
        "revitWriteBack": False, "pdfInsertion": False
    })


@APP.post("/run")
def run_energy():
    if TOKEN and request.headers.get("X-REVEX-Runner-Token", "") != TOKEN:
        return jsonify({"error": "invalid runner token"}), 401
    data = request.get_json(silent=True) or {}
    if data.get("schema") != "liber.revex.energy-server-request.v1":
        return jsonify({"error": "invalid request schema"}), 400
    project_id = str(data.get("projectId") or "").strip()
    source_revision = str(data.get("sourceRevision") or "").strip()
    bucket_name = str(data.get("bucket") or "").strip()
    output_prefix = str(data.get("outputPrefix") or "").strip().strip("/")
    artifacts = list(data.get("artifacts") or [])
    if not project_id or not source_revision or not bucket_name or not output_prefix:
        return jsonify({"error": "projectId, sourceRevision, bucket, and outputPrefix are required"}), 400
    try:
        comcheck_consent = require_comcheck_consent(data, project_id, source_revision)
    except ValueError as exc:
        return jsonify({"error": f"official COMcheck transmission is not authorized: {exc}", "stage": "COMCHECK_CONSENT"}), 412
    if not PIPELINE.is_file():
        return jsonify({"error": f"REVEX Energy pipeline missing: {PIPELINE}"}), 500
    worker_log("REQUEST_ACCEPTED", projectId=project_id, sourceRevision=source_revision, artifacts=len(artifacts))

    expected_prefix = f"projects/{project_id}/revex/engineering/revisions/{source_revision}/"
    for row in artifacts:
        object_path = str(row.get("path") or "").strip()
        if not object_path.startswith(expected_prefix):
            return jsonify({"error": f"Engineering artifact escaped immutable revision prefix: {object_path}"}), 400

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    with tempfile.TemporaryDirectory(prefix="revex-energy-") as tmp:
        work = Path(tmp)
        source_dir = work / "source"
        run_dir = work / "run"
        source_dir.mkdir()
        run_dir.mkdir()
        local_by_name: dict[str, Path] = {}
        for row in artifacts:
            object_path = str(row.get("path") or "").strip()
            name = safe_name(row.get("name") or object_path)
            if not object_path:
                continue
            key = name.lower()
            if key in local_by_name:
                return jsonify({"error": f"duplicate artifact name: {name}"}), 400
            target = source_dir / name
            bucket.blob(object_path).download_to_filename(str(target))
            expected_bytes = int(row.get("bytes") or 0)
            expected_hash = str(row.get("sha256") or "").strip().lower()
            if expected_bytes <= 0 or len(expected_hash) != 64 or any(ch not in "0123456789abcdef" for ch in expected_hash):
                return jsonify({"error": f"Engineering transfer metadata has no exact byte/SHA-256 integrity: {name}"}), 400
            if target.stat().st_size != expected_bytes or sha256(target).lower() != expected_hash:
                return jsonify({"error": f"Downloaded Engineering artifact failed transfer integrity: {name}"}), 400
            local_by_name[key] = target
        worker_log("ARTIFACTS_DOWNLOADED", projectId=project_id, sourceRevision=source_revision, artifacts=len(local_by_name))

        manifest_path = local_by_name.get("engineering-sync.json")
        if not manifest_path:
            return jsonify({"error": "immutable Energy revision is missing engineering-sync.json"}), 400
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            require_integrity(manifest, project_id, source_revision)
            gbxml, weather, report, summary = validate_artifact_contract(manifest, local_by_name)
            page_facts = scan_revit_page_facts(manifest, local_by_name, source_dir, project_id)
            worker_log("ENGINEERING_VERIFIED", projectId=project_id, sourceRevision=source_revision, pageFacts=str(page_facts.name))
        except Exception as exc:
            return jsonify({"error": f"immutable Engineering revision rejected: {exc}"}), 400

        req = {
            "schema": "liber.revex.energy-request.v1",
            "pipelineVersion": "0.8.19-r49",
            "correlationId": f"energy-server-{source_revision}",
            "parentCorrelationId": str(manifest.get("correlationId") or ""),
            "initiator": "REVEX managed Energy server after >=80% Engineering Sync hard-stop gate",
            "projectId": project_id,
            "projectName": data.get("projectName") or manifest.get("sourceModel", {}).get("title") or "REVEX Energy",
            "revision": source_revision,
            "engineeringManifestPath": str(manifest_path),
            "gbxmlPath": str(gbxml),
            "gbxmlReportPath": str(report) if report else "",
            "gbxmlSummaryPath": str(summary) if summary else "",
            "weatherFile": str(weather),
            "pageFactsPath": str(page_facts),
            "sourceArtifacts": [str(path) for path in local_by_name.values()] + [str(page_facts)],
            "outputFolder": str(run_dir),
            "openStudioCli": "",
            "standardVersion": "NYCECC 2020",
            "filingPath": "NYCECC_APPENDIX_CA_PRM",
            "comcheckContext": data.get("projectSource") or {},
            "externalProcessingConsent": comcheck_consent,
            "execution": {
                "mode": "server", "openStudio": "managed-container-pinned-3.10",
                "weather": "immutable-energy-sync-artifact", "officePdf": "managed-libreoffice",
                "comcheck": "official-pnnl-backstop-from-current-project-cxl"
            },
            "integrityQuality": {
                "hardStop": MIN_INTEGRITY,
                "qualityTarget": QUALITY_TARGET,
                "qualityTargetMet": bool((manifest.get("publicationIntegrity") or {}).get("qualityTargetMet")),
                "lowestRatio": float((manifest.get("publicationIntegrity") or {}).get("lowestRatio") or min(float(v or 0) for v in ((manifest.get("publicationIntegrity") or {}).get("ratios") or {}).values())),
                "belowQualityTarget": (manifest.get("publicationIntegrity") or {}).get("belowQualityTarget") or {},
            },
            "identityPolicy": "PROJECT_IDENTITY_FROM_ACTIVE_REVIT_EVIDENCE_AND_T_Z_PAGES; APPLICANT_AND_MODELER_BLANK",
            "applicant": {}
        }
        req_path = work / "energy-request.json"
        req_path.write_text(json.dumps(req, indent=2), encoding="utf-8")
        timeout_seconds = int(os.environ.get("REVEX_ENERGY_TIMEOUT_SECONDS", "3500"))
        server_log = run_dir / "REVEX-SERVER-WORKER.log"
        worker_log("PIPELINE_STARTED", projectId=project_id, sourceRevision=source_revision, timeoutSeconds=timeout_seconds)
        with server_log.open("w", encoding="utf-8") as log_stream:
            proc = subprocess.Popen(
                [sys.executable, str(PIPELINE), "--request", str(req_path)], cwd=str(PIPELINE.parent),
                env=os.environ.copy(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                encoding="utf-8", errors="replace", bufsize=1
            )

            def pump_output() -> None:
                assert proc.stdout is not None
                for line in proc.stdout:
                    log_stream.write(line)
                    log_stream.flush()
                    print(line.rstrip(), flush=True)

            pump = threading.Thread(target=pump_output, name="revex-pipeline-log", daemon=True)
            pump.start()
            started_at = time.monotonic()
            next_heartbeat = started_at + 30
            timed_out = False
            while proc.poll() is None:
                now = time.monotonic()
                if now - started_at > timeout_seconds:
                    timed_out = True
                    proc.kill()
                    break
                if now >= next_heartbeat:
                    worker_log("PIPELINE_HEARTBEAT", projectId=project_id, sourceRevision=source_revision,
                               elapsedSeconds=round(now - started_at), pid=proc.pid)
                    next_heartbeat = now + 30
                time.sleep(1)
            proc.wait()
            pump.join(timeout=10)
        worker_log("PIPELINE_FINISHED", projectId=project_id, sourceRevision=source_revision,
                   exitCode=proc.returncode, timedOut=timed_out)
        if timed_out:
            return jsonify({"error": f"Energy pipeline exceeded its {timeout_seconds}s hard limit", "stage": "PIPELINE_TIMEOUT"}), 504
        result_path = run_dir / "energy-result.json"
        if not result_path.is_file():
            return jsonify({"error": f"pipeline exited {proc.returncode} without energy-result.json"}), 500
        result_manifest = json.loads(result_path.read_text(encoding="utf-8"))
        if result_manifest.get("schema") != "liber.revex.energy-result.v1":
            return jsonify({"error": "pipeline returned an incompatible Energy result schema"}), 500
        if str(result_manifest.get("pipelineVersion") or "") != "0.8.19-r49":
            return jsonify({"error": "pipeline returned an unpinned Energy implementation"}), 500
        if str(result_manifest.get("projectId") or "") != project_id or str(result_manifest.get("sourceEngineeringRevision") or "") != source_revision:
            return jsonify({"error": "pipeline returned mismatched project/revision"}), 500
        if result_manifest.get("revitWriteBack") is not False or result_manifest.get("pdfInsertion") is not False:
            return jsonify({"error": "pipeline violated REVEX authority boundary"}), 500
        if str(result_manifest.get("status") or "").upper() == "COMPLETE":
            declared_rows = list(result_manifest.get("artifacts") or [])
            declared_names = {str(row.get("name") or "") for row in declared_rows}
            required_names = {
                "BASELINE_UPDATED_GEOMETRY.osm",
                "PROPOSED_UPDATED_GEOMETRY.osm",
                "EN-1_READY_TO_INSERT.pdf",
                "COMcheck_PROJECT_INPUT_READY.cxl",
                "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf",
                "COMcheck_BACKSTOP_RESULT.json",
            }
            missing_outputs = sorted(required_names - declared_names)
            compiled = [row for row in declared_rows if row.get("kind") == "compiled-model" and str(row.get("name") or "").lower().endswith(".osm")]
            if missing_outputs or len(compiled) != 2 or result_manifest.get("comcheck", {}).get("officialDoeReport") is not True:
                return jsonify({
                    "error": "pipeline reported COMPLETE without the strict r49 output contract",
                    "missing": missing_outputs,
                    "compiledOsmCount": len(compiled),
                }), 500

        manifest_object = f"{output_prefix}/energy-result.json"
        manifest_upload = upload_with_token(bucket, result_path, manifest_object, "application/json")
        uploaded = []
        run_root = run_dir.resolve()
        for row in list(result_manifest.get("artifacts") or []):
            rel = str(row.get("path") or "").replace("\\", "/").lstrip("/")
            local = (run_dir / rel).resolve()
            try:
                local.relative_to(run_root)
            except ValueError:
                return jsonify({"error": f"pipeline artifact escaped the Energy result folder: {rel}"}), 500
            if not local.is_file():
                return jsonify({"error": f"pipeline declared a missing Energy artifact: {rel}"}), 500
            if int(row.get("bytes") or 0) != local.stat().st_size or str(row.get("sha256") or "").lower() != sha256(local).lower():
                return jsonify({"error": f"pipeline Energy artifact integrity mismatch: {rel}"}), 500
            meta = upload_with_token(bucket, local, f"{output_prefix}/artifacts/{rel}")
            uploaded.append({**row, **meta, "relativePath": rel, "name": row.get("name") or local.name, "kind": row.get("kind") or "energy-output"})
        if server_log.is_file() and not any(a.get("name") == server_log.name for a in uploaded):
            meta = upload_with_token(bucket, server_log, f"{output_prefix}/artifacts/{server_log.name}", "text/plain")
            uploaded.append({**meta, "relativePath": server_log.name, "name": server_log.name, "kind": "diagnostic"})
        return jsonify({
            "schema": "liber.revex.energy-server-response.v1",
            "projectId": project_id, "sourceRevision": source_revision,
            "resultRevision": result_manifest.get("resultRevision"), "status": result_manifest.get("status"),
            "error": result_manifest.get("error"), "manifest": result_manifest,
            "manifestPath": manifest_upload["path"], "manifestUrl": manifest_upload["url"], "artifacts": uploaded
        }), 200


if __name__ == "__main__":
    APP.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
