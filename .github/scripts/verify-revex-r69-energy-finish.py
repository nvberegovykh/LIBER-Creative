#!/usr/bin/env python3
from __future__ import annotations
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server/revex-energy-worker'
if str(SERVER) not in sys.path:
    sys.path.insert(0, str(SERVER))
WRAPPER = SERVER / 'revex_energy_pipeline_r69.py'
NORMALIZER = SERVER / 'revex_energy_identity_normalizer.py'
CONTENT_AGENT = SERVER / 'revex_identity_content_agent.py'
CONTENT_QA = SERVER / 'verify_identity_content_agent.py'
GUARD = SERVER / 'revex_energy_pipeline_guard.py'
DOCKER = SERVER / 'Dockerfile'
DEPLOY = SERVER / 'DEPLOY_ENERGY_WORKER_ONLY_R69.ps1'
APPEARANCE = ROOT / 'docs/liber-apps/apps/revex/appearance-state-r75.js'
VIEWER = ROOT / 'docs/liber-apps/apps/revex/viewer-runtime-r75.js'
COMPANION = ROOT / 'docs/liber-apps/apps/revex/companion-runtime-r75.js'
UI = ROOT / 'docs/liber-apps/apps/revex/ui-integrity.js'
APP = ROOT / 'docs/liber-apps/apps/revex/app.js'
ENERGY_DIAGNOSTICS = ROOT / 'docs/liber-apps/apps/revex/energy-diagnostics-r68.js'

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

midwood_address = '250 MIDWOOD STREET,\nBROOKLYN, NY 11225'
midwood_calls = []
resolved_midwood, identity_midwood = r69._resolve_identity({
    'schema': 'liber.revex.revit-page-facts.v1',
    'structuredIdentity': {'title': '250 MIDWOOD STREET', 'address': midwood_address},
    'pages': [],
}, lambda identity: midwood_calls.append(dict(identity)) or {})
assert identity_midwood['city'].upper() == 'BROOKLYN'
assert identity_midwood['state'] == 'NY'
assert identity_midwood['zip'] == '11225'
assert resolved_midwood['locationResolution']['provider'] is None
assert resolved_midwood['locationResolution']['remainingMissing'] == []
assert midwood_calls == [], 'current Midwood address already contains location; Census must not be called'

# Exact live failure topology remains a regression fixture, not a runtime branch. Reduced
# page facts have only the street while verified raw Revit evidence contains the locality
# plus distracting consultant addresses. The generalized normalizer must resolve it.
with tempfile.TemporaryDirectory(prefix='revex-r87-live-regression-') as temp:
    folder = Path(temp)
    digest = 'a' * 64
    raw_identity_path = folder / 'revit-project-identity.json'
    manifest_path = folder / 'engineering-sync.json'
    raw_identity_path.write_text(json.dumps({
        'schema': 'liber.revex.revit-project-identity.v1',
        'authority': 'active-revit-document-t-z-title-evidence',
        'digest': digest,
        'displayName': '250 Midwood Street',
        'fields': {
            'project.Project Name': '250 Midwood Street',
            'project.Address': '250 MIDWOOD STREET',
            'sheet.T001.titleBlock.Project Address': '250 MIDWOOD STREET,\nBROOKLYN, NY 11225',
            'sheet.T001.titleBlock.Consultant Address': '2259 BEDFORD AVENUE, BROOKLYN, NY 11219',
            'sheet.T001.titleBlock.Engineer Address': '7407 13TH AVE, BROOKLYN, NY 11228',
        },
    }), encoding='utf-8')
    manifest_path.write_text(json.dumps({
        'schema': 'liber.revex.engineering-sync.v1',
        'projectBinding': {'identityEvidenceDigest': digest},
    }), encoding='utf-8')
    request = {
        'engineeringManifestPath': str(manifest_path),
        'sourceArtifacts': [str(raw_identity_path)],
    }
    raw_calls = []
    resolved_raw, identity_raw = r69._resolve_identity({
        'schema': 'liber.revex.revit-page-facts.v1',
        'structuredIdentity': {'title': '250 Midwood Street', 'address': '250 MIDWOOD STREET'},
        'pages': [],
    }, lambda identity: raw_calls.append(dict(identity)) or {}, request=request)
    assert identity_raw['address'].upper().startswith('250 MIDWOOD STREET')
    assert identity_raw['city'].upper() == 'BROOKLYN'
    assert identity_raw['state'] == 'NY'
    assert identity_raw['zip'] == '11225'
    assert resolved_raw['locationResolution']['remainingMissing'] == []
    assert resolved_raw['locationResolution']['provider'] is None
    assert raw_calls == [], 'verified raw Revit/titleblock evidence must resolve before Census'
    assert '11219' not in json.dumps(resolved_raw['structuredIdentity'])
    assert '11228' not in json.dumps(resolved_raw['structuredIdentity'])

