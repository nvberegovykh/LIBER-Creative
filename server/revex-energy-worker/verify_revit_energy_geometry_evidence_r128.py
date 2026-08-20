#!/usr/bin/env python3
"""Focused immutable Revit energy-geometry binding regression."""
from __future__ import annotations

import copy
import hashlib
import json
import tempfile
from pathlib import Path

from revex_geometry_evidence import validate_geometry_evidence


ROOT = Path(__file__).resolve().parents[2]


def require(source: str, marker: str, label: str) -> None:
    assert marker in source, f"{label}: missing {marker!r}"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")


def processed_row(original_id: int, room_id: int) -> dict:
    return {
        "id": f"liber-room-derived-{room_id}",
        "sourceRoomKey": f"host_room:-1:{room_id}:room-{room_id}",
        "sourceRoomId": room_id,
        "invalidOriginalSpaceId": original_id,
        "provenance": "ROOM_DERIVED_ISOLATED_FROM_PREEXISTING_INVALID_SPACE",
        "coordinateSystem": "REVIT_HOST_INTERNAL",
        "geometryMode": "ROOM_BOUNDARY_STORY_BOUNDED_2_5D",
        "baseZFt": 0.0,
        "topZFt": 10.0,
        "heightFt": 10.0,
        "areaFt2": 100.0,
        "volumeFt3": 1000.0,
        "outerLoopFt": [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
    }


def fixture(root: Path) -> tuple[dict, dict[str, Path], Path, dict]:
    gbxml = root / "revit-energy.xml"
    gbxml.write_text("<gbXML><Campus/></gbXML>", encoding="utf-8")
    weather = root / "weather.epw"
    weather.write_text("LOCATION,New York,NY,USA,TMY3,725030,40.77,-73.87,-5,3\n", encoding="utf-8")
    geometry_path = root / "revit-energy-geometry.json"
    geometry = {
        "schema": "liber.revex.revit-energy-geometry.v1",
        "authority": "active-revit-document-processed-energy-geometry",
        "sourceDocument": {
            "title": "250 Midwood Street",
            "documentFingerprint": "revitdoc_0123456789abcdef01234567",
            "phaseId": 42,
            "phaseName": "New Construction",
            "coordinateSystem": "REVIT_HOST_INTERNAL",
            "linearUnit": "foot",
            "areaUnit": "square-foot",
        },
        "levels": [{"id": 1, "name": "1ST FLOOR", "elevationFt": 0}],
        "rooms": [{"id": 10, "name": "Living"}],
        "spaces": [{
            "id": 20,
            "name": "Legacy invalid Space",
            "provenance": "PREEXISTING_UNTOUCHED",
            "exportable": False,
        }],
        "processedSpaces": [processed_row(20, 10)],
        "physical": {"surfaces": [{"key": "wall:1"}], "openings": []},
        "analytical": {"surfaces": [], "openings": []},
        "gbxml": {"name": gbxml.name, "sha256": sha256(gbxml)},
    }
    write_json(geometry_path, geometry)

    def artifact(path: Path, role: str) -> dict:
        return {"name": path.name, "role": role, "bytes": path.stat().st_size, "sha256": sha256(path)}

    manifest = {
        "schema": "liber.revex.engineering-sync.v1",
        "projectBinding": {"documentFingerprint": geometry["sourceDocument"]["documentFingerprint"]},
        "weather": {
            "sha256": sha256(weather),
            "city": "New York", "stateProvince": "NY", "country": "USA",
            "dataSource": "TMY3", "wmo": "725030",
        },
        "geometryEvidence": {
            "schema": geometry["schema"],
            "file": geometry_path.name,
            "sha256": sha256(geometry_path),
            "gbxmlSha256": sha256(gbxml),
            "documentFingerprint": geometry["sourceDocument"]["documentFingerprint"],
        },
        "artifacts": [
            artifact(gbxml, "gbxml"),
            artifact(weather, "weather-epw"),
            artifact(geometry_path, "revit-energy-geometry-evidence"),
        ],
    }
    local = {path.name.lower(): path for path in (gbxml, weather, geometry_path)}
    return manifest, local, geometry_path, geometry


def refresh_geometry(manifest: dict, geometry_path: Path, geometry: dict) -> None:
    write_json(geometry_path, geometry)
    digest = sha256(geometry_path)
    manifest["geometryEvidence"]["sha256"] = digest
    row = next(item for item in manifest["artifacts"] if item["role"] == "revit-energy-geometry-evidence")
    row.update(bytes=geometry_path.stat().st_size, sha256=digest)


def validate(manifest: dict, local: dict[str, Path]) -> dict:
    return validate_geometry_evidence(
        manifest,
        local["revit-energy-geometry.json"],
        local["revit-energy.xml"],
        sha256,
    )


def rejected(manifest: dict, local: dict[str, Path], contains: str) -> None:
    try:
        validate(manifest, local)
    except ValueError as exc:
        assert contains.lower() in str(exc).lower(), str(exc)
        return
    raise AssertionError(f"Expected rejection containing {contains!r}")


with tempfile.TemporaryDirectory(prefix="revex-r128-geometry-") as td:
    root = Path(td)
    manifest, local, geometry_path, geometry = fixture(root)
    validate(manifest, local)
    assert geometry["spaces"][0]["provenance"] == "PREEXISTING_UNTOUCHED"
    assert geometry["spaces"][0]["exportable"] is False
    assert geometry["processedSpaces"][0]["invalidOriginalSpaceId"] == 20

    bad = copy.deepcopy(geometry)
    bad["sourceDocument"]["documentFingerprint"] = "revitdoc_wrong"
    refresh_geometry(manifest, geometry_path, bad)
    rejected(manifest, local, "fingerprint mismatch")

    manifest, local, geometry_path, geometry = fixture(root)
    bad = copy.deepcopy(geometry); bad["sourceDocument"]["phaseId"] = -1
    refresh_geometry(manifest, geometry_path, bad)
    rejected(manifest, local, "phase binding")

    manifest, local, geometry_path, geometry = fixture(root)
    bad = copy.deepcopy(geometry); bad["sourceDocument"]["linearUnit"] = "meter"
    refresh_geometry(manifest, geometry_path, bad)
    rejected(manifest, local, "coordinate/unit")

    manifest, local, geometry_path, geometry = fixture(root)
    bad = copy.deepcopy(geometry); bad["gbxml"]["sha256"] = "0" * 64
    refresh_geometry(manifest, geometry_path, bad)
    rejected(manifest, local, "different gbXML bytes")

    manifest, local, geometry_path, geometry = fixture(root)
    bad = copy.deepcopy(geometry); bad["spaces"][0]["provenance"] = "UNKNOWN"
    refresh_geometry(manifest, geometry_path, bad)
    rejected(manifest, local, "unknown Space provenance")

    # The exact live failure cardinality: 24 invalid originals mixed with valid
    # native Spaces. Every excluded original must have one bounded isolated record.
    manifest, local, geometry_path, geometry = fixture(root)
    geometry["spaces"] = [
        {"id": 1000 + i, "name": f"Invalid {i}", "provenance": "PREEXISTING_UNTOUCHED", "exportable": False}
        for i in range(24)
    ] + [
        {"id": 2000 + i, "name": f"Valid {i}", "provenance": "PREEXISTING_UNTOUCHED", "exportable": True}
        for i in range(8)
    ]
    geometry["processedSpaces"] = [processed_row(1000 + i, 3000 + i) for i in range(24)]
    refresh_geometry(manifest, geometry_path, geometry)
    validate(manifest, local)

    # All-invalid is also publishable geometry evidence only because all 24 Rooms
    # have deterministic processed replacements; the original rows remain excluded.
    geometry["spaces"] = geometry["spaces"][:24]
    refresh_geometry(manifest, geometry_path, geometry)
    validate(manifest, local)

    missing = copy.deepcopy(geometry); missing["processedSpaces"] = missing["processedSpaces"][:-1]
    refresh_geometry(manifest, geometry_path, missing)
    rejected(manifest, local, "no bounded Room-derived")

    tower = copy.deepcopy(geometry); tower["processedSpaces"][0]["heightFt"] = 70.0
    tower["processedSpaces"][0]["topZFt"] = 70.0
    refresh_geometry(manifest, geometry_path, tower)
    rejected(manifest, local, "story-tower")

# Host-level routing contract. The exact exporter writes a fixed evidence name in
# OutputFolder, but immutable publication reads RunFolder. Promotion must therefore
# follow only the exact fresh report + digest binding; the simplified fallback must
# generate a new run-local graph from the same in-memory geometry and original-ID set.
gbxml_host = (ROOT / "src/Liber.Revex.Revit/Services/GbxmlEngineeringService.cs").read_text(encoding="utf-8")
sync_host = (ROOT / "src/Liber.Revex.Revit/Services/EngineeringSyncService.cs").read_text(encoding="utf-8")
fallback_host = (ROOT / "src/Liber.Revex.Revit/Services/SimplifiedGbxmlFallbackService.cs").read_text(encoding="utf-8")
request_host = (ROOT / "src/Liber.Revex.Revit/Revit/RevitRequestHandler.cs").read_text(encoding="utf-8")
for marker in (
    "PromoteGeometryEvidence(reportPath, gbxmlPath!, outputFolder, runFolder, doc, started)",
    'root.TryGetProperty("geometry_evidence"',
    "File.GetLastWriteTime(reportPath) < started.AddSeconds(-3)",
    "!string.Equals(sourcePath, expectedSource, StringComparison.OrdinalIgnoreCase)",
    'Text(metadata, "gbxmlSha256")',
    'Text(sourceDocument, "documentFingerprint")',
    "File.Move(temporary, destination, overwrite: true)",
    'status = "EXPORTED_MISSING_OR_INVALID_GEOMETRY_EVIDENCE"',
):
    require(gbxml_host, marker, "fresh exact geometry promotion")
for marker in (
    "IReadOnlySet<long> originalSpaceIds",
    "ResolveSelectedPhase(doc, prior.ReportPath)",
    "WriteGeometryEvidence(",
    'provenance = originalSpaceIds.Contains(id) ? "PREEXISTING_UNTOUCHED" : "REVEX_CREATED"',
    'provenance = "ROOM_DERIVED_ISOLATED_FROM_PREEXISTING_INVALID_SPACE"',
    'geometryMode = "ROOM_BOUNDARY_STORY_BOUNDED_2_5D"',
    'string destination = Path.Combine(runFolder, "REVIT-ENERGY-GEOMETRY.json")',
    "CentralModelBindingService.ResolveDocumentFingerprint(doc)",
):
    require(fallback_host, marker, "simplified run-local geometry evidence")
require(request_host, "HashSet<long> originalSpaceIds = new FilteredElementCollector", "pre-mutation provenance capture")
require(request_host, "Run(uidoc.Document, output, originalSpaceIds)", "fallback provenance handoff")
require(sync_host, "Path.Combine(source.RunFolder, GeometryEvidenceName)", "immutable publication geometry source")

print(json.dumps({
    "REVEX_R128_GEOMETRY_EVIDENCE": "PASSED",
    "fingerprintMismatchRejected": True,
    "phaseMismatchRejected": True,
    "unsupportedUnitsRejected": True,
    "gbxmlDigestMismatchRejected": True,
    "unknownProvenanceRejected": True,
    "untouchedInvalidPreexistingPreserved": True,
    "mixed24InvalidProcessed": True,
    "all24InvalidProcessed": True,
    "missingProcessedReplacementRejected": True,
    "storyTowerOver20mRejected": True,
    "freshReportOnlyPromotion": True,
    "runLocalSimplifiedEvidence": True,
}, sort_keys=True))
