#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
P = ROOT / 'PUBLISH_REVEX_R49.ps1'
s = P.read_text(encoding='utf-8-sig')


def set_var(name: str, rhs: str):
    global s
    pat = rf'^\${re.escape(name)}\s*=\s*.*$'
    s2, n = re.subn(pat, f'${name} = {rhs}', s, count=1, flags=re.M)
    if n != 1:
        raise SystemExit(f'publisher variable missing: {name}')
    s = s2


def set_hash(path: str, digest: str):
    global s
    escaped = re.escape(path)
    pat = rf'^\s*"{escaped}"\s*=\s*"[0-9a-f]{{64}}"\s*$'
    repl = f'    "{path}" = "{digest}"'
    s2, n = re.subn(pat, lambda _: repl, s, count=1, flags=re.M)
    if n != 1:
        raise SystemExit(f'expected hash row missing: {path}')
    s = s2


set_var('PublisherOrchestration', '"20260815r49-google-render-walk-v6"')
set_var('GbxmlEvidenceProducerSha256', '"523effcbb97240290153964974ee769c9fb5c98be3e9452b136619a862b4939b"')
set_var('CanonicalSourceCommit', '"70ab6594a0199ac5b1616fddcba32bc2a6860adb"')
set_var('CanonicalSourceRef', '"release/revex-r49-google-render-walk-20260815"')
set_var('CanonicalSourceArchiveName', '"REVEX_R49_SOURCE_70ab6594a0199ac5b1616fddcba32bc2a6860adb.zip"')
set_var('CanonicalSourceArchiveSha256', '"25aceb5d18d3a043372142207648daf3638a69a5f8f77781b8333dc29bb3195b"')
set_var('CanonicalSourceArchiveSize', '52836467L')

# Preserve the green Midwood Energy correction in the production lineage.
set_hash(r'src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py', '472c387c3aa70440aa67e8cdf2d8bd47c6157dc36786f91c989162a4cd9e14cb')
set_hash(r'src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn', 'edf0728ebc429e34e00f33d49ffd3bbf883a50cb49a623e90561c3024ff9b638')
set_hash(r'src\Liber.Revex.Revit\Engineering\Energy\verify_revex_r49_energy.py', '258cfc8084beff7961f7c9a577e60a73a7d0c496bc76cd98665cb68f6f905365')

# Exact web bytes in the immutable Git-built candidate.
set_hash(r'src\Live-Companion\index.html', '1d671c9518ed2c2c791c1b4a3c6407e63a6cf3744163abed36d6ea4fde373bf6')
set_hash(r'src\Live-Companion\diagnostics-r29.js', 'd95375158056ac90bb305664c040a504ff5ba4edeff01bfcd82c565e59a98960')
set_hash(r'src\Live-Specifications\revex-source-compat-r49.js', '1bd66ae0e8fa121726ab45e9d451783aa18b37e73d3829ab93b0a167f269bb29')

index_row = '    "src\\Live-Companion\\index.html" = "1d671c9518ed2c2c791c1b4a3c6407e63a6cf3744163abed36d6ea4fde373bf6"\n'
web_rows = '''    "src\\Live-Companion\\render-agent.js" = "bdd7bbe9dd3ac15b1e5eed9ac9410040ca51db2c5966fe2cba324d13524ce2ca"\n    "src\\Live-Companion\\render-agent.css" = "60b4915e7e3d85850de2c113f5930fcc23272ae41c29ed6a6b32cfc1c4182eb8"\n    "src\\Live-Companion\\workspace-r51.js" = "633e0fb60fb1d3cf118637857b2797598d7a3e11d44cb27a09e38337670e7440"\n    "src\\Live-Companion\\workspace-r51.css" = "c7a4b52d7ebd7d2386469135c00759a834da83f8699d10dfa2eb6bb9750a2b00"\n    "docs\\liber-apps\\js\\firebase-loader.js" = "d1b843895d94bfa37510e76de7165c73afb67ab31e0286b826b7f4f6c054dbf6"\n'''
if '"src\\Live-Companion\\workspace-r51.js"' not in s:
    if index_row not in s:
        raise SystemExit('index hash anchor missing')
    s = s.replace(index_row, index_row + web_rows, 1)

