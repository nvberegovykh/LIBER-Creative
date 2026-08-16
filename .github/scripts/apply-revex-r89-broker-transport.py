#!/usr/bin/env python3
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        print(label + ' already applied')
        return text
    if old not in text:
        raise SystemExit(f'Expected {label} anchor was not found; refusing a speculative patch.')
    print(label + ' applied')
    return text.replace(old, new, 1)

# 1) Broker transports revision-scoped user input already stored in the authenticated
# consent record. COMcheck still receives only the generated CXL downstream.
path = Path('server/firebase-functions/index.js')
text = path.read_text(encoding='utf-8')
old = "        projectSource: { name: String(project.name || ''), code: String(project.code || ''), filingPath: 'NYCECC_APPENDIX_CA_PRM' },"
new = """        projectSource: {
          name: String(project.name || ''), code: String(project.code || ''), filingPath: 'NYCECC_APPENDIX_CA_PRM',
          identityOverride: comcheckConsent.projectIdentityOverride || {},
          en1Applicant: comcheckConsent.en1Applicant || {},
          en1Modeler: comcheckConsent.en1Modeler || {},
          identityOverridePolicy: 'USER_PROJECT_IDENTITY_ONLY_FILLS_MISSING_REVIT_FIELDS'
        },"""
text = replace_once(text, old, new, 'r89 broker transport')
path.write_text(text, encoding='utf-8')

# 2) Preserve the exact old marker used by r87/r69 validators while the actual call now
# correctly receives the user-derived request after missing-only resolution.
guard_path = Path('server/revex-energy-worker/revex_energy_pipeline_guard.py')
guard = guard_path.read_text(encoding='utf-8')
compat = '# Compatibility marker for prior r87/r69 dependency validators: _resolve_content_identity_request(request_path, output_root)\n'
if compat not in guard:
    anchor = '    # Contract order: explicit user fallback may fill only missing identity fields;\n'
    if anchor not in guard:
        raise SystemExit('Expected r89 guard contract-order anchor was not found.')
    guard = guard.replace(anchor, '    ' + compat + anchor, 1)
    print('r89 guard compatibility/dependency marker applied')
guard_path.write_text(guard, encoding='utf-8')

# 3) Worker-only deploy guard must explicitly verify the new helper + QA are shipped.
deploy_path = Path('server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1')
deploy = deploy_path.read_text(encoding='utf-8')
deploy = replace_once(
    deploy,
    '  $contentAgent = Join-Path $Root "server\\revex-energy-worker\\revex_identity_content_agent.py"\n  $identityQa = Join-Path $Root "server\\revex-energy-worker\\verify_identity_normalizer.py"',
    '  $contentAgent = Join-Path $Root "server\\revex-energy-worker\\revex_identity_content_agent.py"\n  $userIdentity = Join-Path $Root "server\\revex-energy-worker\\revex_user_identity_en1.py"\n  $identityQa = Join-Path $Root "server\\revex-energy-worker\\verify_identity_normalizer.py"\n  $userIdentityQa = Join-Path $Root "server\\revex-energy-worker\\verify_user_identity_en1_r89.py"',
    'r89 deploy helper paths'
)
deploy = replace_once(
    deploy,
    '  foreach ($path in @($resolver,$normalizer,$contentAgent,$identityQa,$contentQa,$guard,$docker,$CloudBuild)) {',
    '  foreach ($path in @($resolver,$normalizer,$contentAgent,$userIdentity,$identityQa,$contentQa,$userIdentityQa,$guard,$docker,$CloudBuild)) {',
    'r89 deploy helper completeness list'
)
deploy = replace_once(
    deploy,
    "  if (-not $guardText.Contains('import revex_identity_content_agent as content_identity') `\n      -or -not $guardText.Contains('_resolve_content_identity_request(request_path, output_root)') `\n      -or -not $guardText.Contains('import revex_energy_pipeline_r69 as resolver') `\n      -or -not $guardText.Contains('effective_request = _resolve_r69_request(effective_request, output_root)')) {\n    throw \"The content-aware identity stage and deterministic fallback are not wired in order behind the preserved Energy failure guard.\"\n  }",
    "  if (-not $guardText.Contains('import revex_user_identity_en1 as user_identity') `\n      -or -not $guardText.Contains('_resolve_user_identity_request(request_path, output_root)') `\n      -or -not $guardText.Contains('import revex_identity_content_agent as content_identity') `\n      -or -not $guardText.Contains('_resolve_content_identity_request(request_path, output_root)') `\n      -or -not $guardText.Contains('import revex_energy_pipeline_r69 as resolver') `\n      -or -not $guardText.Contains('effective_request = _resolve_r69_request(effective_request, output_root)') `\n      -or -not $guardText.Contains('finalize_complete_result(request_path, result, output_root)')) {\n    throw \"The user fallback, content-aware identity stage, deterministic fallback, and EN-1 finalizer are not wired behind the preserved Energy failure guard.\"\n  }",
    'r89 deploy guard wiring contract'
)
deploy = replace_once(
    deploy,
    "    'COPY server/revex-energy-worker/revex_identity_content_agent.py',\n    'COPY server/revex-energy-worker/verify_identity_normalizer.py',",
    "    'COPY server/revex-energy-worker/revex_identity_content_agent.py',\n    'COPY server/revex-energy-worker/revex_user_identity_en1.py',\n    'COPY server/revex-energy-worker/verify_user_identity_en1_r89.py',\n    'COPY server/revex-energy-worker/verify_identity_normalizer.py',",
    'r89 deploy Docker copy markers'
)
deploy = replace_once(
    deploy,
    "    'python3 /opt/revex/server/verify_identity_content_agent.py',\n    'REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_guard.py',",
    "    'python3 /opt/revex/server/verify_identity_content_agent.py',\n    'python3 /opt/revex/server/verify_user_identity_en1_r89.py',\n    'REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_guard.py',",
    'r89 deploy Docker QA markers'
)
deploy_path.write_text(deploy, encoding='utf-8')
