param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-energy-worker",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkerDeploy = Join-Path $PSScriptRoot "DEPLOY_ENERGY_WORKER_ONLY_R69.ps1"
$BrokerDeploy = Join-Path $PSScriptRoot "DEPLOY_ENERGY_BROKER_ONLY_R77.ps1"
$WorkerSa = "revex-energy-worker@$ProjectId.iam.gserviceaccount.com"
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
$ExitCode = 1

function Require-Command([string[]]$Names,[string]$Purpose){
  foreach($name in $Names){$cmd=Get-Command $name -ErrorAction SilentlyContinue|Select-Object -First 1;if($cmd){return $cmd.Source}}
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}
function Invoke-Native([string]$Command,[string[]]$Arguments){
  $previous=$ErrorActionPreference
  try{
    $ErrorActionPreference='Continue'
    & $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)}
    $code=$LASTEXITCODE;if($null -eq $code){$code=0};return [int]$code
  }finally{$ErrorActionPreference=$previous}
}
function Invoke-Capture([string]$Command,[string[]]$Arguments){
  $previous=$ErrorActionPreference
  try{
    $ErrorActionPreference='Continue'
    $lines=@(& $Command @Arguments 2>&1|ForEach-Object{[string]$_});$code=$LASTEXITCODE;if($null -eq $code){$code=0}
    return @{Code=[int]$code;Output=$lines}
  }finally{$ErrorActionPreference=$previous}
}
function Invoke-Checked([string]$Label,[string]$Command,[string[]]$Arguments){
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code=Invoke-Native $Command $Arguments
  if($code -ne 0){throw "$Label failed with exit code $code."}
}
function Read-EnvMap($RunState){
  $map=@{}
  foreach($row in @($RunState.spec.template.spec.containers[0].env)){$map[[string]$row.name]=[string]$row.value}
  return $map
}
function Normalize-Timeout($value){
  $text=[string]$value
  if($text -match '^(\d+)(s)?$'){return [int]$Matches[1]}
  return 0
}

