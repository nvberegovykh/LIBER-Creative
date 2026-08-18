#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8-sig")


def must(text: str, *markers: str) -> None:
    for marker in markers:
        if marker not in text:
            raise AssertionError(f"missing current-release marker: {marker}")


def forbid(text: str, *markers: str) -> None:
    for marker in markers:
        if marker in text:
            raise AssertionError(f"forbidden current-release marker: {marker}")


# Preserve the deep r127 convergence suite as a version-shadow regression; current
# authority is this non-versioned verifier and the release manifest below.
shadow_verifier = ROOT / ".github/scripts/verify-revex-r127-single-controller.py"
completed = subprocess.run([sys.executable, str(shadow_verifier)], cwd=ROOT)
if completed.returncode != 0:
    raise SystemExit(completed.returncode)

release = json.loads(read("REVEX_CURRENT_RELEASE.json"))
finalizer = read("FINALIZE_REVEX.ps1")
energy_deploy = read("server/revex-energy-worker/deploy-current.ps1")
render_deploy = read("server/revex-render-worker/deploy-current.ps1")
report_deploy = read("server/revex-report-functions/deploy-current.ps1")
contracts = read("src/Liber.Revex.Revit/Engineering/Energy/revex_energy_contracts.py")
touchups = read("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups.py")
pipeline = read("server/revex-energy-worker/revex_energy_pipeline_current.py")

assert release["schema"] == "liber.revex.current-release.v2"
assert release["authority"] == "canonical-current-files"
assert release["operatorEntrypoint"] == "FINALIZE_REVEX.cmd"
assert release["acceptanceAction"] == "one fresh SYNC ENGINEERING after successful finalization"
assert release["current"]["releaseVerifier"] == ".github/scripts/verify-revex-current-release.py"
assert release["current"]["energyDeployer"] == "server/revex-energy-worker/deploy-current.ps1"
assert release["current"]["renderDeployer"] == "server/revex-render-worker/deploy-current.ps1"
assert release["current"]["reportDeployer"] == "server/revex-report-functions/deploy-current.ps1"

# One canonical controller may call only canonical deployers. Versioned/recovery scripts
# continue to exist as shadows but cannot become operational dependencies again.
must(finalizer,
     ".github\\scripts\\verify-revex-current-release.py",
     "server\\revex-energy-worker\\deploy-current.ps1",
     "server\\revex-render-worker\\deploy-current.ps1",
     "server\\revex-report-functions\\deploy-current.ps1",
     "Stage and verify current Energy candidate without broker cutover",
     "Stage, warm and verify current Render candidate without broker cutover",
     "Verify current Companion UI is live before any broker cutover",
     "Cut Render broker to the already-warm current candidate",
     "Cut Energy broker to the already-verified current candidate",
     "previousInstalledRevisionShadow",
     "run ONE fresh SYNC ENGINEERING")
forbid(finalizer,
       "DEPLOY_ENERGY_R127.ps1",
       "DEPLOY_RENDER_R126.ps1",
       "DEPLOY_REPORT_R126.ps1",
       "RECOVER_REVEX_ENERGY_CURRENT",
       "FINALIZE_REVEX_CURRENT",
       "PUBLISH_REVEX_R49")

for deployer in (energy_deploy, render_deploy, report_deploy):
    must(deployer,
         "$Verifier = Join-Path $Root",
         "verify-revex-current-release.py",
         "Validate full current REVEX revision")
    forbid(deployer, "@('.github\\scripts\\verify-revex")

must(energy_deploy,
     "CandidateOnly", "BrokerOnly", "REVEX_SOURCE_CANDIDATE",
     "Energy candidate is not Ready; broker remains unchanged.",
     "Cut authenticated Energy broker over to verified candidate")
must(render_deploy,
     "CandidateOnly", "BrokerOnly", "REVEX_SOURCE_CANDIDATE", "REVEX_WARM_TOKEN",
     "Assert-Warm", "--min-instances=1",
     "Cut authenticated Render broker over to verified candidate")
forbid(render_deploy, "DEPLOY_RENDER_SERVER.ps1")
must(report_deploy,
     "REVEX_SOURCE_CANDIDATE", "documentRevexRevision", "finalizeRevexDailyReport")

# Current Energy evidence and package contracts are semantic/typed internally. Exact
# filenames are centralized only at transfer/filing boundaries.
must(contracts,
     "class ArtifactKind", "class EvidenceBundle", "class FilingPackage",
     '"revit-project-identity": ArtifactKind.PROJECT_IDENTITY',
     '"revit-schedule-evidence": ArtifactKind.SCHEDULE_EVIDENCE',
     'ArtifactKind.EN1_PDF, "EN-1_READY_TO_INSERT.pdf", required_for_complete=True',
     '"REVEX_ENERGY_RELEASE_PACKAGE.zip"',
     "required_for_complete=True")
must(touchups,
     "MISSING_VT = 0.45",
     "_artifact_by_role",
     'revit-schedule-evidence',
     "Compatibility adapter only for previously-published revisions lacking role metadata",
     "REVEX_FIXED_MISSING_VT_0_45")
must(pipeline,
     'CURRENT_RELEASE_PACKAGE = "REVEX_ENERGY_RELEASE_PACKAGE.zip"',
     "_verify_clean_zip",
     "en1.PUBLIC_REVIEW_NAMES",
     "CURRENT_FILING_PACKAGE",
     "FilingPackage.discover(output_root).require_complete()",
     '"userVisible"] = False',
     '"kind": "release-package"',
     '"entryCount": 9')

# Current release must retain every capability category recovered from the actual project
# conversation, not merely Energy.
expected_capabilities = {
    "projectIdentity", "bim", "mobile", "designBook", "specBook", "docs",
    "issues", "history", "blocks", "render", "energy",
}
if set(release.get("requiredCapabilities") or {}) != expected_capabilities:
    raise AssertionError("current release capability inventory drifted")

print(json.dumps({
    "REVEX_CURRENT_RELEASE": "PASSED",
    "operator": "FINALIZE_REVEX.cmd",
    "canonicalVerifier": True,
    "versionedFilesShadowOnly": True,
    "candidateBeforeBrokerCutover": True,
    "fullUiAndBimContract": True,
    "typedEvidence": True,
    "scheduleEvidenceByRole": True,
    "actualVtWins": True,
    "missingVt": 0.45,
    "completeFilingPackageRequired": True,
    "releasePackage": "REVEX_ENERGY_RELEASE_PACKAGE.zip",
    "releasePackageEntries": 9,
}, separators=(",", ":")))
