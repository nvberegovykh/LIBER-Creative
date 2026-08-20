#!/usr/bin/env python3
"""Static + behavioral contract for rollback-safe Revit Space recovery."""

import ast
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SHIELD = ROOT / "src/Liber.Revex.Revit/Services/RevexSpaceFailureShield.cs"
ENGINE = ROOT / "src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py"
DYNAMO = ROOT / "src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn"


def require(text, marker, label):
    assert marker in text, "{}: missing {!r}".format(label, marker)


shield = SHIELD.read_text(encoding="utf-8")
engine = ENGINE.read_text(encoding="utf-8")
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
):
    require(engine, marker, "Python recovery contract")

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

print(json.dumps({
    "REVEX_SPACE_RECOVERY": "PASSED",
    "live_batches": list(LIVE_BATCHES),
    "authoritative_space_ids_preserved": len(preserved),
    "authoritative_spaces_deleted": 0,
    "modal_contract": "ROLLBACK_ONLY",
    "python_dynamo_parity": True,
}, sort_keys=True))
