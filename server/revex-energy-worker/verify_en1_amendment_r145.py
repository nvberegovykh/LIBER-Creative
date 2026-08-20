#!/usr/bin/env python3
"""Focused contract for the publication-only Applicant/Modeler Apply-to-EN-1 lane."""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ENERGY = ROOT / "src/Liber.Revex.Revit/Engineering/Energy"
sys.path[:0] = [str(ENERGY), str(ROOT / "server/revex-energy-worker")]

import revex_en1_amendment as amendment  # noqa: E402
import revex_user_identity_en1 as en1  # noqa: E402


def require(text: str, marker: str, label: str) -> None:
    assert marker in text, f"{label}: missing {marker!r}"


rows = [
    {"name": name, "reviewName": name, "kind": "compiled-model" if name in {"BASELINE.osm", "PROPOSED.osm"} else "review",
     "path": f"projects/p/revex/energy/parent/{index}", "bytes": 10, "sha256": "a" * 64}
    for index, name in enumerate(sorted(amendment.PUBLIC_NAMES), start=1)
]
manifest = {
    "schema": "liber.revex.energy-result.v1", "pipelineVersion": "0.8.19-r49", "status": "COMPLETE",
    "projectId": "p", "sourceEngineeringRevision": "eng_1", "resultRevision": "energy_parent",
    "revitWriteBack": False, "pdfInsertion": False, "comcheck": {"officialDoeReport": True},
}
data = {"mode": amendment.MODE, "projectId": "p", "sourceRevision": "eng_1",
        "parentResult": {"revision": "energy_parent", "manifest": manifest, "artifacts": rows}}
validated_manifest, validated_rows = amendment.validate_parent(data)
assert validated_manifest["resultRevision"] == "energy_parent" and len(validated_rows) == 9
try:
    amendment.validate_parent({**data, "parentResult": {**data["parentResult"], "manifest": {**manifest, "status": "FAILED"}}})
    raise AssertionError("FAILED parent was accepted")
except ValueError as exc:
    assert "already COMPLETE" in str(exc)

reference = ENERGY / "References/EN-1_79_WINTHROP_AMENDMENT.xlsx"
assert reference.is_file(), reference
with tempfile.TemporaryDirectory(prefix="revex-en1-amendment-test-") as temporary:
    workbook = Path(temporary) / "EN-1.xlsx"
    shutil.copy2(reference, workbook)
    before = amendment.workbook_protected_snapshot(workbook)
    identity = amendment.fill_people_identity_preserving_package(
        workbook,
        {"firstName": "Alex", "lastName": "Applicant", "licenseNumber": "NY-1"},
        {"firstName": "Morgan", "lastName": "Modeler"},
        en1,
    )
    after = amendment.workbook_protected_snapshot(workbook)
    protection = amendment.assert_only_identity_changed(before, after)
    assert protection["signatureSealChanged"] is False
    assert protection["protectedArchivePartCount"] > 0
    assert identity["applicantFields"] == ["firstName", "lastName", "licenseNumber"]
    assert identity["modelerFields"] == ["firstName", "lastName"]

module_source = (ENERGY / "revex_en1_amendment.py").read_text(encoding="utf-8")
current_source = (ENERGY / "revex_publication_resume_current.py").read_text(encoding="utf-8")
broker = (ROOT / "server/firebase-functions/index.js").read_text(encoding="utf-8")
ui = (ROOT / "docs/liber-apps/apps/revex/energy-identity-en1-r89.js").read_text(encoding="utf-8")
store = (ROOT / "docs/liber-apps/apps/revex/store.js").read_text(encoding="utf-8")
native_host = (ROOT / "src/Liber.Revex.Revit/UI/RendairWindow.cs").read_text(encoding="utf-8")

for forbidden in ("run_project_backstop(", "prepare_project_comcheck(", "EnergyPlus(", "GeometryCo("):
    assert forbidden not in module_source, f"publication-only module calls forbidden stage: {forbidden}"
require(current_source, "_en1_amendment.install(app)", "runtime installation")
for marker in (
    "EN1_IDENTITY_AMENDMENT", "parentResultRevision", "geometryCoRerun !== false",
    "energyPlusRerun !== false", "comcheckRerun !== false", "signatureSealChanged !== false",
):
    require(broker, marker, "broker boundary")
for marker in (
    "energy-en1-publication", "Apply to EN-1", "applyEn1IdentityAmendment",
    "GeometryCo, OpenStudio/EnergyPlus and COMcheck do not rerun", "signature and seal remain unchanged",
):
    require(ui, marker, "always-visible EN-1 UI")
require(store, "async applyEn1IdentityAmendment", "store amendment call")
require(store, "mode: 'EN1_IDENTITY_AMENDMENT'", "store amendment mode")
assert "[data-energy-applicant]" not in native_host, "native Energy policy removes Applicant/Modeler controls"
require(native_host, "Applicant and lead modeler stay editable in the publication-only Apply to EN-1 panel", "native amendment policy")
require(native_host, "[data-energy-signature],#energy-seal", "native signature/seal hardening")

print({
    "REVEX_EN1_AMENDMENT_R145": "PASSED",
    "publicationOnly": True,
    "protectedArchiveParts": protection["protectedArchivePartCount"],
    "simulationRerun": False,
    "comcheckRerun": False,
    "signatureSealChanged": False,
})
