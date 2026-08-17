param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$SourceCandidate = "1b9940d533ab83882fdfb1de9eef3d67c233b0e2"
$Revision = "eng_20260817T032812010Z"
$Repo = "https://github.com/nvberegovykh/LIBER-Creative.git"
$Work = Join-Path $env:TEMP ("REVEX-R118-RECOVERY-" + [guid]::NewGuid().ToString("N"))
$Source = Join-Path $Work "source"
$ExitCode = 1

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required." }
  return $cmd.Source
}

function Invoke-Native([string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($Quiet) { & $Command @Arguments *> $null }
    else { & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) } }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [int]$code
  }
  finally { $ErrorActionPreference = $previous }
}

function Capture-Native([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $lines = @(& $Command @Arguments 2>$null | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ Code = [int]$code; Text = ($lines -join "`n").Trim() }
  }
  finally { $ErrorActionPreference = $previous }
}

try {
  Write-Host "REVEX r118 Energy recovery" -ForegroundColor Cyan
  Write-Host "Fixed source: $SourceCandidate"
  Write-Host "Preserved revision: $Revision"
  Write-Host "Scope: Energy worker + authenticated broker only. No Revit sync. No add-in replacement. No BIM/Docs/Render mutation." -ForegroundColor Green

  $Git = Require-Command "git"
  $GCloud = Require-Command "gcloud"
  $Firebase = Require-Command "firebase"
  $null = Require-Command "npm"

  $auth = Capture-Native $GCloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
  if ($auth.Code -ne 0 -or -not $auth.Text) {
    Write-Host "Google Cloud sign-in required once..." -ForegroundColor Yellow
    if ((Invoke-Native $GCloud @("auth", "login")) -ne 0) { throw "Google Cloud authentication failed." }
    $auth = Capture-Native $GCloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
    if ($auth.Code -ne 0 -or -not $auth.Text) { throw "Google Cloud authentication did not complete." }
  }
  Write-Host "Google Cloud: $($auth.Text.Split("`n")[0])" -ForegroundColor Green

  if ((Invoke-Native $Firebase @("projects:list", "--json") -Quiet) -ne 0) {
    Write-Host "Firebase sign-in required once..." -ForegroundColor Yellow
    if ((Invoke-Native $Firebase @("login", "--reauth")) -ne 0) { throw "Firebase authentication failed." }
    if ((Invoke-Native $Firebase @("projects:list", "--json") -Quiet) -ne 0) { throw "Firebase authentication did not complete." }
  }
  $env:REVEX_FIREBASE_AUTH_VERIFIED = "1"

  New-Item -ItemType Directory -Path $Work -Force | Out-Null
  if ((Invoke-Native $Git @("init", $Source) -Quiet) -ne 0) { throw "git init failed." }
  if ((Invoke-Native $Git @("-C", $Source, "remote", "add", "origin", $Repo) -Quiet) -ne 0) { throw "git remote failed." }

  Write-Host ">> Fetch exact fixed Energy source" -ForegroundColor DarkCyan
  if ((Invoke-Native $Git @("-C", $Source, "fetch", "--depth", "1", "origin", $SourceCandidate)) -ne 0) { throw "Exact fixed Energy source fetch failed." }
  if ((Invoke-Native $Git @("-C", $Source, "checkout", "--detach", "FETCH_HEAD") -Quiet) -ne 0) { throw "Exact fixed Energy checkout failed." }
  $checked = Capture-Native $Git @("-C", $Source, "rev-parse", "HEAD")
  if ($checked.Text.ToLowerInvariant() -ne $SourceCandidate) { throw "Exact-source checkout mismatch: $($checked.Text)" }

  $deploy = Join-Path $Source "server\revex-energy-worker\DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1"
  if (-not (Test-Path -LiteralPath $deploy -PathType Leaf)) { throw "Fixed Energy deployer is missing." }

  Write-Host ">> Deploy fixed Energy worker + broker" -ForegroundColor DarkCyan
  $code = Invoke-Native "powershell.exe" @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $deploy,
    "-ProjectId", $ProjectId,
    "-Region", $Region,
    "-SourceCandidate", $SourceCandidate,
    "-NoPause"
  )
  if ($code -ne 0) { throw "Fixed Energy deployment failed with exit code $code." }

  Write-Host "PASS: fixed r118 Energy worker + broker deployed." -ForegroundColor Green
  Write-Host "Retry ONLY $Revision. Do not Sync Engineering." -ForegroundColor Green
  Start-Process "https://liberpict.com/liber-apps/apps/revex/index.html?projectId=revex_mspgzb7h_729b2936bfaa&specProjectId=spec_revex_mspgzb7h_729b2936bfaa&view=energy"
  $ExitCode = 0
}
catch {
  Write-Host "REVEX r118 Energy recovery stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode = 1
}
finally {
  Remove-Item Env:REVEX_FIREBASE_AUTH_VERIFIED -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $Work) { try { Remove-Item -LiteralPath $Work -Recurse -Force } catch {} }
  Write-Host "Press Enter to close."
  [void](Read-Host)
}

exit $ExitCode
