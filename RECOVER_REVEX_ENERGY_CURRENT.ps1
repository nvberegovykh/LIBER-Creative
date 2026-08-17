param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$RepositoryUrl = "https://github.com/nvberegovykh/LIBER-Creative.git"
$RevexInstallRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX"
$RequestedDataRoot = ([string]$env:REVEX_DATA_ROOT).Trim()
if ($RequestedDataRoot) {
  $ExpandedDataRoot = [Environment]::ExpandEnvironmentVariables($RequestedDataRoot)
  $DriveRelative = $ExpandedDataRoot -match '^[A-Za-z]:(?:$|[^\\/])'
  $SingleRootSlash = $ExpandedDataRoot.StartsWith('\') -and -not $ExpandedDataRoot.StartsWith('\\')
  if (-not [System.IO.Path]::IsPathRooted($ExpandedDataRoot) -or $DriveRelative -or $SingleRootSlash) {
    throw "REVEX_DATA_ROOT must be an absolute path."
  }
  $RevexDataRoot = [System.IO.Path]::GetFullPath($ExpandedDataRoot)
} else {
  $RevexDataRoot = $RevexInstallRoot
}

$LogRoot = Join-Path $RevexDataRoot "Logs"
$LogPath = Join-Path $LogRoot ("RECOVER_REVEX_ENERGY_CURRENT." + $Stamp + ".log")
$LatestLogPath = Join-Path $LogRoot "RECOVER_REVEX_ENERGY_CURRENT.latest.log"
$WorkRoot = Join-Path $env:TEMP ("REVEX-R104-FULL-" + [guid]::NewGuid().ToString("N"))
$SourceRoot = Join-Path $WorkRoot "source"
$UpdateScript = Join-Path $env:TEMP ("REVEX-ADDIN-UPDATE-" + [guid]::NewGuid().ToString("N") + ".ps1")
$Service = "revex-energy-worker"
$WorkerSa = "revex-energy-worker@$ProjectId.iam.gserviceaccount.com"
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
$TranscriptStarted = $false
$ExitCode = 1

New-Item -ItemType Directory -Path $LogRoot, $WorkRoot -Force | Out-Null

function Require-Command([string[]]$Names, [string]$Purpose) {
  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
  }
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}

function Invoke-Native([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
      & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      return [int]$code
    } finally {
      if ($WorkingDirectory) { Pop-Location }
    }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code = Invoke-Native $Command $Arguments $WorkingDirectory
  if ($code -ne 0) { throw "$Label failed with exit code $code." }
}

function Invoke-Capture([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
      $lines = @(& $Command @Arguments 2>&1 | ForEach-Object { [string]$_ })
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      if ([int]$code -ne 0) { throw "Command failed with exit code ${code}: $Command $($Arguments -join ' ')" }
      return ($lines -join [Environment]::NewLine).Trim()
    } finally {
      if ($WorkingDirectory) { Pop-Location }
    }
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
    throw "The updated add-in has no REVEX-CURRENT-SOURCE.json marker. Complete-stack source equality cannot be proven."
  }
  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  $actual = ([string]$marker.commit).Trim().ToLowerInvariant()
  if ($actual -ne $ExpectedSha) {
    throw "Installed add-in source mismatch: expected $ExpectedSha, got $actual. Main changed during convergence; rerun this same command once so every component converges on one exact source."
  }
  return $actual
}

