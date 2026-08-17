param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$RevexInstallRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX"
$RequestedDataRoot = ([string]$env:REVEX_DATA_ROOT).Trim()
if ($RequestedDataRoot) {
  $ExpandedDataRoot = [Environment]::ExpandEnvironmentVariables($RequestedDataRoot)
  if (-not [System.IO.Path]::IsPathFullyQualified($ExpandedDataRoot)) {
    throw "REVEX_DATA_ROOT must be an absolute path."
  }
  $RevexDataRoot = [System.IO.Path]::GetFullPath($ExpandedDataRoot)
} else {
  $RevexDataRoot = $RevexInstallRoot
}
$LogRoot = Join-Path $RevexDataRoot "Logs"
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
    if ([int]$code -ne 0) { throw "Command failed with exit code ${code}: $Command $($Arguments -join ' ')" }
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

function Get-LatestEngineeringRevisionState {
  $root = Join-Path $RevexDataRoot "Engineering\Sync\revisions"
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    return [pscustomobject]@{ Revision = ""; Folder = ""; StructuredSchedules = $false }
  }
  $folder = Get-ChildItem -LiteralPath $root -Directory -Filter "eng_*" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $folder) {
    return [pscustomobject]@{ Revision = ""; Folder = ""; StructuredSchedules = $false }
  }
  $structured = Test-Path -LiteralPath (Join-Path $folder.FullName "engine-REVIT-SCHEDULE-EVIDENCE.json") -PathType Leaf
  return [pscustomobject]@{ Revision = $folder.Name; Folder = $folder.FullName; StructuredSchedules = [bool]$structured }
}

function Assert-InstalledSource([string]$ExpectedSha) {
  $markerPath = Join-Path $RevexInstallRoot "App\REVEX-CURRENT-SOURCE.json"
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "The updated add-in has no REVEX-CURRENT-SOURCE.json marker. Worker/add-in source equality cannot be proven."
  }
  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  $actual = ([string]$marker.commit).Trim().ToLowerInvariant()
  if ($actual -ne $ExpectedSha) {
    throw "Worker/add-in source mismatch: live worker is $ExpectedSha but installed add-in is $actual. Main moved during recovery; rerun this same recovery once so both sides converge on one exact commit."
  }
  return $actual
}

