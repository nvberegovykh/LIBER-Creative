param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [switch]$SkipEnergy,
  [switch]$SkipRender,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $PSScriptRoot ("DEPLOY_REVEX_CURRENT_SERVICES." + $Stamp + ".log")
$LatestLogPath = Join-Path $PSScriptRoot "DEPLOY_REVEX_CURRENT_SERVICES.latest.log"
$TempScript = Join-Path ([IO.Path]::GetTempPath()) ("REVEX-CURRENT-BOOTSTRAP-" + [guid]::NewGuid().ToString("N") + ".ps1")
$Uri = "https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/DEPLOY_REVEX_CURRENT_SERVICES_BOOTSTRAP.ps1"
$TranscriptStarted = $false
$ExitCode = 1

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX managed deployment." }
  return $cmd.Source
}

function Test-GCloudAuth([string]$GCloud) {
  $args = @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  $output = @(& $GCloud @args 2>$null) | Where-Object { $_ }
  return ($LASTEXITCODE -eq 0 -and @($output).Count -gt 0)
}

function Test-FirebaseAuth([string]$Firebase) {
  & $Firebase projects:list --json *> $null
  return ($LASTEXITCODE -eq 0)
}

try {
  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
  } catch {
    Write-Warning "Could not start persistent transcript at $LogPath : $($_.Exception.Message)"
  }

  Write-Host "REVEX current managed-services launcher" -ForegroundColor Cyan
  Write-Host "Persistent log: $LogPath"

  $GCloud = Require-Command "gcloud"
  $Firebase = Require-Command "firebase"

  if (-not (Test-GCloudAuth $GCloud)) {
    Write-Host ""
    Write-Host "Google Cloud authorization is required once. Opening Google sign-in..." -ForegroundColor Yellow
    & $GCloud auth login
    if ($LASTEXITCODE -ne 0 -or -not (Test-GCloudAuth $GCloud)) {
      throw "Google Cloud authentication did not complete successfully."
    }
    Write-Host "Google Cloud authorization confirmed." -ForegroundColor Green
  }

  if (-not (Test-FirebaseAuth $Firebase)) {
    Write-Host ""
    Write-Host "Firebase authorization is required once. Opening Google sign-in; deployment will resume automatically after approval..." -ForegroundColor Yellow
    & $Firebase login --reauth
    if ($LASTEXITCODE -ne 0 -or -not (Test-FirebaseAuth $Firebase)) {
      throw "Firebase authentication did not complete successfully."
    }
    Write-Host "Firebase authorization confirmed." -ForegroundColor Green
  }

  Write-Host "Refreshing Windows-safe REVEX deployment bootstrap from GitHub main..." -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $TempScript
  if (-not (Test-Path -LiteralPath $TempScript -PathType Leaf) -or (Get-Item -LiteralPath $TempScript).Length -lt 1000) {
    throw "Current REVEX deployment bootstrap could not be downloaded completely."
  }

  $args = @("-NoProfile","-ExecutionPolicy","Bypass","-File",$TempScript,"-ProjectId",$ProjectId,"-Region",$Region)
  if ($SkipEnergy) { $args += "-SkipEnergy" }
  if ($SkipRender) { $args += "-SkipRender" }
  if ($NoPause) { $args += "-NoPause" }

  & powershell.exe @args
  $ExitCode = $LASTEXITCODE
  if ($ExitCode -ne 0) {
    throw "Current REVEX bootstrap exited with code $ExitCode."
  }

  Write-Host ""
  Write-Host "PASS: REVEX current managed-services launcher completed." -ForegroundColor Green
  $ExitCode = 0
}
catch {
  Write-Host ""
  Write-Host "REVEX current managed-services launcher stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Persistent log: $LogPath" -ForegroundColor Yellow
  $ExitCode = 1
}
finally {
  Remove-Item -LiteralPath $TempScript -Force -ErrorAction SilentlyContinue
  if ($TranscriptStarted) {
    try { Stop-Transcript | Out-Null } catch {}
  }
  if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    try { Copy-Item -LiteralPath $LogPath -Destination $LatestLogPath -Force } catch {}
  }
}

exit $ExitCode
