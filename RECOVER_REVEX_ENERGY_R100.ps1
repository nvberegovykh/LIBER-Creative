param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Service = "revex-energy-worker"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$TargetSha = "70635e2955f2341e1c72351917cf18d4955799c2"
$RepoUrl = "https://github.com/nvberegovykh/LIBER-Creative.git"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\Logs"
$LogPath = Join-Path $LogRoot ("RECOVER_REVEX_ENERGY_R100." + $Stamp + ".log")
$LatestLogPath = Join-Path $LogRoot "RECOVER_REVEX_ENERGY_CURRENT.latest.log"
$TempRoot = Join-Path $env:TEMP ("revex-r100-worker-" + $TargetSha.Substring(0,12) + "-" + [guid]::NewGuid().ToString("N"))
$TranscriptStarted = $false
$ExitCode = 1

New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null

function Require-Command([string[]]$Names, [string]$Purpose) {
  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
  }
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}

function Invoke-Capture([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $lines = @()
  $code = 1
  try {
    $ErrorActionPreference = "Continue"
    $lines = @(& $Command @Arguments 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ([int]$code -ne 0) {
    $tail = ($lines | Select-Object -Last 30) -join [Environment]::NewLine
    throw "Command failed with exit code ${code}: $Command $($Arguments -join ' ')`n$tail"
  }
  return ($lines -join [Environment]::NewLine).Trim()
}

function Invoke-Visible([string]$Label, [string]$Command, [string[]]$Arguments) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  Write-Host "   $Command $($Arguments -join ' ')" -ForegroundColor DarkGray
  $previous = $ErrorActionPreference
  $code = 1
  try {
    $ErrorActionPreference = "Continue"
    & $Command @Arguments
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ([int]$code -ne 0) { throw "$Label failed with exit code $code." }
}

function Read-Env([object]$State, [string]$Name) {
  foreach ($row in @($State.spec.template.spec.containers[0].env)) {
    if ([string]$row.name -eq $Name) { return [string]$row.value }
  }
  return ""
}

try {
  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
  } catch {}

  Write-Host "REVEX r100 Energy Recovery" -ForegroundColor Cyan
  Write-Host "Exact QA-green worker source: $TargetSha"
  Write-Host "Scope: Energy worker only. No Revit export. No broker deployment. No renderer. No add-in replacement."
  Write-Host "Log: $LogPath"
  Write-Host ""

  $Git = Require-Command @("git.exe", "git") "Git"
  $GCloud = Require-Command @("gcloud.cmd", "gcloud.exe", "gcloud.ps1", "gcloud") "Google Cloud CLI"

  Write-Host ">> Checking Google Cloud administrator session" -ForegroundColor DarkCyan
  $active = Invoke-Capture $GCloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
  if (-not $active.Trim()) { throw "Google Cloud authentication is missing. Run 'gcloud auth login' once, then rerun this same file." }
  Write-Host "   active account = $(($active -split "`r?`n")[0])"

  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
  Invoke-Visible "Initialize exact temporary checkout" $Git @("-C", $TempRoot, "init", "--quiet")
  Invoke-Visible "Bind LIBER-Creative origin" $Git @("-C", $TempRoot, "remote", "add", "origin", $RepoUrl)
  Invoke-Visible "Fetch exact r100 source" $Git @("-C", $TempRoot, "fetch", "--depth=1", "origin", $TargetSha)
  Invoke-Visible "Checkout exact r100 source" $Git @("-C", $TempRoot, "checkout", "--detach", "--quiet", "FETCH_HEAD")
  $checked = (Invoke-Capture $Git @("-C", $TempRoot, "rev-parse", "HEAD")).Trim().ToLowerInvariant()
  if ($checked -ne $TargetSha) { throw "Exact source checkout mismatch: expected $TargetSha, got $checked." }

  $Deploy = Join-Path $TempRoot "server\revex-energy-worker\DEPLOY_ENERGY_WORKER_ONLY_R69.ps1"
  if (-not (Test-Path -LiteralPath $Deploy -PathType Leaf)) { throw "Exact r100 source has no canonical worker-only deployment script." }

  Write-Host ""
  Invoke-Visible "Build and deploy exact r100 Energy worker" "powershell.exe" @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Deploy,
    "-ProjectId", $ProjectId, "-Region", $Region, "-Service", $Service,
    "-SourceCandidate", $TargetSha, "-NoPause"
  )

  Write-Host ""
  Write-Host ">> Verifying live immutable worker identity" -ForegroundColor DarkCyan
  $stateText = Invoke-Capture $GCloud @("run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")
  $state = $stateText | ConvertFrom-Json
  $ready = @($state.status.conditions | Where-Object { [string]$_.type -eq "Ready" } | Select-Object -First 1)
  if ($ready.Count -eq 0 -or [string]$ready[0].status -ne "True") { throw "Energy worker is not Ready after exact r100 deployment." }
  $liveSource = Read-Env $state "REVEX_SOURCE_CANDIDATE"
  $vertexProject = Read-Env $state "REVEX_VERTEX_PROJECT"
  $vertexLocation = Read-Env $state "REVEX_VERTEX_LOCATION"
  if ($liveSource -ne $TargetSha) { throw "Live worker source mismatch: expected $TargetSha, got $liveSource." }
  if ($vertexProject -ne $ProjectId) { throw "Live worker Vertex project mismatch: expected $ProjectId, got $vertexProject." }
  if ($vertexLocation -ne "global") { throw "Live worker Vertex location mismatch: expected global, got $vertexLocation." }

  Write-Host ""
  Write-Host "PASS: LIVE REVEX ENERGY WORKER IS EXACT r100." -ForegroundColor Green
  Write-Host "Source: $liveSource"
  Write-Host "Vertex: $vertexProject / $vertexLocation"
  Write-Host "The existing immutable Engineering revision is reusable. Do NOT run SYNC ENGINEERING again." -ForegroundColor Green
  $ExitCode = 0
} catch {
  Write-Host ""
  Write-Host "REVEX r100 RECOVERY FAILED" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Log: $LogPath" -ForegroundColor Yellow
  $ExitCode = 1
} finally {
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
  if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    try { Copy-Item -LiteralPath $LogPath -Destination $LatestLogPath -Force } catch {}
  }
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

exit $ExitCode
