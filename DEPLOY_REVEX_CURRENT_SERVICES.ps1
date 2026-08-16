param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [switch]$SkipEnergy,
  [switch]$SkipRender,
  [switch]$RenderBrokerOnly,
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
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $args = @("auth","list","--filter","status:ACTIVE","--format","value(account)")
    $output = @(& $GCloud @args 2>$null) | Where-Object { $_ }
    return ($LASTEXITCODE -eq 0 -and @($output).Count -gt 0)
  } catch { return $false } finally { $ErrorActionPreference = $previous }
}

function Invoke-NativeExitCode([string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($Quiet) { & $Command @Arguments *> $null } else { & $Command @Arguments }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [int]$code
  } catch { return 1 } finally { $ErrorActionPreference = $previous }
}

function Test-FirebaseAuth([string]$Firebase) {
  return ((Invoke-NativeExitCode $Firebase @("projects:list","--json") -Quiet) -eq 0)
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
  if ($SkipRender -and $RenderBrokerOnly) { throw "-SkipRender and -RenderBrokerOnly cannot be used together." }

  $GCloud = Require-Command "gcloud"
  if (-not (Test-GCloudAuth $GCloud)) {
    Write-Host ""
    Write-Host "Google Cloud authorization is required once. Opening Google sign-in..." -ForegroundColor Yellow
    if ((Invoke-NativeExitCode $GCloud @("auth","login")) -ne 0 -or -not (Test-GCloudAuth $GCloud)) {
      throw "Google Cloud authentication did not complete successfully."
    }
    Write-Host "Google Cloud authorization confirmed." -ForegroundColor Green
  }

  # Firebase CLI is required only by the Energy deployment. The render broker is
  # deployed through gcloud Cloud Functions v2, so touching firebase-tools during
  # broker-only resume is unnecessary and can trigger the Windows libuv crash.
  if (-not $SkipEnergy) {
    $Firebase = Require-Command "firebase"
    if (-not (Test-FirebaseAuth $Firebase)) {
      Write-Host ""
      Write-Host "Firebase authorization is required once. Opening Google sign-in; deployment will resume automatically after approval..." -ForegroundColor Yellow
      if ((Invoke-NativeExitCode $Firebase @("login","--reauth")) -ne 0 -or -not (Test-FirebaseAuth $Firebase)) {
        throw "Firebase authentication did not complete successfully."
      }
    }
    $env:REVEX_FIREBASE_AUTH_VERIFIED = "1"
    Write-Host "Firebase authorization confirmed for the Energy deployment chain." -ForegroundColor Green
  } else {
    Remove-Item Env:REVEX_FIREBASE_AUTH_VERIFIED -ErrorAction SilentlyContinue
    Write-Host "Firebase CLI skipped: Energy is not being deployed." -ForegroundColor Green
  }

  $env:CI = "1"

  if (-not $RenderBrokerOnly) {
    $artifactArgs = @("artifacts","repositories","describe","revex","--location",$Region,"--project",$ProjectId)
    if ((Invoke-NativeExitCode $GCloud $artifactArgs -Quiet) -eq 0) {
      $env:REVEX_ARTIFACT_REPOSITORY_VERIFIED = "1"
      Write-Host "Existing REVEX Artifact Registry repository confirmed; creation will be skipped." -ForegroundColor Green
    } else {
      $env:REVEX_ARTIFACT_REPOSITORY_VERIFIED = "0"
    }
  } else {
    Remove-Item Env:REVEX_ARTIFACT_REPOSITORY_VERIFIED -ErrorAction SilentlyContinue
    Write-Host "Artifact Registry probe skipped: broker-only resume does not build an image." -ForegroundColor Green
  }

  Write-Host "Refreshing Windows-safe REVEX deployment bootstrap from GitHub main..." -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $TempScript
  if (-not (Test-Path -LiteralPath $TempScript -PathType Leaf) -or (Get-Item -LiteralPath $TempScript).Length -lt 1000) {
    throw "Current REVEX deployment bootstrap could not be downloaded completely."
  }

  $args = @("-NoProfile","-ExecutionPolicy","Bypass","-File",$TempScript,"-ProjectId",$ProjectId,"-Region",$Region)
  if ($SkipEnergy) { $args += "-SkipEnergy" }
  if ($SkipRender) { $args += "-SkipRender" }
  if ($RenderBrokerOnly) { $args += "-RenderBrokerOnly" }
  if ($NoPause) { $args += "-NoPause" }

  $ExitCode = Invoke-NativeExitCode "powershell.exe" $args
  if ($ExitCode -ne 0) { throw "Current REVEX bootstrap exited with code $ExitCode." }

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
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
  if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    try { Copy-Item -LiteralPath $LogPath -Destination $LatestLogPath -Force } catch {}
  }
}

exit $ExitCode
