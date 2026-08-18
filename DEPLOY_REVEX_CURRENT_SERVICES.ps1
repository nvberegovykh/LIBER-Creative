param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [switch]$SkipReport,
  [switch]$SkipRender,
  [switch]$ValidateOnly,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $PSScriptRoot ("DEPLOY_REVEX_CURRENT_SERVICES." + $Stamp + ".log")
$LatestLogPath = Join-Path $PSScriptRoot "DEPLOY_REVEX_CURRENT_SERVICES.latest.log"
$TempScript = Join-Path ([IO.Path]::GetTempPath()) ("REVEX-CURRENT-BOOTSTRAP-" + [guid]::NewGuid().ToString("N") + ".ps1")
$BootstrapUri = "https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/DEPLOY_REVEX_CURRENT_SERVICES_BOOTSTRAP.ps1"
$TranscriptStarted = $false
$ExitCode = 1

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX current-service deployment." }
  return $cmd.Source
}

function Invoke-NativeExitCode([string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($Quiet) { & $Command @Arguments *> $null }
    else { & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) } }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [int]$code
  }
  catch { return 1 }
  finally { $ErrorActionPreference = $previous }
}

function Test-GCloudAuth([string]$GCloud) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $authArgs = @("auth", "list", "--filter", "status:ACTIVE", "--format", "value(account)")
    $output = @(& $GCloud @authArgs 2>$null) | Where-Object { $_ }
    return ($LASTEXITCODE -eq 0 -and @($output).Count -gt 0)
  }
  catch { return $false }
  finally { $ErrorActionPreference = $previous }
}

try {
  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
  }
  catch {
    Write-Warning "Could not start persistent transcript at $LogPath : $($_.Exception.Message)"
  }

  Write-Host "REVEX current r126 managed-services launcher" -ForegroundColor Cyan
  Write-Host "Persistent log: $LogPath"
  Write-Host "Scope: current-main r126 Report + warm Render only." -ForegroundColor Green
  Write-Host "Protected: Energy worker, Energy broker, Engineering revisions, and project data are not changed by this launcher." -ForegroundColor Green

  if ($SkipReport -and $SkipRender -and -not $ValidateOnly) {
    throw "Both Report and Render were skipped; nothing was requested for deployment."
  }

  $GCloud = Require-Command "gcloud"
  if (-not $ValidateOnly -and -not (Test-GCloudAuth $GCloud)) {
    Write-Host ""
    Write-Host "Google Cloud authorization is required once. Opening Google sign-in..." -ForegroundColor Yellow
    if ((Invoke-NativeExitCode $GCloud @("auth", "login")) -ne 0 -or -not (Test-GCloudAuth $GCloud)) {
      throw "Google Cloud authentication did not complete successfully."
    }
    Write-Host "Google Cloud authorization confirmed." -ForegroundColor Green
  }

  Write-Host "Refreshing the current-main deployment bootstrap..." -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing -Uri $BootstrapUri -OutFile $TempScript
  if (-not (Test-Path -LiteralPath $TempScript -PathType Leaf) -or (Get-Item -LiteralPath $TempScript).Length -lt 1000) {
    throw "Current REVEX deployment bootstrap could not be downloaded completely."
  }

  $args = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $TempScript,
    "-ProjectId", $ProjectId, "-Region", $Region
  )
  if ($SkipReport) { $args += "-SkipReport" }
  if ($SkipRender) { $args += "-SkipRender" }
  if ($ValidateOnly) { $args += "-ValidateOnly" }
  if ($NoPause) { $args += "-NoPause" }

  $ExitCode = Invoke-NativeExitCode "powershell.exe" $args
  if ($ExitCode -ne 0) { throw "Current REVEX r126 bootstrap exited with code $ExitCode." }

  Write-Host ""
  if ($ValidateOnly) {
    Write-Host "PASS: current r126 deployment chain validated; no cloud service was changed." -ForegroundColor Green
  }
  else {
    Write-Host "PASS: current r126 Report/Render deployment launcher completed." -ForegroundColor Green
    Write-Host "Energy remained untouched by contract." -ForegroundColor Green
  }
  $ExitCode = 0
}
catch {
  Write-Host ""
  Write-Host "REVEX current r126 managed-services launcher stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Persistent log: $LogPath" -ForegroundColor Yellow
  $ExitCode = 1
}
finally {
  Remove-Item -LiteralPath $TempScript -Force -ErrorAction SilentlyContinue
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
  if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    try { Copy-Item -LiteralPath $LogPath -Destination $LatestLogPath -Force } catch {}
  }
}

exit $ExitCode