try {
  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
  } catch {}

  Write-Host "REVEX Energy single-shot recovery" -ForegroundColor Cyan
  Write-Host "Log: $LogPath"
  Write-Host "Data root: $RevexDataRoot"
  Write-Host "Scope: current Energy worker + broker, exact broker/worker IAM verification, then current add-in only. Renderer is untouched."

  $GCloud = Require-Command @("gcloud.cmd", "gcloud.exe", "gcloud") "Google Cloud CLI"
  $Git = Require-Command @("git.exe", "git") "Git"

  $before = Get-LatestEngineeringRevisionState
  if ($before.Revision) {
    Write-Host "Latest local Engineering revision before recovery: $($before.Revision); structuredSchedules=$($before.StructuredSchedules)"
  } else {
    Write-Host "No local immutable Engineering revision was found before recovery."
  }

  $mainLine = Invoke-Capture $Git @("ls-remote", "https://github.com/nvberegovykh/LIBER-Creative.git", "refs/heads/main")
  $MainSha = (($mainLine -split "\s+")[0]).Trim().ToLowerInvariant()
  if ($MainSha -notmatch '^[0-9a-f]{40}$') { throw "GitHub main did not resolve to an exact SHA." }
  Write-Host "Current main: $MainSha" -ForegroundColor Green

  Write-Host ">> Deploy current Energy worker + broker, then prove the live source SHA" -ForegroundColor DarkCyan
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/$MainSha/DEPLOY_REVEX_CURRENT_SERVICES.ps1" -OutFile $DeployScript
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
  if ($WorkerSource -ne $MainSha) { throw "Live worker source mismatch: expected $MainSha, got $WorkerSource. Main moved during deployment; rerun this same recovery once." }

  $functionText = Invoke-Capture $GCloud @("functions", "describe", "runRevexEnergy", "--gen2", "--project=$ProjectId", "--region=$Region", "--format=json")
  $function = $functionText | ConvertFrom-Json
  if ([string]$function.state -ne "ACTIVE") { throw "runRevexEnergy is not ACTIVE after deployment." }
  $LiveBrokerSa = [string]$function.serviceConfig.serviceAccountEmail
  $BrokerWorkerUrl = [string]$function.serviceConfig.environmentVariables.REVEX_ENERGY_WORKER_URL
  $BrokerSource = [string]$function.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE
  if ($LiveBrokerSa -ne $BrokerSa) { throw "Broker runtime identity mismatch: expected $BrokerSa, got $LiveBrokerSa." }
  if ($BrokerWorkerUrl.TrimEnd('/') -ne $WorkerUrl.TrimEnd('/')) { throw "Broker points to a different worker URL: $BrokerWorkerUrl vs $WorkerUrl." }
  if ($BrokerSource -ne $MainSha) { throw "Live broker source mismatch: expected $MainSha, got $BrokerSource. Main moved during deployment; rerun this same recovery once." }

  $policyText = Invoke-Capture $GCloud @("run", "services", "get-iam-policy", $Service, "--project=$ProjectId", "--region=$Region", "--format=json")
  $policy = $policyText | ConvertFrom-Json
  $invoker = @($policy.bindings | Where-Object {
    [string]$_.role -eq "roles/run.invoker" -and @($_.members) -contains "serviceAccount:$BrokerSa"
  })
  if ($invoker.Count -eq 0) { throw "Live worker IAM does not allow the actual Energy broker service account to invoke it." }

  Write-Host "PASS: live broker and worker are exact source $MainSha, broker identity is exact, worker URL is exact, worker is Ready, and run.invoker binding is present." -ForegroundColor Green

  Write-Host ">> Update the Revit add-in, then prove it matches the live worker source" -ForegroundColor DarkCyan
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/$MainSha/UPDATE_REVEX_ADDIN_CURRENT.ps1" -OutFile $UpdateScript
  Write-Host "If Revit is open, save and close it once. This same recovery process will wait and continue automatically." -ForegroundColor Yellow
  $updateCode = Invoke-Native "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $UpdateScript)
  if ($updateCode -ne 0) { throw "Server edge is repaired, but the current add-in update failed with exit code $updateCode." }
  $InstalledSha = Assert-InstalledSource $MainSha

  $after = Get-LatestEngineeringRevisionState
  Write-Host ""
  Write-Host "PASS: REVEX Energy recovery completed from one exact source $InstalledSha." -ForegroundColor Green
  Write-Host "Worker + broker + installed Revit add-in are source-identical." -ForegroundColor Green
  Write-Host ""
  if ($after.Revision -and $after.StructuredSchedules) {
    Write-Host "Latest Engineering revision $($after.Revision) already contains native Revit schedule evidence." -ForegroundColor Green
    Write-Host "If the Revit model/evidence has NOT changed: reopen Revit -> Energy -> Retry this published revision. Do not resync merely to replay downstream Energy." -ForegroundColor Green
    Write-Host "If geometry, schedules, T/Z/EN evidence, or weather changed: run SYNC ENGINEERING once to publish the new current state." -ForegroundColor Yellow
  } elseif ($after.Revision) {
    Write-Host "Latest Engineering revision $($after.Revision) predates native structured schedule evidence." -ForegroundColor Yellow
    Write-Host "It remains replayable through the bounded T/Z/EN PDF fallback, but that does not prove the new structured-evidence path." -ForegroundColor Yellow
    Write-Host "To run the current model through the repaired reusable path: reopen Revit -> SYNC ENGINEERING once. That new revision captures fresh geometry + schedules + T/Z/EN + EPW together." -ForegroundColor Green
  } else {
    Write-Host "No Engineering revision exists yet." -ForegroundColor Yellow
    Write-Host "Reopen Revit -> select/create the correct REVEX project if needed -> SYNC ENGINEERING once. The first immutable revision will capture fresh geometry + schedules + T/Z/EN + EPW together." -ForegroundColor Green
  }
  Write-Host "Never run both Retry and SYNC ENGINEERING for the same unchanged state; Retry replays an immutable revision, Sync publishes a new current state." -ForegroundColor Cyan
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
