#!/usr/bin/env python3
from pathlib import Path
import json

root = Path(__file__).resolve().parents[2]
handler = (root / 'src/Liber.Revex.Revit/Revit/RevitRequestHandler.cs').read_text(encoding='utf-8')
engine = (root / 'src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py').read_text(encoding='utf-8')

required_handler = [
    'IsRecoverableSpatialTopologyFailure(ex)',
    'CreateOrFixSpaces = false',
    'SOURCE_TOPOLOGY_FALLBACK',
    'ambiguous thermal boundary',
    'analytical vertex',
    'room/space boundary branch',
    'message.Contains("more than two"',
]
for marker in required_handler:
    assert marker in handler, f'missing r73 handler marker: {marker}'

# Retry must be bounded to the exact mutation-enabled non-audit path.
assert '!settings.AuditOnly' in handler
assert 'settings.CreateOrFixSpaces' in handler
assert handler.count('new GbxmlEngineeringService().Run(app, uidoc.Document,') == 2

# Existing engine must retain the source-native fallback and 80% publication contract.
for marker in [
    'PRESERVATION_MINIMUM = 0.80',
    'DIRECT_REVIT_GEOMETRY_FALLBACK',
    'NATIVE_ENERGY_MODEL_CREATION_FAILED_ALL_TIERS',
    'GAP_FILL_PARTIAL_LEVEL_FAILURE_TOLERATED',
]:
    assert marker in engine, f'energy fallback contract missing: {marker}'

# Never convert this into a forced/guessed export.
fallback_block = handler.split('GbxmlEngineeringSettings fallbackSettings', 1)[1].split('output = new GbxmlEngineeringService()', 1)[0]
assert 'ExportDespiteBlockers = true' not in fallback_block
assert 'CreateOrFixSpaces = false' in fallback_block

print(json.dumps({
    'schema': 'liber.revex.r73-energy-topology-fallback.v1',
    'status': 'PASSED',
    'trigger': 'explicit Revit spatial-boundary topology exception only',
    'retryCount': 1,
    'topologyMutationOnRetry': False,
    'sourceNativeFallbackPreserved': True,
    'publicationMinimum': 0.80,
}, indent=2))
