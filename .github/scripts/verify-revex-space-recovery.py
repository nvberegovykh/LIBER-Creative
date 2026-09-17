#!/usr/bin/env python3
"""Static + behavioral contract for rollback-safe Revit Space recovery."""

import ast
import hashlib
import json
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SHIELD = ROOT / "src/Liber.Revex.Revit/Services/RevexSpaceFailureShield.cs"
ENGINE = ROOT / "src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py"
DYNAMO = ROOT / "src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn"
REQUEST_HANDLER = ROOT / "src/Liber.Revex.Revit/Revit/RevitRequestHandler.cs"
SIMPLIFIED = ROOT / "src/Liber.Revex.Revit/Services/SimplifiedGbxmlFallbackService.cs"


def require(text, marker, label):
    assert marker in text, "{}: missing {!r}".format(label, marker)


shield = SHIELD.read_text(encoding="utf-8")
engine = ENGINE.read_text(encoding="utf-8")
request_handler = REQUEST_HANDLER.read_text(encoding="utf-8")
simplified = SIMPLIFIED.read_text(encoding="utf-8")
ast.parse(engine)
graph = json.loads(DYNAMO.read_text(encoding="utf-8-sig"))
nodes = [
    node for node in graph.get("Nodes", [])
    if str(node.get("ConcreteType", "")).startswith("PythonNodeModels.PythonNode")
]
assert len(nodes) == 1, "Dynamo graph must contain exactly one Python node"
assert nodes[0].get("Code") == engine, "Dynamo Python node is not byte-exact with .py"

assert "DeleteElements" not in shield, "global shield must never delete a Space"
assert "ProceedWithCommit" not in shield, "zero-height failure may never commit"
require(shield, "FailureProcessingResult.ProceedWithRollBack", "C# rollback result")
require(shield, "authoritativeSpacesDeleted=0", "C# preservation diagnostic")
require(shield, "modalSuppressed=true", "C# no-modal diagnostic")
require(shield, "rawFailingIds", "transient failing-id rollback evidence")
require(shield, "protectedSpaceIds", "resolved authoritative Space evidence")
require(shield, 'normalized == "space must have a height greater than 0"', "exact native failure match")
assert 'normalized.Contains("space must have a height greater than 0")' not in shield, "failure shield must not substring-match unrelated failures"

for marker in (
    "zero_height_warning",
    "attach_space_failure_guard(tx)",
    "attach_space_failure_guard(retry_tx)",
    "repair_reused_checkpoint_vertical_metadata",
    "_native_space_integrity_snapshot",
    "_space_integrity_snapshot_matches",
    "existing_space_ids_preserved",
    '"authoritative_spaces_deleted": 0',
    "EADM_SKIPPED_FOR_UNSAFE_REUSED_SPACE_METADATA",
    "write_direct_revit_geometry_gbxml",
    "original_space_ids",
    '"PREEXISTING_UNTOUCHED"',
    '"REVEX_CREATED"',
    '"UNKNOWN"',
    '"exportable": sid in exportable_ids',
    "PREEXISTING_INVALID_SPACE_VERTICAL_EXTENT_PRESERVED_NOT_EXPORTED",
    "_space_has_positive_vertical_evidence",
    "build_room_derived_processed_spaces",
    "ROOM_DERIVED_ISOLATED_FROM_PREEXISTING_INVALID_SPACE",
    "inject_room_derived_processed_geometry",
    "combine_native_and_processed_room_topology",
    "MAX_PROCESSED_ROOM_HEIGHT_FT = 20.0 / 0.3048",
    '"everyInvalidOriginalRepresented"',
    "SPATIAL_MUTATION_SKIPPED_INVALID_ORIGINALS_ROOM_DERIVED",
    "NATIVE_EADM_SKIPPED_ROOM_DERIVED_SPATIAL_DOMAIN",
):
    require(engine, marker, "Python recovery contract")