# Closure paths / contracts.
review_path = '  $reviewRuntimePath = Join-Path $SourceRoot "src\\Live-Companion\\review-integrity-r50.js"\n'
if '$renderRuntimePath' not in s:
    if review_path not in s: raise SystemExit('review runtime anchor missing')
    s = s.replace(review_path, review_path + '''  $renderRuntimePath = Join-Path $SourceRoot "src\\Live-Companion\\render-agent.js"\n  $workspaceRuntimePath = Join-Path $SourceRoot "src\\Live-Companion\\workspace-r51.js"\n  $firebaseLoaderPath = Join-Path $SourceRoot "docs\\liber-apps\\js\\firebase-loader.js"\n''', 1)
old_required = '$reviewRuntimePath,$specCompatPath,$workflowPath'
new_required = '$reviewRuntimePath,$renderRuntimePath,$workspaceRuntimePath,$firebaseLoaderPath,$specCompatPath,$workflowPath'
if new_required not in s:
    if old_required not in s: raise SystemExit('required dependency list anchor missing')
    s = s.replace(old_required, new_required, 1)

workflow_read = '  $workflow = [IO.File]::ReadAllText($workflowPath, [Text.Encoding]::UTF8)\n'
if '$renderer = [IO.File]::ReadAllText($renderRuntimePath' not in s:
    if workflow_read not in s: raise SystemExit('workflow read anchor missing')
    s = s.replace(workflow_read, '''  $renderer = [IO.File]::ReadAllText($renderRuntimePath, [Text.Encoding]::UTF8)\n  $workspace = [IO.File]::ReadAllText($workspaceRuntimePath, [Text.Encoding]::UTF8)\n  $firebaseLoader = [IO.File]::ReadAllText($firebaseLoaderPath, [Text.Encoding]::UTF8)\n  if (-not $renderer.Contains("gemini-3.1-flash-image") -or -not $renderer.Contains("x-goog-user-project") -or -not $renderer.Contains("GEOMETRY LOCK") -or $renderer.Contains("x-goog-api-key")) { throw "Direct Google renderer contract is incomplete or unsafe." }\n  if (-not $workspace.Contains("requestPointerLock") -or -not $workspace.Contains("REVEX_LIGHTWEIGHT_OBJECT_OUTLINES") -or -not $workspace.Contains("spatialObjectsVisible: false")) { throw "ACC-like Walk/lightweight workspace contract is incomplete." }\n  if (-not $firebaseLoader.Contains("reauthenticateWithPopup")) { throw "Shared Firebase auth loader is missing incremental Google OAuth support." }\n''' + workflow_read, 1)

# Ensure accepted >=80% gbXML cannot carry the stale fatal severity marker.
service_check = '  $external = ([IO.File]::ReadAllText($pythonPath, [Text.Encoding]::UTF8)).Replace("`r`n","`n").Replace("`r","`n")\n'
if 'accepted gbXML publication path does not reconcile strict geometry severity' not in s:
    if service_check not in s: raise SystemExit('gbXML external-engine read anchor missing')
    s = s.replace(service_check, service_check + '''  if (-not $external.Contains("reconcile_publication_message_severity(messages, publication_threshold_met)")) { throw "The accepted gbXML publication path does not reconcile strict geometry severity with the >=80% publication contract." }\n''', 1)

# Parse all new browser dependencies during release QA.
parse_review = '  Invoke-Native "Parse physical-model review controls" $Node @("--check", (Join-Path $StageSource "src\\Live-Companion\\review-integrity-r50.js"))\n'
if 'Parse direct Google renderer' not in s:
    if parse_review not in s: raise SystemExit('review parse anchor missing')
    s = s.replace(parse_review, parse_review + '''  Invoke-Native "Parse direct Google renderer" $Node @("--check", (Join-Path $StageSource "src\\Live-Companion\\render-agent.js"))\n  Invoke-Native "Parse ACC-like workspace runtime" $Node @("--check", (Join-Path $StageSource "src\\Live-Companion\\workspace-r51.js"))\n  Invoke-Native "Parse shared Firebase OAuth loader" $Node @("--check", (Join-Path $StageSource "docs\\liber-apps\\js\\firebase-loader.js"))\n''', 1)