try{
  Write-Host "REVEX r114 resilient Energy deployment" -ForegroundColor Cyan
  Write-Host "Exact source: $SourceCandidate"
  Write-Host "Acceptance: immutable revision -> GeometryCo -> 2 OSMs -> 2 EnergyPlus -> official COMcheck -> EN-1 -> final package."
  Write-Host "Transport loss is recoverable only while the durable worker heartbeat/lease proves the worker is alive."

  if(-not(Test-Path -LiteralPath $WorkerDeploy -PathType Leaf)){throw "Missing worker deployment primitive: $WorkerDeploy"}
  if(-not(Test-Path -LiteralPath $BrokerDeploy -PathType Leaf)){throw "Missing broker deployment primitive: $BrokerDeploy"}
  $GCloud=Require-Command @('gcloud.cmd','gcloud.exe','gcloud') 'Google Cloud CLI'
  $Node=Require-Command @('node.exe','node') 'Node.js'

  Invoke-Checked 'Syntax-check r114 durable Energy browser owner' $Node @('--check',(Join-Path $Root 'docs\liber-apps\apps\revex\energy-replay-r95.js'))
  Invoke-Checked 'Syntax-check r114 durable Energy native edge' $Node @('--check',(Join-Path $Root 'docs\liber-apps\apps\revex\live-worker-edge-r97.js'))

  $auth=Invoke-Capture $GCloud @('auth','list','--filter=status:ACTIVE','--format=value(account)')
  $accounts=@($auth.Output|Where-Object{$_ -and $_.Trim()})
  if($auth.Code -ne 0 -or $accounts.Count -eq 0){throw "Google Cloud administrator sign-in is required. Run 'gcloud auth login' once, then rerun."}

  Invoke-Checked 'Select Google Cloud project' $GCloud @('config','set','project',$ProjectId)
  Invoke-Checked 'Grant Energy worker durable Firestore job access' $GCloud @(
    'projects','add-iam-policy-binding',$ProjectId,
    "--member=serviceAccount:$WorkerSa",'--role=roles/datastore.user','--quiet'
  )

  Write-Host ''
  Write-Host '>> Deploy exact r114 Energy worker with durable lease/heartbeat/cache' -ForegroundColor DarkCyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WorkerDeploy -ProjectId $ProjectId -Region $Region -Repository $Repository -Service $Service -SourceCandidate $SourceCandidate -NoPause
  if($LASTEXITCODE -ne 0){throw "r114 Energy worker deployment failed with exit code $LASTEXITCODE."}

  $worker=Invoke-Capture $GCloud @('run','services','describe',$Service,'--project',$ProjectId,'--region',$Region,'--format=json')
  if($worker.Code -ne 0){throw 'Deployed Energy worker could not be re-read.'}
  $RunState=(@($worker.Output)-join [Environment]::NewLine)|ConvertFrom-Json
  $Ready=@($RunState.status.conditions|Where-Object{$_.type -eq 'Ready'}|Select-Object -First 1)
  if($Ready.Count -eq 0 -or [string]$Ready[0].status -ne 'True'){throw 'Energy worker did not report Ready after r114 deployment.'}
  $WorkerUrl=[string]$RunState.status.url
  if(-not $WorkerUrl){throw 'Energy worker reported Ready without a URL.'}
  $timeout=Normalize-Timeout $RunState.spec.template.spec.timeoutSeconds
  if($timeout -ne 3600){throw "Live Energy worker request timeout mismatch: expected 3600s, got $($RunState.spec.template.spec.timeoutSeconds)."}
  $envMap=Read-EnvMap $RunState
  if([string]$envMap['REVEX_SOURCE_CANDIDATE'] -ne $SourceCandidate){throw 'Live Energy worker source candidate does not match the exact r114 source.'}
  if([string]$envMap['REVEX_ENERGY_TIMEOUT_SECONDS'] -ne '3500'){throw 'Live Energy pipeline timeout is not 3500 seconds.'}
  $serviceAccount=[string]$RunState.spec.template.spec.serviceAccountName
  if($serviceAccount -and $serviceAccount -ne $WorkerSa){throw "Live Energy worker service account mismatch: $serviceAccount"}
  Write-Host "PASS: live worker Ready; timeout=3600s; pipeline timeout=3500s; source=$SourceCandidate" -ForegroundColor Green

  Write-Host ''
  Write-Host '>> Deploy exact r114 authenticated Energy broker' -ForegroundColor DarkCyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BrokerDeploy -ProjectId $ProjectId -Region $Region -Service $Service -Repository 'nvberegovykh/LIBER-Creative' -SourceCandidate $SourceCandidate -NoPause
  if($LASTEXITCODE -ne 0){throw "r114 Energy broker deployment failed with exit code $LASTEXITCODE."}

  $fn=Invoke-Capture $GCloud @('functions','describe','runRevexEnergy','--gen2','--project',$ProjectId,'--region',$Region,'--format=json')
  if($fn.Code -ne 0){throw 'runRevexEnergy could not be re-read after deployment.'}
  $FunctionState=(@($fn.Output)-join [Environment]::NewLine)|ConvertFrom-Json
  if([string]$FunctionState.state -ne 'ACTIVE'){throw "runRevexEnergy is not ACTIVE: $($FunctionState.state)"}
  $functionTimeout=Normalize-Timeout $FunctionState.serviceConfig.timeoutSeconds
  if($functionTimeout -ne 3600){throw "Live Energy broker timeout mismatch: expected 3600s, got $($FunctionState.serviceConfig.timeoutSeconds)."}
  $brokerRuntime=[string]$FunctionState.buildConfig.runtime
  if($brokerRuntime -ne 'nodejs22'){throw "Live Energy broker runtime mismatch: expected nodejs22, got $brokerRuntime."}
  $liveWorkerUrl=[string]$FunctionState.serviceConfig.environmentVariables.REVEX_ENERGY_WORKER_URL
  if($liveWorkerUrl.TrimEnd('/') -ne $WorkerUrl.TrimEnd('/')){throw 'Live broker is not bound to the exact deployed worker URL.'}
  Write-Host "PASS: live broker ACTIVE; timeout=3600s; runtime=nodejs22; exact worker binding verified." -ForegroundColor Green

  Write-Host ''
  Write-Host 'PASS: REVEX r114 resilient Energy execution envelope is live.' -ForegroundColor Green
  Write-Host 'A browser/callable/socket loss no longer counts as Energy failure while the worker heartbeat is alive.'
  Write-Host 'Only a COMPLETE strict r49 final package counts as success.' -ForegroundColor Green
  $ExitCode=0
}catch{
  Write-Host ''
  Write-Host "REVEX r114 Energy deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode=1
}finally{
  if(-not $NoPause -and $Host.Name -match 'ConsoleHost'){Write-Host ''}
}
exit $ExitCode