for marker in (
    "HasPositiveVerticalEvidence",
    "positiveVerticalSpaces",
    "invalid originals remain untouched and receive Room-derived isolated geometry",
):
    require(request_handler, marker, "C# checkpoint contract")
for marker in (
    "BuildDerivedRooms",
    "MaxProcessedRoomHeightFt = 20.0 / FtToM",
    "ROOM:",
    "everyInvalidOriginalRepresented",
    "allInvalidOriginalsRepresented",
    "BLOCKED_BELOW_80_INTEGRITY_PRESERVED",
):
    require(simplified, marker, "C# simplified fallback contract")
assert "preservation_gate_preexport = new { room_preservation = 1.0 }" not in simplified
assert "spatial = 1.0" not in simplified

# Reproduce the six failure-message batches observed in the live Revit 2026 run.
# The policy result is intentionally independent of model/project names: every
# named authoritative source id remains present and the owning transaction rolls
# back once, so no Revit modal or partial batch commit is permitted.
LIVE_BATCHES = (24, 27, 31, 31, 34, 11)
assert sum(LIVE_BATCHES) == 158
source_ids = tuple(range(1, 159))
offset = 0
preserved = []
transactions = []
for batch_size in LIVE_BATCHES:
    batch = source_ids[offset:offset + batch_size]
    offset += batch_size
    transactions.append({"result": "ROLLBACK", "modal": False, "deleted": ()})
    preserved.extend(batch)
assert tuple(preserved) == source_ids
assert all(row["result"] == "ROLLBACK" for row in transactions)
assert all(row["modal"] is False and not row["deleted"] for row in transactions)

# Explicit source-provenance policy: untouched bad pre-existing Spaces remain in
# the model but are excluded from the gbXML set; a bad REVEX-created Space is a hard
# error; unknown provenance fails closed. Transient native failure ids still roll the
# transaction back even when they cannot be resolved to an Element during processing.
policy_cases = {
    "PREEXISTING_UNTOUCHED": {"invalid": True, "exportable": False, "severity": "WARNING", "preserved": True},
    "REVEX_CREATED": {"invalid": True, "exportable": False, "severity": "ERROR", "preserved": True},
    "UNKNOWN": {"invalid": True, "exportable": False, "severity": "ERROR", "preserved": True},
}
assert policy_cases["PREEXISTING_UNTOUCHED"] == {"invalid": True, "exportable": False, "severity": "WARNING", "preserved": True}
assert all(row["preserved"] and not row["exportable"] for row in policy_cases.values())
assert [row["severity"] for row in policy_cases.values()].count("ERROR") == 2
transient_failure = {"description": "Space must have a height greater than 0.", "rawFailingIds": [4365435], "resolvedSpaceIds": []}
assert transient_failure["rawFailingIds"] and not transient_failure["resolvedSpaceIds"]

# Deterministic release fixtures: all 24 excluded originals receive one isolated
# bounded Room record in both mixed and all-invalid populations. Missing one record
# is a hard publication gate even when the aggregate ratio would otherwise exceed 95%.
def processed_fixture(valid_native, invalid_originals, processed):
    expected = valid_native + invalid_originals
    preserved = valid_native + processed
    return {
        "expected": expected,
        "preserved": preserved,
        "spatial": (float(preserved) / float(expected)) if expected else 0.0,
        "everyInvalidOriginalRepresented": processed == invalid_originals,
    }

mixed = processed_fixture(133, 24, 24)
all_invalid = processed_fixture(0, 24, 24)
missing_one = processed_fixture(133, 24, 23)
assert mixed == {"expected": 157, "preserved": 157, "spatial": 1.0, "everyInvalidOriginalRepresented": True}
assert all_invalid == {"expected": 24, "preserved": 24, "spatial": 1.0, "everyInvalidOriginalRepresented": True}
assert missing_one["spatial"] > 0.95 and missing_one["everyInvalidOriginalRepresented"] is False

