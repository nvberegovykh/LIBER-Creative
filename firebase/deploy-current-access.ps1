param(
  [string]$ProjectId = "liber-apps-cca20",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Verifier = Join-Path $Root ".github\scripts\verify-revex-current-release.py"
$Patcher = Join-Path $Root ".github\scripts\patch-live-firestore-rules.js"
$Fragment = Join-Path $Root "firebase\revex-project-access-r43.rules"
$Work = Join-Path $env:TEMP ("REVEX-RULES-" + [guid]::NewGuid().ToString("N"))
$LivePath = Join-Path $Work "firestore.live.rules"
$PatchedPath = Join-Path $Work "firestore.rules"
$ConfigPath = Join-Path $Work "firebase.json"
$ExitCode = 1

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX access deployment." }
  return $cmd.Source
}
function Invoke-Native([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory="",[switch]$Quiet) {
  $previous=$ErrorActionPreference
  try {
    $ErrorActionPreference="Continue"
    if($WorkingDirectory){Push-Location $WorkingDirectory}
    try {
      if($Quiet){& $Command @Arguments *> $null}else{& $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)}}
      $code=$LASTEXITCODE;if($null-eq $code){$code=0};return [int]$code
    } finally { if($WorkingDirectory){Pop-Location} }
  } finally { $ErrorActionPreference=$previous }
}
function Capture-Native([string]$Command,[string[]]$Arguments) {
  $previous=$ErrorActionPreference
  try {
    $ErrorActionPreference="Continue"
    $lines=@(& $Command @Arguments 2>$null|ForEach-Object{[string]$_})
    $code=$LASTEXITCODE;if($null-eq $code){$code=0}
    return [pscustomobject]@{Code=[int]$code;Text=($lines-join "`n").Trim()}
  } finally { $ErrorActionPreference=$previous }
}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments,[string]$WorkingDirectory="") {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code=Invoke-Native $Command $Arguments $WorkingDirectory
  if($code-ne 0){throw "$Label failed with exit code $code."}
}
function Get-LiveRules([string]$GCloud) {
  $token = Capture-Native $GCloud @('auth','print-access-token')
  if($token.Code-ne 0-or-not $token.Text){throw 'Google Cloud could not issue an access token for Firestore rules verification.'}
  $headers=@{Authorization="Bearer $($token.Text.Trim())";'x-goog-user-project'=$ProjectId}
  $release=Invoke-RestMethod -Method Get -Uri "https://firebaserules.googleapis.com/v1/projects/$ProjectId/releases/cloud.firestore" -Headers $headers -TimeoutSec 30
  $rulesetName=[string]$release.rulesetName
  if(-not $rulesetName.StartsWith("projects/$ProjectId/rulesets/")){throw 'The live Firestore release did not identify its active ruleset.'}
  $ruleset=Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/"+$rulesetName) -Headers $headers -TimeoutSec 30
  $files=@($ruleset.source.files)
  if($files.Count-ne 1){throw "The active Firestore ruleset has $($files.Count) source files; refusing a non-deterministic patch."}
  return [string]$files[0].content
}
function Assert-AccessContract([string]$Source,[string]$ExpectedSha="") {
  foreach($marker in @(
    'REVEX_PROJECT_ACCESS_R43_BEGIN',
    'REVEX_PROJECT_ACCESS_R43_END',
    'function revexR43ProjectMember(projectId)',
    'function revexR43ImmutableProjectLane(projectCollection)',
    'immutableRevisionUpdateDeleteDenied',
    'function revexR43SpecMember(specProjectId)',
    'allow read, write: if revexR43SpecMember(specProjectId);'
  )) { if(-not $Source.Contains($marker)){throw "Live REVEX access contract is missing: $marker"} }
  if($ExpectedSha-and-not $Source.Contains("REVEX_SOURCE_CANDIDATE=$ExpectedSha")){throw 'Live Firestore access rules are not source-bound to this release.'}
}

try {
  Write-Host 'REVEX current project-access deployment' -ForegroundColor Cyan
  Write-Host "Source: $SourceCandidate"
  Write-Host 'Scope: preserve the live ruleset; replace only the marked REVEX owner/member/admin block.' -ForegroundColor Green
  foreach($required in @($Verifier,$Patcher,$Fragment)){if(-not(Test-Path -LiteralPath $required -PathType Leaf)){throw "Access deployment source is incomplete: $required"}}
  New-Item -ItemType Directory -Path $Work -Force|Out-Null

  $GCloud=Require-Command 'gcloud';$Firebase=Require-Command 'firebase';$Node=Require-Command 'node';$Python=Require-Command 'python'
  Require-Ok 'Validate full current REVEX revision before Firestore rules changes' $Python @($Verifier) $Root
  $auth=Capture-Native $GCloud @('auth','list','--filter','status:ACTIVE','--format','value(account)')
  if($auth.Code-ne 0-or-not $auth.Text){throw 'Google Cloud administrator sign-in is required before access deployment.'}
  if((Invoke-Native $Firebase @('projects:list','--json') -Quiet)-ne 0){throw 'Firebase administrator sign-in is required before access deployment.'}
  Require-Ok 'Enable Firebase Rules API' $GCloud @('services','enable','firebaserules.googleapis.com','--project',$ProjectId)

  $live=Get-LiveRules $GCloud
  [IO.File]::WriteAllText($LivePath,$live,[Text.UTF8Encoding]::new($false))
  Require-Ok 'Patch only the REVEX project-access block into preserved live rules' $Node @($Patcher,$LivePath,$Fragment,$PatchedPath) $Root
  $patched=[IO.File]::ReadAllText($PatchedPath,[Text.Encoding]::UTF8)
  $sourceLine=" * REVEX_SOURCE_CANDIDATE=$SourceCandidate"
  $patched=[regex]::Replace($patched,'(/\*\s*REVEX_PROJECT_ACCESS_R43_BEGIN[^\r\n]*)(\r?\n)',("`$1`$2"+$sourceLine+"`n"),1)
  Assert-AccessContract $patched $SourceCandidate
  [IO.File]::WriteAllText($PatchedPath,$patched,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($ConfigPath,'{"firestore":{"rules":"firestore.rules"}}',[Text.UTF8Encoding]::new($false))

  if($live.Contains("REVEX_SOURCE_CANDIDATE=$SourceCandidate")){
    Assert-AccessContract $live $SourceCandidate
    Write-Host 'PASS: live Firestore access rules already match this exact release source.' -ForegroundColor Green
    $ExitCode=0
    return
  }

  Require-Ok 'Deploy preserved live Firestore rules with current REVEX access block' $Firebase @('deploy','--only','firestore:rules','--project',$ProjectId,'--config',$ConfigPath,'--force','--non-interactive') $Work
  $verified=Get-LiveRules $GCloud
  Assert-AccessContract $verified $SourceCandidate
  Write-Host 'PASS: project/member/admin Firestore access is live and source-bound; unrelated rules were preserved.' -ForegroundColor Green
  $ExitCode=0
} catch {
  Write-Host "REVEX current access deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode=1
} finally {
  if(Test-Path -LiteralPath $Work){Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue}
  if(-not $NoPause-and $Host.Name-match 'ConsoleHost'){Write-Host 'Press Enter to close.';[void](Read-Host)}
}
exit $ExitCode
