#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GUARD = HERE / "revex_energy_pipeline_guard.py"
SPEC = importlib.util.spec_from_file_location("revex_energy_pipeline_guard_r55", GUARD)
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="revex-r55-failure-evidence-") as tmp:
        root = Path(tmp)
        write(root / "REVEX-ENERGY-PIPELINE.jsonl", '{"stage":"GEOMETRYCO_4_3_4","status":"FAILED"}\n')
        write(root / "02_GEOMETRYCO.log", "ERROR: deterministic GeometryCo test failure\n")
        write(root / "02_COMPILED_MODELS" / "FAILED_COMPILE_20260816_010000" / "FAILURE_SUMMARY.txt", "Compilation stopped safely.\n")
        write(root / "02_COMPILED_MODELS" / "FAILED_COMPILE_20260816_010000" / "FAILURE_REPORT.json", json.dumps({"success": False}))
        write(root / "02_COMPILED_MODELS" / "FAILED_COMPILE_20260816_010000" / "NATIVE_CHECK_BASELINE.log", "native detail\n")
        write(root / "REVEX-SERVER-WORKER.log", "must be uploaded only by parent worker\n")
        write(root / "00_SOURCE_EVIDENCE" / "private-source.xml", "must not be exposed as failure diagnostic\n")

        artifacts = module.collect_failure_artifacts(root)
        paths = {row["path"] for row in artifacts}
        assert "02_GEOMETRYCO.log" in paths
        assert "REVEX-ENERGY-PIPELINE.jsonl" in paths
        assert any(path.endswith("FAILURE_SUMMARY.txt") for path in paths)
        assert any(path.endswith("FAILURE_REPORT.json") for path in paths)
        assert any(path.endswith("NATIVE_CHECK_BASELINE.log") for path in paths)
        assert "REVEX-SERVER-WORKER.log" not in paths
        assert not any("00_SOURCE_EVIDENCE" in path for path in paths)
        for row in artifacts:
            assert row["kind"] == "diagnostic"
            assert row["bytes"] > 0
            assert len(row["sha256"]) == 64

        failed = {
            "schema": module.SCHEMA,
            "pipelineVersion": module.PIPELINE_VERSION,
            "status": "FAILED",
            "artifacts": [],
        }
        promoted = module.promote_failure_evidence(failed, root)
        assert promoted["status"] == "FAILED"
        assert promoted["failureEvidence"]["preserved"] is True
        assert promoted["failureEvidence"]["artifactCount"] >= 5
        assert any(row["name"] == "02_GEOMETRYCO.log" for row in promoted["artifacts"])

        complete = {
            "schema": module.SCHEMA,
            "pipelineVersion": module.PIPELINE_VERSION,
            "status": "COMPLETE",
            "artifacts": [{"name": "keep", "path": "keep"}],
        }
        untouched = module.promote_failure_evidence(complete, root)
        assert untouched == complete
        assert "failureEvidence" not in untouched

        fallback = module.fallback_result(
            {"projectId": "revex_test", "revision": "eng_test", "projectName": "TEST"}, root, 2
        )
        assert fallback["status"] == "FAILED"
        assert fallback["revitWriteBack"] is False
        assert fallback["pdfInsertion"] is False
        assert fallback["sourceEngineeringRevision"] == "eng_test"
        assert any(row["name"] == "02_GEOMETRYCO.log" for row in fallback["artifacts"])

    print(json.dumps({
        "schema": "liber.revex.energy-failure-evidence-r55-qa.v1",
        "status": "PASSED",
        "geometryCoLogPreserved": True,
        "failedCompileEvidencePreserved": True,
        "openServerLogExcludedUntilStable": True,
        "sourceEvidenceNotLeaked": True,
        "completeResultUnchanged": True,
        "failedResultNeverPromoted": True,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