function Assert-FullLiveEdge([string]$ExpectedSha, [string]$GCloud) {
  Write-Host ">> Verify complete live worker + broker + IAM edge" -ForegroundColor DarkCyan

  $workerText = Invoke-Capture $GCloud @('run','services','describe',$Service,"--project=$ProjectId","--region=$Region",'--format=json')
  $worker = $workerText | ConvertFrom-Json
  $ready = @($worker.status.conditions | Where-Object { $_.type -eq 'Ready' } | Select-Object -First 1)
  if ($ready.Count -eq 0 -or [string]$ready[0].status -ne 'True') { throw "Energy worker is not Ready." }
  $WorkerUrl = [string]$worker.status.url
  if (-not $WorkerUrl) { throw "Energy worker has no live URL." }
  $WorkerSource = Read-WorkerEnv $worker 'REVEX_SOURCE_CANDIDATE'
  if ($WorkerSource -ne $ExpectedSha) { throw "Live worker source mismatch: expected $ExpectedSha, got $WorkerSource." }
  $WorkerVertexProject = Read-WorkerEnv $worker 'REVEX_VERTEX_PROJECT'
  if ($WorkerVertexProject -ne $ProjectId) { throw "Live worker Vertex project mismatch: expected $ProjectId, got $WorkerVertexProject." }

  $LiveWorkerSa = ''
  try { $LiveWorkerSa = [string]$worker.spec.template.spec.serviceAccountName } catch {}
  if (-not $LiveWorkerSa) { try { $LiveWorkerSa = [string]$worker.spec.template.spec.serviceAccount } catch {} }
  if ($LiveWorkerSa -and $LiveWorkerSa -ne $WorkerSa) { throw "Worker runtime identity mismatch: expected $WorkerSa, got $LiveWorkerSa." }

  $functionText = Invoke-Capture $GCloud @('functions','describe','runRevexEnergy','--gen2',"--project=$ProjectId","--region=$Region",'--format=json')
  $function = $functionText | ConvertFrom-Json
  if ([string]$function.state -ne 'ACTIVE') { throw "runRevexEnergy is not ACTIVE." }
  $runtime = [string]$function.buildConfig.runtime
  if ($runtime -and $runtime -ne 'nodejs22') { throw "runRevexEnergy runtime mismatch: expected nodejs22, got $runtime." }
  $LiveBrokerSa = [string]$function.serviceConfig.serviceAccountEmail
  $BrokerWorkerUrl = [string]$function.serviceConfig.environmentVariables.REVEX_ENERGY_WORKER_URL
  $BrokerSource = [string]$function.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE
  if ($LiveBrokerSa -ne $BrokerSa) { throw "Broker runtime identity mismatch: expected $BrokerSa, got $LiveBrokerSa." }
  if ($BrokerWorkerUrl.TrimEnd('/') -ne $WorkerUrl.TrimEnd('/')) { throw "Broker points to a different worker URL: $BrokerWorkerUrl vs $WorkerUrl." }
  if ($BrokerSource -ne $ExpectedSha) { throw "Live broker source mismatch: expected $ExpectedSha, got $BrokerSource." }

  $policyText = Invoke-Capture $GCloud @('run','services','get-iam-policy',$Service,"--project=$ProjectId","--region=$Region",'--format=json')
  $policy = $policyText | ConvertFrom-Json
  $invoker = @($policy.bindings | Where-Object {
    [string]$_.role -eq 'roles/run.invoker' -and @($_.members) -contains "serviceAccount:$BrokerSa"
  })
  if ($invoker.Count -eq 0) { throw "Worker IAM does not grant roles/run.invoker to the actual Energy broker service account." }

  return [pscustomobject]@{ WorkerUrl = $WorkerUrl; WorkerSource = $WorkerSource; BrokerSource = $BrokerSource }
}

