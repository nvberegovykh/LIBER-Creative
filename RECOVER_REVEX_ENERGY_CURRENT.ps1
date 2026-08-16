param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\Logs"
$LogPath = Join-Path $LogRoot ("RECOVER_REVEX_ENERGY_CURRENT." + $Stamp + ".log")
$LatestLogPath = Join-Path $LogRoot "RECOVER_REVEX_ENERGY_CURRENT.latest.log"
$DeployScript = Join-Path $env:TEMP ("REVEX-ENERGY-DEPLOY-" + [guid]::NewGuid().ToString("N") + ".ps1")
$UpdateScript = Join-Path $env:TEMP ("REVEX-ADDIN-UPDATE-" + [guid]::NewGuid().ToString("N") + ".ps1")
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
$Service = "revex-energy-worker"
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

function Invoke-Native([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [int]$code
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Invoke-Capture([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $lines = @(& $Command @Arguments 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    if ([int]$code -ne 0) { throw "Command failed with exit code $code: $Command $($Arguments -join ' ')" }
    return ($lines -join [Environment]::NewLine).Trim()
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Read-WorkerEnv([object]$Worker, [string]$Name) {
  try {
    $row = @($Worker.spec.template.spec.containers[0].env | Where-Object { [string]$_.name -eq $Name } | Select-Object -First 1)
    if ($row.Count -gt 0) { return [string]$row[0].value }
  } catch {}
  return ""
}

try {
  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
  } catch {}

  Write-Host "REVEX Energy single-shot recovery" -ForegroundColor Cyan
  Write-Host "Log: $LogPath"
  Write-Host "Scope: current Energy worker + broker, exact broker/worker IAM verification, then current add-in only. Renderer is untouched."

  $GCloud = Require-Command @("gcloud.cmd", "gcloud.exe", "gcloud") "Google Cloud CLI"
  $Git = Require-Command @("git.exe", "git") "Git"

  $mainLine = Invoke-Capture $Git @("ls-remote", "https://github.com/nvberegovykh/LIBER-Creative.git", "refs/heads/main")
  $MainSha = (($mainLine -split "\s+")[0]).Trim().ToLowerInvariant()
  if ($MainSha -notmatch '^[0-9a-f]{40}$') { throw "GitHub main did not resolve to an exact SHA." }
  Write-Host "Current main: $MainSha" -ForegroundColor Green

  Write-Host ">> Deploy exact current Energy worker + broker only" -ForegroundColor DarkCyan
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/DEPLOY_REVEX_CURRENT_SERVICES.ps1" -OutFile $DeployScript
  $deployCode = Invoke-Native "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $DeployScript, "-ProjectId", $ProjectId, "-Region", $Region, "-SkipRender", "-NoPause")
  if ($deployCode -ne 0) { throw "Current Energy worker+broker deployment failed with exit code $deployCode." }

  Write-Host ">> Verify the exact live broker-worker dependency edge" -ForegroundColor DarkCyan
  $workerText = Invoke-Capture $GCloud @("run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")
  $worker = $workerText | ConvertFrom-Json
  $ready = @($worker.status.conditions | Where-Object { $_.type -eq "Ready" } | Select-Object -First 1)
  if ($ready.Count -eq 0 -or [string]$ready[0].status -ne "True") { throw "Energy worker is not Ready after deployment." }
  $WorkerUrl = [string]$worker.status.url
  $WorkerSource = Read-WorkerEnv $worker "REVEX_SOURCE_CANDIDATE"
  if (-not $WorkerUrl) { throw "Energy worker has no live URL." }
  if ($WorkerSource -ne $MainSha) { throw "Live worker source mismatch: expected $MainSha, got $WorkerSource." }

  $functionText = Invoke-Capture $GCloud @("functions", "describe", "runRevexEnergy", "--gen2", "--project=$ProjectId", "--region=$Region", "--format=json")
  $function = $functionText | ConvertFrom-Json
  if ([string]$function.state -ne "ACTIVE") { throw "runRevexEnergy is not ACTIVE after deployment." }
  $LiveBrokerSa = [string]$function.serviceConfig.serviceAccountEmail
  $BrokerWorkerUrl = [string]$function.serviceConfig.environmentVariables.REVEX_ENERGY_WORKER_URL
  $BrokerSource = [string]$function.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE
  if ($LiveBrokerSa -ne $BrokerSa) { throw "Broker runtime identity mismatch: expected $BrokerSa, got $LiveBrokerSa." }
  if ($BrokerWorkerUrl.TrimEnd('/') -ne $WorkerUrl.TrimEnd('/')) { throw "Broker points to a different worker URL: $BrokerWorkerUrl vs $WorkerUrl." }
  if ($BrokerSource -ne $MainSha) { throw "Live broker source mismatch: expected $MainSha, got $BrokerSource." }

  $policyText = Invoke-Capture $GCloud @("run", "services", "get-iam-policy", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")
  $policy = $policyText | ConvertFrom-Json
  $invoker = @($policy.bindings | Where-Object {
    [string]$_.role -eq "roles/run.invoker" -and @($_.members) -contains "serviceAccount:$BrokerSa"
  })
  if ($invoker.Count -eq 0) { throw "Live worker IAM does not allow the actual Energy broker service account to invoke it." }

  Write-Host "PASS: live broker and worker are both exact main $MainSha, broker identity is exact, worker URL is exact, worker is Ready, and run.invoker binding is present." -ForegroundColor Green

  Write-Host ">> Update the Revit add-in to the same current main" -ForegroundColor DarkCyan
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/UPDATE_REVEX_ADDIN_CURRENT.ps1" -OutFile $UpdateScript
  Write-Host "If Revit is open, save and close it once. This same recovery process will wait and continue automatically." -ForegroundColor Yellow
  $updateCode = Invoke-Native "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $UpdateScript)
  if ($updateCode -ne 0) { throw "Server edge is repaired, but the current add-in update failed with exit code $updateCode." }

  Write-Host ""
  Write-Host "PASS: REVEX Energy recovery completed from exact main $MainSha." -ForegroundColor Green
  Write-Host "The existing published Engineering revision remains valid. Reopen Revit and use the Energy authorization once; do not rerun the five-minute gbXML export just to retry downstream Energy." -ForegroundColor Green
  $ExitCode = 0
} catch {
  Write-Host ""
  Write-Host "REVEX Energy recovery stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Log: $LogPath" -ForegroundColor Yellow
  $ExitCode = 1
} finally {
  Remove-Item -LiteralPath $DeployScript, $UpdateScript -Force -ErrorAction SilentlyContinue
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
  if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    try { Copy-Item -LiteralPath $LogPath -Destination $LatestLogPath -Force } catch {}
  }
}

exit $ExitCode