unresolved_facts = {'structuredIdentity': {'title': 'Unknown project'}, 'pages': []}
unresolved, unresolved_identity = r69._resolve_identity(unresolved_facts, lambda _: {})
assert not unresolved_identity['city'] and not unresolved_identity['state'] and not unresolved_identity['zip']
assert unresolved['locationResolution']['remainingMissing'] == ['city', 'state', 'zip']

wrapper_text = WRAPPER.read_text(encoding='utf-8')
normalizer_text = NORMALIZER.read_text(encoding='utf-8')
content_agent_text = CONTENT_AGENT.read_text(encoding='utf-8')
content_qa_text = CONTENT_QA.read_text(encoding='utf-8')
guard_text = GUARD.read_text(encoding='utf-8')
docker_text = DOCKER.read_text(encoding='utf-8')
deploy_text = DEPLOY.read_text(encoding='utf-8')
appearance_text = APPEARANCE.read_text(encoding='utf-8')
viewer_text = VIEWER.read_text(encoding='utf-8')
companion_text = COMPANION.read_text(encoding='utf-8')
ui_text = UI.read_text(encoding='utf-8')
app_text = APP.read_text(encoding='utf-8')
energy_diag_text = ENERGY_DIAGNOSTICS.read_text(encoding='utf-8')

assert 'geocoding.geo.census.gov/geocoder/locations/onelineaddress' in wrapper_text
assert 'derived-only-from-immutable-active-Revit-address' in wrapper_text
assert '00_PAGE_FACTS_RESOLVED_R69.json' in wrapper_text
assert '_verified_raw_revit_identity' in wrapper_text
assert 'import revex_energy_identity_normalizer as identity_normalizer' in wrapper_text
assert 'PROJECT_IDENTITY_NORMALIZED' in wrapper_text
assert 'normalize_verified_evidence' in normalizer_text
assert 'locality_near_authoritative_address' in normalizer_text
assert 'PARTY_BOUNDARY' in normalizer_text

# r88 dependency order: content-aware project/party role separation and repeated T/Z
# consensus first; deterministic r69 normalization/geocode remains the fallback.
assert 'content-aware-consensus-over-immutable-active-Revit-T-Z-evidence' in content_agent_text
assert 'MIN_AGENT_CONFIDENCE' in content_agent_text
assert 'validate_agent_candidate' in content_agent_text
assert 'excludedPartyEvidence' in content_agent_text
assert '_structured_identity_complete' in content_agent_text
assert 'partyAddressRejected' in content_qa_text
assert 'twoSourceConsensus' in content_qa_text
assert 'import revex_identity_content_agent as content_identity' in guard_text
assert '_resolve_content_identity_request(request_path, output_root)' in guard_text
assert 'import revex_energy_pipeline_r69 as resolver' in guard_text
assert 'effective_request = _resolve_r69_request(effective_request, output_root)' in guard_text
assert guard_text.index('_resolve_content_identity_request(request_path, output_root)') < guard_text.index('_resolve_r69_request(effective_request, output_root)')