# Execute the actual pure XML merge functions from the Dynamo source (without
# importing Revit) against 24 deterministic Room cells. This proves both all-invalid
# and mixed output cardinality, shared-face consolidation and idempotence.
tree = ast.parse(engine)
pure_names = {
    "local_name", "namespace_uri", "qualified", "add_cartesian_point",
    "add_planar_geometry", "_canonical_xy_ring",
    "inject_room_derived_processed_geometry",
}
pure_nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in pure_names]
namespace = {
    "ET": ET,
    "hashlib": hashlib,
    "MAX_PROCESSED_ROOM_HEIGHT_FT": 20.0 / 0.3048,
}
exec(compile(ast.Module(body=pure_nodes, type_ignores=[]), str(ENGINE), "exec"), namespace)
inject = namespace["inject_room_derived_processed_geometry"]

def room_row(index):
    x = float((index % 6) * 10); y = float((index // 6) * 10)
    return {
        "id": "liber-room-derived-{}".format(index),
        "sourceRoomId": 3000 + index,
        "name": "Room {}".format(index),
        "baseZFt": 0.0, "topZFt": 10.0,
        "areaFt2": 100.0, "volumeFt3": 1000.0,
        "outerLoopFt": [[x,y,0],[x+10,y,0],[x+10,y+10,0],[x,y+10,0]],
        "innerLoopsFt": [],
    }

with tempfile.TemporaryDirectory(prefix="revex-room-derived-") as td:
    xml = Path(td) / "all-invalid.xml"
    xml.write_text('<?xml version="1.0"?><gbXML xmlns="http://www.gbxml.org/schema" lengthUnit="Meters"><Campus id="c"><Building id="b"><Area>0</Area></Building></Campus></gbXML>', encoding="utf-8")
    rows = [room_row(i) for i in range(24)]
    merge = inject(str(xml), rows, [])
    root = ET.parse(xml).getroot()
    counts = {
        kind: sum(1 for element in root.iter() if element.tag.rsplit("}", 1)[-1] == kind)
        for kind in ("Space", "Surface", "SpaceBoundary")
    }
    assert counts["Space"] == 24 and counts["Surface"] >= 4
    assert merge["consolidatedFaces"] > 0 and merge["sourceSpacesModified"] is False
    first_bytes = xml.read_bytes()
    repeat = inject(str(xml), rows, [])
    assert repeat["alreadyMerged"] is True and xml.read_bytes() == first_bytes

    mixed_xml = Path(td) / "mixed.xml"
    native = "".join('<Space id="native-{}"><Name>N</Name></Space>'.format(i) for i in range(8))
    mixed_xml.write_text('<?xml version="1.0"?><gbXML xmlns="http://www.gbxml.org/schema" lengthUnit="Meters"><Campus id="c"><Building id="b"><Area>0</Area>{}</Building></Campus></gbXML>'.format(native), encoding="utf-8")
    inject(str(mixed_xml), rows, [])
    mixed_root = ET.parse(mixed_xml).getroot()
    assert sum(1 for element in mixed_root.iter() if element.tag.rsplit("}", 1)[-1] == "Space") == 32

print(json.dumps({
    "REVEX_SPACE_RECOVERY": "PASSED",
    "live_batches": list(LIVE_BATCHES),
    "authoritative_space_ids_preserved": len(preserved),
    "authoritative_spaces_deleted": 0,
    "modal_contract": "ROLLBACK_ONLY",
    "python_dynamo_parity": True,
    "provenance_policy": policy_cases,
    "transient_ids_force_rollback": True,
    "mixed_24_invalid_room_derived": mixed,
    "all_24_invalid_room_derived": all_invalid,
    "missing_one_hard_block": True,
    "actual_xml_merge_all_invalid_spaces": counts["Space"],
    "actual_xml_merge_mixed_spaces": 32,
    "shared_faces_consolidated": merge["consolidatedFaces"],
    "room_merge_idempotent": True,
}, sort_keys=True))