# The shared Firebase loader now belongs to the immutable stage and must overwrite the clone.
pub_copy = '  Copy-SourceTree (Join-Path $StageSource "src\\Live-Companion") (Join-Path $RepoRoot "docs\\liber-apps\\apps\\revex")\n'
if 'Copy-Item -LiteralPath (Join-Path $StageSource "docs\\liber-apps\\js\\firebase-loader.js")' not in s:
    if pub_copy not in s: raise SystemExit('Companion publication copy anchor missing')
    s = s.replace(pub_copy, pub_copy + '''  New-Item -ItemType Directory -Path (Join-Path $RepoRoot "docs\\liber-apps\\js") -Force | Out-Null\n  Copy-Item -LiteralPath (Join-Path $StageSource "docs\\liber-apps\\js\\firebase-loader.js") -Destination (Join-Path $RepoRoot "docs\\liber-apps\\js\\firebase-loader.js") -Force\n''', 1)

# Live endpoint must prove the new renderer + Walk + OAuth loader, not only older review code.
live_review = '      $review = Invoke-WebRequest -UseBasicParsing -Uri ($base + "review-integrity-r50.js?r49_verify=" + $stamp) -TimeoutSec 20 -Headers $headers\n'
if '$workspace = Invoke-WebRequest' not in s:
    if live_review not in s: raise SystemExit('live review fetch anchor missing')
    s = s.replace(live_review, live_review + '''      $renderer = Invoke-WebRequest -UseBasicParsing -Uri ($base + "render-agent.js?r49_verify=" + $stamp) -TimeoutSec 20 -Headers $headers\n      $workspace = Invoke-WebRequest -UseBasicParsing -Uri ($base + "workspace-r51.js?r49_verify=" + $stamp) -TimeoutSec 20 -Headers $headers\n      $sharedBase = $base.Replace("/apps/revex/", "/js/")\n      $firebaseLoader = Invoke-WebRequest -UseBasicParsing -Uri ($sharedBase + "firebase-loader.js?r49_verify=" + $stamp) -TimeoutSec 20 -Headers $headers\n''', 1)
review_cond = '          $review.Content.Contains("spatialObjectsVisible: false") -and $review.Content.Contains("setSectionFace") -and $review.Content.Contains("commitBimOverlay") -and\n'
if '$renderer.Content.Contains("gemini-3.1-flash-image")' not in s:
    if review_cond not in s: raise SystemExit('live review condition anchor missing')
    s = s.replace(review_cond, review_cond + '''          $renderer.Content.Contains("gemini-3.1-flash-image") -and $renderer.Content.Contains("x-goog-user-project") -and $renderer.Content.Contains("GEOMETRY LOCK") -and\n          $workspace.Content.Contains("requestPointerLock") -and $workspace.Content.Contains("REVEX_LIGHTWEIGHT_OBJECT_OUTLINES") -and $workspace.Content.Contains("spatialObjectsVisible: false") -and\n          $firebaseLoader.Content.Contains("reauthenticateWithPopup") -and\n''', 1)
s = s.replace(
    'Live Companion verified: $Build with current paged geometry, physical-only review controls, reversible visibility, per-position versions and native Revit schedules.',
    'Live Companion verified: $Build with current paged geometry, physical-only review controls, direct Google renderer, ACC-like Walk and native Revit schedules.'
)

if 'sharedFirebaseOAuthLoader = $true' not in s:
    s = s.replace('    nativeSpecificationsCompatibility = $true\n    fullWorkerAndBrokerSourceTrees = $true', '    nativeSpecificationsCompatibility = $true\n    sharedFirebaseOAuthLoader = $true\n    fullWorkerAndBrokerSourceTrees = $true', 1)

# Final required contract.
for required in [
    '20260815r49-google-render-walk-v6',
    '70ab6594a0199ac5b1616fddcba32bc2a6860adb',
    'REVEX_R49_SOURCE_70ab6594a0199ac5b1616fddcba32bc2a6860adb.zip',
    '25aceb5d18d3a043372142207648daf3638a69a5f8f77781b8333dc29bb3195b',
    'Parse direct Google renderer', 'Parse ACC-like workspace runtime', 'Parse shared Firebase OAuth loader',
    'gemini-3.1-flash-image', 'REVEX_LIGHTWEIGHT_OBJECT_OUTLINES', 'reauthenticateWithPopup',
    'reconcile_publication_message_severity(messages, publication_threshold_met)'
]:
    if required not in s:
        raise SystemExit(f'final publisher contract missing: {required}')

P.write_text(s, encoding='utf-8')
print('REVEX publisher v6 staged successfully.')