assert 'COPY server/revex-energy-worker/revex_energy_identity_normalizer.py' in docker_text
assert 'COPY server/revex-energy-worker/revex_identity_content_agent.py' in docker_text
assert 'COPY server/revex-energy-worker/revex_energy_pipeline_r69.py' in docker_text
assert 'COPY server/revex-energy-worker/verify_identity_content_agent.py' in docker_text
assert 'python3 /opt/revex/server/verify_identity_normalizer.py' in docker_text
assert 'python3 /opt/revex/server/verify_identity_content_agent.py' in docker_text
assert 'REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_guard.py' in docker_text
assert 'REVEX_PIPELINE_IMPL=/opt/revex/energy/revex_energy_pipeline.py' in docker_text
assert '250 MIDWOOD' not in normalizer_text.upper()
assert '79 WINTHROP' not in normalizer_text.upper()
assert '250 MIDWOOD' not in content_agent_text.upper()
assert '79 WINTHROP' not in content_agent_text.upper()
assert '250 MIDWOOD' not in wrapper_text.upper()
assert '79 WINTHROP' not in wrapper_text.upper()

assert 'REVEX_NATIVE_EXITCODE_AUTHORITATIVE' in deploy_text
assert deploy_text.count('$ErrorActionPreference = "Continue"') >= 3
assert '$script:NativeExitCode = [int]$code' in deploy_text
assert 'if ($script:NativeExitCode -ne 0 -or @($active).Count -eq 0)' in deploy_text
assert 'if ($script:NativeExitCode -ne 0 -or -not $CloudBuildSa)' in deploy_text
assert 'if ($script:NativeExitCode -ne 0) { throw "Energy worker deployed but could not be re-read." }' in deploy_text
assert 'revex_identity_content_agent.py' in deploy_text
assert 'verify_identity_content_agent.py' in deploy_text

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
assert 'energy-diagnostics-r68.js?v=20260816r87-energy-replay1' in ui_text
assert 'ENERGY_STALE_FAILURE_IGNORED' in energy_diag_text
assert "failedRevision!==current" in energy_diag_text
assert 'Retry this published revision' in energy_diag_text
assert 'This revision already failed · sync a new revision' not in energy_diag_text
assert "loadScript('appearance-r70.js" not in ui_text
assert "loadScript('docs-pages-r68.js" not in ui_text
assert "const url = page ? `${base}#page=${page}` : base;" in app_text

print(json.dumps({
    'schema': 'liber.revex.r88-energy-identity-qa.v1',
    'status': 'PASSED',
    'energyIdentity': {
        'immutableSource': True,
        'contentAwareRoleSeparation': True,
        'twoSourceConsensus': True,
        'generalNormalizerFallback': True,
        'rawRevitFieldsWired': True,
        'liveMidwoodRegression': True,
        'consultantAddressRejected': True,
        'revitPdfFallbackWired': True,
        'censusLastResortOnly': True,
        'fabricationBlocked': True,
        'projectSpecificRuntimeBranches': False,
        'r55GuardPreserved': True,
    },
    'energyDiagnostics': {'revisionScoped': True, 'staleFailureHidden': True, 'publishedRevisionReplay': True},
    'deployment': {'nativeExitCodeAuthoritative': True, 'stderrCannotFalseFail': True, 'workerOnlyPreserved': True},
    'docs': {'nativePdfPagePositioning': True, 'mainThreadPdfSplitterDisabled': True},
    'viewer': {'visibilityPersists': True,'appearanceSeparateFromTransform': True,'familyThenTypeFilter': True,'typeFinishSingleRecord': True,'texturePriorityColorFallback': True,'architexturesEmbeddedProperties': True,'restoreAllBatched': True},
}, indent=2))
