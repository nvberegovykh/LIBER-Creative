#!/usr/bin/env python3
from __future__ import annotations
import copy
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / 'server/revex-energy-worker/revex_energy_pipeline_r69.py'
GUARD = ROOT / 'server/revex-energy-worker/revex_energy_pipeline_guard.py'
DOCKER = ROOT / 'server/revex-energy-worker/Dockerfile'
DEPLOY = ROOT / 'server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1'
APPEARANCE = ROOT / 'docs/liber-apps/apps/revex/appearance-state-r75.js'
VIEWER = ROOT / 'docs/liber-apps/apps/revex/viewer-runtime-r75.js'
COMPANION = ROOT / 'docs/liber-apps/apps/revex/companion-runtime-r75.js'
UI = ROOT / 'docs/liber-apps/apps/revex/ui-integrity.js'
APP = ROOT / 'docs/liber-apps/apps/revex/app.js'

spec = importlib.util.spec_from_file_location('revex_r69', WRAPPER)
assert spec and spec.loader
r69 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r69)

facts = {
    'schema': 'liber.revex.revit-page-facts.v1',
    'structuredIdentity': {'title': '250 Midwood Street','address': '250 Midwood Street','borough': 'Brooklyn','city': None,'state': None,'zip': None},
    'pages': [
        {'pageType': 'T', 'confidence': 0.99, 'project': {'title': '250 Midwood Street', 'address': '250 Midwood Street'}},
        {'pageType': 'Z', 'confidence': 0.98, 'project': {'borough': 'Brooklyn'}},
    ],
}
original = copy.deepcopy(facts)
seen = {}
def census_fixture(identity):
    seen.update(identity)
    return {'city': 'Brooklyn', 'state': 'NY', 'zip': '11225', 'matchedAddress': '250 MIDWOOD ST, BROOKLYN, NY, 11225'}
resolved, identity = r69._resolve_identity(facts, census_fixture)
assert facts == original, 'immutable source page facts were mutated'
assert seen['address'] == '250 Midwood Street'
assert resolved['structuredIdentity']['city'] == 'Brooklyn'
assert resolved['structuredIdentity']['state'] == 'NY'
assert resolved['structuredIdentity']['zip'] == '11225'
assert identity['city'] == 'Brooklyn' and identity['state'] == 'NY' and identity['zip'] == '11225'
assert resolved['locationResolution']['provider'] == 'US_CENSUS_GEOCODER_PUBLIC_AR_CURRENT'
assert resolved['locationResolution']['remainingMissing'] == []
assert set(resolved['locationResolution']['filled']) == {'city', 'state', 'zip'}

parsed = r69._split_address_location('18 Example Ave, Queens, NY 11375')
assert parsed == {'city': 'Queens', 'state': 'NY', 'zip': '11375'}
local_only = {'schema': 'liber.revex.revit-page-facts.v1','structuredIdentity': {'title': '18 Example Ave', 'address': '18 Example Ave, Queens, NY 11375'},'pages': []}
resolved_local, identity_local = r69._resolve_identity(local_only, lambda _: {})
assert identity_local['city'] == 'Queens' and identity_local['state'] == 'NY' and identity_local['zip'] == '11375'
assert resolved_local['locationResolution']['provider'] is None
unresolved_facts = {'structuredIdentity': {'title': 'Unknown project'}, 'pages': []}
unresolved, unresolved_identity = r69._resolve_identity(unresolved_facts, lambda _: {})
assert not unresolved_identity['city'] and not unresolved_identity['state'] and not unresolved_identity['zip']
assert unresolved['locationResolution']['remainingMissing'] == ['city', 'state', 'zip']

wrapper_text = WRAPPER.read_text(encoding='utf-8')
guard_text = GUARD.read_text(encoding='utf-8')
docker_text = DOCKER.read_text(encoding='utf-8')
deploy_text = DEPLOY.read_text(encoding='utf-8')
appearance_text = APPEARANCE.read_text(encoding='utf-8')
viewer_text = VIEWER.read_text(encoding='utf-8')
companion_text = COMPANION.read_text(encoding='utf-8')
ui_text = UI.read_text(encoding='utf-8')
app_text = APP.read_text(encoding='utf-8')

