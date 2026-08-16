param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [switch]$SkipEnergy,
  [switch]$SkipRender,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("REVEX-CURRENT-DEPLOY-" + [guid]::NewGuid().ToString('N'))
$RepoUrl = "https://github.com/nvberegovykh/LIBER-Creative.git"

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for the one-time managed deployment." }
  return $cmd.Source
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
}

try {
  Write-Host "REVEX current managed-services deployment" -ForegroundColor Cyan
  Write-Host "Authority: fresh GitHub main clone -> exact commit -> private managed workers"
  Write-Host "Legacy PUBLISH_REVEX_R49 source restoration is not used."

  $Git = Require-Command "git"
  $GCloud = Require-Command "gcloud"
  $Firebase = Require-Command "firebase"
  $Npm = Require-Command "npm"
  $Node = Require-Command "node"

  $active = @(& $GCloud @("auth","list","--filter=status:ACTIVE","--format=value(account)")) | Where-Object { $_ }
  if ($LASTEXITCODE -ne 0 -or $active.Count -eq 0) {
    throw "Google Cloud administrator authentication is the only required admin action. Run 'gcloud auth login' once, then rerun this file. Nothing was deployed."
  }
  & $Firebase projects:list --json *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Firebase administrator authentication is the only other required admin action. Run 'firebase login' once, then rerun this file. Nothing was deployed."
  }

  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
  Invoke-Checked "Clone current LIBER-Creative main without Drive/stale publisher state" $Git @(
    "clone","--depth","1","--branch","main","--single-branch",$RepoUrl,$TempRoot
  )
  $SourceCandidate = (& $Git -C $TempRoot rev-parse HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $SourceCandidate -notmatch '^[0-9a-f]{40}$') {
    throw "Fresh current-main clone did not produce an exact commit SHA."
  }
  Write-Host "Current source candidate: $SourceCandidate" -ForegroundColor Green

  Invoke-Checked "Reject stale REVEX generation before any deployment" $Node @(
    (Join-Path $TempRoot ".github\scripts\verify-revex-current-generation-r53.js")
  ) $TempRoot
  $R54Guard = Join-Path $TempRoot ".github\scripts\verify-revex-r54-selfhost-render.js"
  if (Test-Path -LiteralPath $R54Guard -PathType Leaf) {
    Invoke-Checked "Verify renderer + Energy + BIM viewer integration" $Node @($R54Guard) $TempRoot
  }

  if (-not $SkipEnergy) {
    $EnergyDeploy = Join-Path $TempRoot "server\revex-energy-worker\DEPLOY_ENERGY_CURRENT.ps1"
    if (-not (Test-Path -LiteralPath $EnergyDeploy -PathType Leaf)) {
      throw "Current main does not contain DEPLOY_ENERGY_CURRENT.ps1; deployment stopped rather than falling back to a stale Energy publisher."
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $EnergyDeploy `
      -ProjectId $ProjectId -Region $Region -SourceCandidate $SourceCandidate -NoPause
    if ($LASTEXITCODE -ne 0) { throw "Current managed Energy deployment failed with exit code $LASTEXITCODE." }
  }

  if (-not $SkipRender) {
    $RenderDeploy = Join-Path $TempRoot "server\revex-render-worker\DEPLOY_RENDER_SERVER.ps1"
    if (-not (Test-Path -LiteralPath $RenderDeploy -PathType Leaf)) {
      throw "Current main does not contain the private renderer deployment."
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RenderDeploy `
      -ProjectId $ProjectId -Region $Region -NoPause
    if ($LASTEXITCODE -ne 0) {
      throw "Energy may already be current, but the private GPU renderer deployment failed with exit code $LASTEXITCODE. Read the immediately preceding GPU/quota error; do not rerun the legacy publisher."
    }
  }

  Write-Host ""
  Write-Host "PASS: current REVEX managed services deployed from exact main $SourceCandidate." -ForegroundColor Green
  Write-Host "End users keep the normal LIBER sign-in; the public Qwen model requires no Hugging Face login/token."
} catch {
  Write-Host ""
  Write-Host "REVEX current managed-services deployment stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  if (Test-Path -LiteralPath $TempRoot) {
    try { Remove-Item -LiteralPath $TempRoot -Recurse -Force } catch { Write-Warning "Temporary clean clone remains at $TempRoot" }
  }
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') { Write-Host "" }
}