try {
  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
  } catch {}

  Write-Host "REVEX complete Energy-stack convergence" -ForegroundColor Cyan
  Write-Host "Log: $LogPath"
  Write-Host "Data root: $RevexDataRoot"
  Write-Host "Contract: exact source -> offline regressions -> worker -> authenticated broker -> IAM -> Revit add-in -> one verified full chain."
  Write-Host "Renderer is verified by preserved source regressions but is not redeployed because this command changes no renderer source."

  $Git = Require-Command @('git.exe','git') 'Git'
  $GCloud = Require-Command @('gcloud.cmd','gcloud.exe','gcloud') 'Google Cloud CLI'
  $Node = Require-Command @('node.exe','node') 'Node.js'
  $Python = Require-Command @('python.exe','python','py.exe','py') 'Python 3'

  $before = Get-LatestEngineeringRevisionState
  if ($before.Revision) {
    Write-Host "Latest local Engineering revision: $($before.Revision); structuredSchedules=$($before.StructuredSchedules)"
  } else {
    Write-Host "No local immutable Engineering revision exists yet."
  }

  $mainLine = Invoke-Capture $Git @('ls-remote',$RepositoryUrl,'refs/heads/main')
  $MainSha = (($mainLine -split '\s+')[0]).Trim().ToLowerInvariant()
  if ($MainSha -notmatch '^[0-9a-f]{40}$') { throw "GitHub main did not resolve to an exact SHA." }
  Write-Host "Exact source candidate: $MainSha" -ForegroundColor Green

  Write-Host ">> Fetch exact source once" -ForegroundColor DarkCyan
  Invoke-Checked 'Initialize isolated source checkout' $Git @('init',$SourceRoot)
  Invoke-Checked 'Attach LIBER-Creative origin' $Git @('-C',$SourceRoot,'remote','add','origin',$RepositoryUrl)
  Invoke-Checked 'Fetch exact source candidate' $Git @('-C',$SourceRoot,'fetch','--depth','1','origin',$MainSha)
  Invoke-Checked 'Checkout exact source candidate' $Git @('-C',$SourceRoot,'checkout','--detach','FETCH_HEAD')
  $CheckedSha = (Invoke-Capture $Git @('-C',$SourceRoot,'rev-parse','HEAD')).Trim().ToLowerInvariant()
  if ($CheckedSha -ne $MainSha) { throw "Exact source checkout mismatch: expected $MainSha, got $CheckedSha." }

  Write-Host ">> Replay known failure classes offline before cloud changes" -ForegroundColor DarkCyan
  Invoke-Checked 'Current-generation regression' $Node @('.github\scripts\verify-revex-current-generation-r53.js') $SourceRoot
  Invoke-Checked 'Project identity + same-type finish regression' $Python @('.github\scripts\verify-revex-r69-energy-finish.py') $SourceRoot
  Invoke-Checked 'Revit topology fallback regression' $Python @('.github\scripts\verify-revex-r73-energy-topology-fallback.py') $SourceRoot
  Invoke-Checked 'Broker/worker authority regression' $Node @('.github\scripts\verify-revex-r77-energy-broker-worker-contract.js') $SourceRoot
  Invoke-Checked 'GeometryCo source-condition regression' $Python @('server\revex-energy-worker\verify_geometryco_source_condition_r91.py') $SourceRoot
  Invoke-Checked 'Structured current-Revit schedule regression' $Python @('server\revex-energy-worker\verify_structured_schedule_evidence_r101.py') $SourceRoot
  Invoke-Checked 'Bounded current T/Z/EN COMcheck evidence regression' $Python @('server\revex-energy-worker\verify_comcheck_evidence_r100.py') $SourceRoot
  Write-Host "PASS: known binding/topology/GeometryCo/schedule/COMcheck failure classes pass before deployment." -ForegroundColor Green

  Write-Host ">> Deploy exact private Energy worker" -ForegroundColor DarkCyan
  $workerScript = Join-Path $SourceRoot 'server\revex-energy-worker\DEPLOY_ENERGY_WORKER_ONLY_R69.ps1'
  if (-not (Test-Path -LiteralPath $workerScript -PathType Leaf)) { throw "Worker deployment primitive is missing from exact source." }
  $workerCode = Invoke-Native 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',$workerScript,'-ProjectId',$ProjectId,'-Region',$Region,'-SourceCandidate',$MainSha,'-NoPause') $SourceRoot
  if ($workerCode -ne 0) { throw "Exact Energy worker deployment failed with exit code $workerCode." }

  Write-Host ">> Deploy exact authenticated Energy broker directly with gcloud Gen2" -ForegroundColor DarkCyan
  $brokerScript = Join-Path $SourceRoot 'server\revex-energy-worker\DEPLOY_ENERGY_BROKER_ONLY_R77.ps1'
  if (-not (Test-Path -LiteralPath $brokerScript -PathType Leaf)) { throw "Broker deployment primitive is missing from exact source." }
  $brokerCode = Invoke-Native 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',$brokerScript,'-ProjectId',$ProjectId,'-Region',$Region,'-Service',$Service,'-SourceCandidate',$MainSha,'-NoPause') $SourceRoot
  if ($brokerCode -ne 0) { throw "Exact Energy broker deployment failed with exit code $brokerCode." }

  $edge = Assert-FullLiveEdge $MainSha $GCloud
  Write-Host "PASS: complete managed Energy edge is live from $MainSha." -ForegroundColor Green
  Write-Host "Worker: $($edge.WorkerUrl)"

  Write-Host ">> Install exact matching Revit add-in" -ForegroundColor DarkCyan
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/$MainSha/UPDATE_REVEX_ADDIN_CURRENT.ps1" -OutFile $UpdateScript
  Write-Host "If Revit is open, save and close it once. This same command waits and continues automatically." -ForegroundColor Yellow
  $updateCode = Invoke-Native 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',$UpdateScript)
  if ($updateCode -ne 0) { throw "Managed stack is live, but the matching Revit add-in update failed with exit code $updateCode." }
  $InstalledSha = Assert-InstalledSource $MainSha

  $after = Get-LatestEngineeringRevisionState
  Write-Host ""
  Write-Host "PASS: complete REVEX Energy stack converged on exact source $InstalledSha." -ForegroundColor Green
  Write-Host "Worker + authenticated broker + IAM + installed Revit add-in are verified together." -ForegroundColor Green
  Write-Host ""
  if ($after.Revision -and $after.StructuredSchedules) {
    Write-Host "Latest Engineering revision $($after.Revision) contains native Revit schedule evidence." -ForegroundColor Green
    Write-Host "UNCHANGED model/evidence/weather: use Retry this published revision." -ForegroundColor Green
    Write-Host "CHANGED geometry, schedules, T/Z/EN evidence, or weather: run SYNC ENGINEERING once to publish the new current state." -ForegroundColor Yellow
  } elseif ($after.Revision) {
    Write-Host "Latest Engineering revision $($after.Revision) predates structured native schedule capture." -ForegroundColor Yellow
    Write-Host "For the final reusable-path proof, reopen Revit and run SYNC ENGINEERING once. The new immutable revision captures fresh geometry + native schedules + T/Z/EN + EPW together." -ForegroundColor Green
  } else {
    Write-Host "No Engineering revision exists yet." -ForegroundColor Yellow
    Write-Host "Reopen Revit, create/select the correct REVEX project if it is not already bound, then run SYNC ENGINEERING once. The same full managed chain continues automatically after publication." -ForegroundColor Green
  }
  Write-Host "Retry replays one immutable revision. SYNC ENGINEERING publishes a new current Revit state. They are never substitutes for each other." -ForegroundColor Cyan
  $ExitCode = 0
}
catch {
  Write-Host ""
  Write-Host "REVEX complete Energy-stack convergence stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Log: $LogPath" -ForegroundColor Yellow
  $ExitCode = 1
}
finally {
  Remove-Item -LiteralPath $UpdateScript -Force -ErrorAction SilentlyContinue
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
  if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    try { Copy-Item -LiteralPath $LogPath -Destination $LatestLogPath -Force } catch {}
  }
  if (Test-Path -LiteralPath $WorkRoot -PathType Container) {
    try { Remove-Item -LiteralPath $WorkRoot -Recurse -Force } catch { Write-Warning "Temporary exact-source checkout remains at $WorkRoot" }
  }
}

exit $ExitCode
