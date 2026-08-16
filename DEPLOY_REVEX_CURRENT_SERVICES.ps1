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

try {
  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
  } catch {
    Write-Warning "Could not start persistent transcript at $LogPath : $($_.Exception.Message)"
  }

  Write-Host "REVEX current managed-services launcher" -ForegroundColor Cyan
  Write-Host "Persistent log: $LogPath"
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