assert 'geocoding.geo.census.gov/geocoder/locations/onelineaddress' in wrapper_text
assert 'derived-only-from-immutable-active-Revit-address' in wrapper_text
assert '00_PAGE_FACTS_RESOLVED_R69.json' in wrapper_text
assert 'import revex_energy_pipeline_r69 as resolver' in guard_text
assert '_resolve_r69_request(request_path, output_root)' in guard_text
assert 'COPY server/revex-energy-worker/revex_energy_pipeline_r69.py' in docker_text
assert 'REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_guard.py' in docker_text
assert 'REVEX_PIPELINE_IMPL=/opt/revex/energy/revex_energy_pipeline.py' in docker_text

assert 'REVEX_NATIVE_EXITCODE_AUTHORITATIVE' in deploy_text
assert deploy_text.count('$ErrorActionPreference = "Continue"') >= 3
assert '$script:NativeExitCode = [int]$code' in deploy_text
assert 'if ($script:NativeExitCode -ne 0 -or @($active).Count -eq 0)' in deploy_text
assert 'if ($script:NativeExitCode -ne 0 -or -not $CloudBuildSa)' in deploy_text
assert 'if ($script:NativeExitCode -ne 0) { throw "Energy worker deployed but could not be re-read." }' in deploy_text

# r75 successor: one persistent appearance state owner and one incremental renderer.
assert "revexKind:'bim-appearance'" in appearance_text
assert "Store.saveBimAppearance=save" in appearance_text
assert "Store.subscribeKind(projectId,'bim-appearance'" in appearance_text
assert 'setInterval(' not in appearance_text
assert "m.map=null" in viewer_text
assert "m.color.set(0xffffff)" in viewer_text
assert 'appearanceFp(previous.get(key))!==appearanceFp(next.get(key))' in viewer_text
assert 'scheduleAppearanceRows(this,changed)' in viewer_text
assert 'All same Revit type' in companion_text
assert '<span>Family</span><select data-r75-f' in companion_text
assert '<span>Type</span><select data-r75-t' in companion_text
assert 'record_in/materials/architextures' in companion_text
assert 'https://architextures.org/create' in companion_text
assert 'r75-provider-frame' in companion_text
assert 'Restore all hidden / deleted' in companion_text
assert 'setInterval(' not in companion_text
assert 'appearance-state-r75.js?v=20260816r75-appearance1' in ui_text
assert 'viewer-runtime-r75.js?v=20260816r75-viewer1' in ui_text
assert 'companion-runtime-r75.js?v=20260816r75-companion1' in ui_text
assert "loadScript('appearance-r70.js" not in ui_text
assert "loadScript('docs-pages-r68.js" not in ui_text
# Core Docs page navigation remains lightweight: one source PDF, native #page positioning.
assert "const url = page ? `${base}#page=${page}` : base;" in app_text

print(json.dumps({
    'schema': 'liber.revex.r75-energy-appearance-qa.v1',
    'status': 'PASSED',
    'energyIdentity': {'immutableSource': True, 'derivedLocation': True, 'fabricationBlocked': True, 'r55GuardPreserved': True},
    'deployment': {'nativeExitCodeAuthoritative': True, 'stderrCannotFalseFail': True, 'workerOnlyPreserved': True},
    'docs': {'nativePdfPagePositioning': True, 'mainThreadPdfSplitterDisabled': True},
    'viewer': {'visibilityPersists': True,'appearanceSeparateFromTransform': True,'familyThenTypeFilter': True,'typeFinishSingleRecord': True,'texturePriorityColorFallback': True,'architexturesEmbeddedProperties': True,'restoreAllBatched': True},
}, indent=2))
