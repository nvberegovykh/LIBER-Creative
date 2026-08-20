param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Bucket = "",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Verifier = Join-Path $Root ".github\scripts\verify-revex-storage-access.js"
$Patcher = Join-Path $Root ".github\scripts\patch-live-storage-rules.js"
$Fragment = Join-Path $Root "firebase\revex-secure-chat-storage.rules"
$Work = Join-Path $env:TEMP ("REVEX-STORAGE-RULES-" + [guid]::NewGuid().ToString("N"))
$LivePath = Join-Path $Work "storage.live.rules"
$PatchedPath = Join-Path $Work "storage.rules"
$ExitCode = 1
$ReleaseName = ""
$PreviousRulesetName = ""
$ReleaseChanged = $false

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX Storage access deployment." }
  return $cmd.Source
}
function Invoke-Native([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory="") {
  $previous=$ErrorActionPreference
  try {
    $ErrorActionPreference="Continue"
    if($WorkingDirectory){Push-Location $WorkingDirectory}
    try { & $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)};$code=$LASTEXITCODE;if($null-eq $code){$code=0};return [int]$code }
    finally { if($WorkingDirectory){Pop-Location} }
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
function Api-Headers([string]$Token) {
  return @{Authorization="Bearer $Token";'x-goog-user-project'=$ProjectId}
}
function Get-StorageReleases([hashtable]$Headers) {
  $all=@();$pageToken=""
  do {
    $uri="https://firebaserules.googleapis.com/v1/projects/$ProjectId/releases?pageSize=100"
    if($pageToken){$uri += "&pageToken=$([uri]::EscapeDataString($pageToken))"}
    $page=Invoke-RestMethod -Method Get -Uri $uri -Headers $Headers -TimeoutSec 30
    $all += @($page.releases)
    $pageToken=if($page.PSObject.Properties.Name-contains 'nextPageToken'){[string]$page.nextPageToken}else{''}
  } while($pageToken)
  return @($all | Where-Object { [string]$_.name -match "/releases/firebase\.storage/" })
}
function Select-StorageRelease([object[]]$Releases) {
  if($Bucket){
    $expected="projects/$ProjectId/releases/firebase.storage/$Bucket"
    $selected=@($Releases | Where-Object { [string]$_.name -eq $expected })
    if($selected.Count-ne 1){throw "No unique live Storage release exists for bucket $Bucket."}
    return $selected[0]
  }
  if($Releases.Count-ne 1){
    $names=@($Releases|ForEach-Object{[string]$_.name})-join ', '
    throw "Expected exactly one live Storage release; found $($Releases.Count). Pass -Bucket explicitly. Releases: $names"
  }
  return $Releases[0]
}
function Get-RulesSource([hashtable]$Headers,[string]$RulesetName) {
  if(-not $RulesetName.StartsWith("projects/$ProjectId/rulesets/")){throw "Storage release returned an invalid ruleset name."}
  $ruleset=Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/"+$RulesetName) -Headers $Headers -TimeoutSec 30
  $files=@($ruleset.source.files)
  if($files.Count-ne 1){throw "The active Storage ruleset has $($files.Count) source files; refusing a non-deterministic patch."}
  return [string]$files[0].content
}
function Assert-StorageContract([string]$Source,[string]$ExpectedSha="") {
  foreach($marker in @(
    'REVEX_SECURE_STORAGE_ACCESS_BEGIN','REVEX_SECURE_STORAGE_ACCESS_END',
    'function revexStorageProjectMember(projectId)','function revexStorageChatParticipant(connId)',
    'match /projects/{projectId}/{projectObject=**}','match /chat/{connId}/{chatObject=**}',
    'match /stickers/{uid}/{stickerObject=**}'
  )){if(-not $Source.Contains($marker)){throw "Live Storage access contract is missing: $marker"}}
  if($ExpectedSha-and-not $Source.Contains("REVEX_SOURCE_CANDIDATE=$ExpectedSha")){throw "Live Storage rules are not source-bound to this release."}
}
function Set-ReleaseRuleset([hashtable]$Headers,[string]$Name,[string]$RulesetName) {
  $body=@{release=@{name=$Name;rulesetName=$RulesetName};updateMask='rulesetName'}|ConvertTo-Json -Depth 8
  return Invoke-RestMethod -Method Patch -Uri ("https://firebaserules.googleapis.com/v1/"+$Name) -Headers $Headers -ContentType 'application/json' -Body $body -TimeoutSec 30
}

try {
  Write-Host 'REVEX current Storage-access deployment' -ForegroundColor Cyan
  Write-Host "Source: $SourceCandidate"
  Write-Host 'Scope: preserve the exact live Storage ruleset and replace only the marked REVEX/Secure Chat block.' -ForegroundColor Green
  foreach($required in @($Verifier,$Patcher,$Fragment)){if(-not(Test-Path -LiteralPath $required -PathType Leaf)){throw "Storage deployment source is incomplete: $required"}}
  New-Item -ItemType Directory -Path $Work -Force|Out-Null
  $GCloud=Require-Command 'gcloud';$Node=Require-Command 'node'
  if((Invoke-Native $Node @($Verifier) $Root)-ne 0){throw 'REVEX Storage access verification failed.'}
  if((Invoke-Native $GCloud @('services','enable','firebaserules.googleapis.com','--project',$ProjectId))-ne 0){throw 'Firebase Rules API could not be enabled.'}
  $token=Capture-Native $GCloud @('auth','print-access-token')
  if($token.Code-ne 0-or-not $token.Text){throw 'Google Cloud administrator sign-in is required before Storage rules deployment.'}
  $headers=Api-Headers ($token.Text.Trim())
  $release=Select-StorageRelease (Get-StorageReleases $headers)
  $ReleaseName=[string]$release.name
  $PreviousRulesetName=[string]$release.rulesetName
  $live=Get-RulesSource $headers $PreviousRulesetName
  [IO.File]::WriteAllText($LivePath,$live,[Text.UTF8Encoding]::new($false))
  if((Invoke-Native $Node @($Patcher,$LivePath,$Fragment,$PatchedPath) $Root)-ne 0){throw 'Preserved Storage rules could not be patched.'}
  $patched=[IO.File]::ReadAllText($PatchedPath,[Text.Encoding]::UTF8)
  $sourceLine=" * REVEX_SOURCE_CANDIDATE=$SourceCandidate"
  $patched=[regex]::Replace($patched,'(/\*\s*REVEX_SECURE_STORAGE_ACCESS_BEGIN[^\r\n]*)(\r?\n)',("`$1`$2"+$sourceLine+"`n"),1)
  Assert-StorageContract $patched $SourceCandidate
  [IO.File]::WriteAllText($PatchedPath,$patched,[Text.UTF8Encoding]::new($false))
  if($live.Contains("REVEX_SOURCE_CANDIDATE=$SourceCandidate")){
    Assert-StorageContract $live $SourceCandidate
    Write-Host "PASS: live Storage rules already match $SourceCandidate." -ForegroundColor Green
    $ExitCode=0;return
  }

  $createBody=@{source=@{files=@(@{name='storage.rules';content=$patched})}}|ConvertTo-Json -Depth 12
  $created=Invoke-RestMethod -Method Post -Uri "https://firebaserules.googleapis.com/v1/projects/$ProjectId/rulesets" -Headers $headers -ContentType 'application/json' -Body $createBody -TimeoutSec 60
  $newRulesetName=[string]$created.name
  if(-not $newRulesetName.StartsWith("projects/$ProjectId/rulesets/")){throw 'Firebase Rules API did not create a valid Storage ruleset.'}
  $null=Set-ReleaseRuleset $headers $ReleaseName $newRulesetName
  $ReleaseChanged=$true

  $verifiedRelease=Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/"+$ReleaseName) -Headers $headers -TimeoutSec 30
  if([string]$verifiedRelease.rulesetName-ne $newRulesetName){throw 'Storage release did not bind the newly validated ruleset.'}
  $verified=Get-RulesSource $headers $newRulesetName
  Assert-StorageContract $verified $SourceCandidate
  Write-Host "PASS: Storage access is live, source-bound and preserves every unrelated rule for $ReleaseName." -ForegroundColor Green
  $ExitCode=0
} catch {
  Write-Host "REVEX current Storage deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  if($ReleaseChanged-and$ReleaseName-and$PreviousRulesetName){
    try{
      $token=Capture-Native $GCloud @('auth','print-access-token')
      if($token.Code-eq 0-and$token.Text){$headers=Api-Headers ($token.Text.Trim());$null=Set-ReleaseRuleset $headers $ReleaseName $PreviousRulesetName;Write-Host 'Previous Storage ruleset restored.' -ForegroundColor Yellow}
    }catch{Write-Host "WARNING: automatic Storage rules rollback failed: $($_.Exception.Message)" -ForegroundColor Red}
  }
  $ExitCode=1
} finally {
  if(Test-Path -LiteralPath $Work){Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue}
  if(-not $NoPause-and $Host.Name-match 'ConsoleHost'){Write-Host 'Press Enter to close.';[void](Read-Host)}
}
exit $ExitCode
