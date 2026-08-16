param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Service = "revex-energy-worker",
  [string]$Repository = "nvberegovykh/LIBER-Creative",
  [string]$SourceCandidate = "",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$FunctionsDir = Join-Path $Root "server\firebase-functions"
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
$ExitCode = 1
$script:NativeExitCode = 0

function Require-Command([string[]]$Names,[string]$Purpose){
  foreach($name in $Names){$cmd=Get-Command $name -ErrorAction SilentlyContinue|Select-Object -First 1;if($cmd){return $cmd.Source}}
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}
function Invoke-Native([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory=""){
  $previous=$ErrorActionPreference
  try{
    $ErrorActionPreference="Continue"
    if($WorkingDirectory){Push-Location $WorkingDirectory}
    try{
      & $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)}
      $code=$LASTEXITCODE;if($null -eq $code){$code=0};$script:NativeExitCode=[int]$code
      return [int]$code
    }finally{if($WorkingDirectory){Pop-Location}}
  }finally{$ErrorActionPreference=$previous}
}
function Invoke-Capture([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory=""){
  $previous=$ErrorActionPreference
  try{
    $ErrorActionPreference="Continue"
    if($WorkingDirectory){Push-Location $WorkingDirectory}
    try{
      $lines=@(& $Command @Arguments 2>&1|ForEach-Object{[string]$_});$code=$LASTEXITCODE;if($null -eq $code){$code=0};$script:NativeExitCode=[int]$code
      return @{Code=[int]$code;Output=$lines}
    }finally{if($WorkingDirectory){Pop-Location}}
  }finally{$ErrorActionPreference=$previous}
}
function Invoke-Checked([string]$Label,[string]$Command,[string[]]$Arguments,[string]$WorkingDirectory=""){
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code=Invoke-Native $Command $Arguments $WorkingDirectory
  if($code -ne 0){throw "$Label failed with exit code $code."}
}
function Resolve-SourceCandidate([string]$Git){
  if($SourceCandidate -match '^[0-9a-fA-F]{40}$'){return $SourceCandidate.ToLowerInvariant()}
  $probe=Invoke-Capture $Git @('rev-parse','HEAD') $Root
  $sha=(@($probe.Output)-join '').Trim()
  if($probe.Code -eq 0 -and $sha -match '^[0-9a-fA-F]{40}$'){return $sha.ToLowerInvariant()}
  throw 'Could not resolve the exact source candidate. Run this from a current Git checkout or pass -SourceCandidate <40-char SHA>.'
}

try{
  Write-Host "REVEX r77 Energy broker-only resume deployment" -ForegroundColor Cyan
  Write-Host "BrokerOnly: private Energy worker, Revit evidence, Firebase/Storage data and renderer are preserved."

  $GCloud=Require-Command @('gcloud.cmd','gcloud.exe','gcloud') 'Google Cloud CLI'
  $Git=Require-Command @('git.exe','git') 'Git'
  $Node=Require-Command @('node.exe','node') 'Node.js'
  $Npm=Require-Command @('npm.cmd','npm.exe','npm') 'npm'
  $ResolvedSource=Resolve-SourceCandidate $Git
  Write-Host "Source candidate: $ResolvedSource" -ForegroundColor Green

  if(-not(Test-Path -LiteralPath (Join-Path $FunctionsDir 'index.js') -PathType Leaf)){throw "Missing Energy broker source: $FunctionsDir"}
  Invoke-Checked 'Syntax-check runRevexEnergy broker source' $Node @('--check','index.js') $FunctionsDir
  Invoke-Checked 'Verify r77 broker/worker authority contract' $Node @((Join-Path $Root '.github\scripts\verify-revex-r77-energy-broker-worker-contract.js')) $Root

  $auth=Invoke-Capture $GCloud @('auth','list','--filter=status:ACTIVE','--format=value(account)')
  $accounts=@($auth.Output|Where-Object{$_ -and $_.Trim()})
  if($auth.Code -ne 0 -or $accounts.Count -eq 0){throw "Google Cloud administrator sign-in is required. Run 'gcloud auth login' once, then rerun this broker-only launcher."}

  Invoke-Checked 'Select Google Cloud project' $GCloud @('config','set','project',$ProjectId)
  $worker=Invoke-Capture $GCloud @('run','services','describe',$Service,'--project',$ProjectId,'--region',$Region,'--format=json')
  if($worker.Code -ne 0){throw 'The existing private Energy worker could not be read; broker-only deployment stopped without changing it.'}
  $workerJson=(@($worker.Output)-join [Environment]::NewLine)|ConvertFrom-Json
  $WorkerUrl=[string]$workerJson.status.url
  $ready=@($workerJson.status.conditions|Where-Object{$_.type -eq 'Ready'}|Select-Object -First 1)
  if(-not $WorkerUrl -or $ready.Count -eq 0 -or [string]$ready[0].status -ne 'True'){throw 'The existing private Energy worker is not Ready; broker-only deployment stopped without changing it.'}
  $WorkerSource=''
  try{$WorkerSource=[string](@($workerJson.spec.template.spec.containers[0].env|Where-Object{$_.name -eq 'REVEX_SOURCE_CANDIDATE'}|Select-Object -First 1).value)}catch{}
  Write-Host "Existing worker: $WorkerUrl" -ForegroundColor Green
  if($WorkerSource){Write-Host "Existing worker source: $WorkerSource"}

  Invoke-Checked 'Install Energy broker dependencies' $Npm @('install','--ignore-scripts','--no-audit','--no-fund') $FunctionsDir
  Invoke-Checked 'Deploy only authenticated runRevexEnergy broker' $GCloud @(
    'functions','deploy','runRevexEnergy','--gen2','--region',$Region,'--project',$ProjectId,
    '--runtime','nodejs22','--source',$FunctionsDir,'--entry-point','runRevexEnergy','--trigger-http',
    '--allow-unauthenticated','--service-account',$BrokerSa,
    '--set-env-vars',"REVEX_ENERGY_WORKER_URL=$WorkerUrl,REVEX_ENERGY_BROKER_SERVICE_ACCOUNT=$BrokerSa,REVEX_SOURCE_CANDIDATE=$ResolvedSource",
    '--memory','1GiB','--timeout','3600s','--concurrency','4','--max-instances','4','--quiet'
  )

  $state=Invoke-Capture $GCloud @('functions','describe','runRevexEnergy','--gen2','--project',$ProjectId,'--region',$Region,'--format=value(state)')
  $FunctionState=(@($state.Output)-join '').Trim()
  if($state.Code -ne 0 -or $FunctionState -ne 'ACTIVE'){throw "runRevexEnergy did not report ACTIVE after broker-only deployment; state=$FunctionState"}

  Write-Host ''
  Write-Host 'PASS: runRevexEnergy broker updated; existing Energy worker was preserved.' -ForegroundColor Green
  Write-Host "Worker: $WorkerUrl"
  Write-Host 'Resume the already-published Engineering revision from Companion. Do not rerun Revit gbXML.' -ForegroundColor Green
  $ExitCode=0
}catch{
  Write-Host ''
  Write-Host "REVEX r77 Energy broker-only deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Private Energy worker and published Engineering evidence were not redeployed or deleted.' -ForegroundColor Yellow
  $ExitCode=1
}finally{
  if(-not $NoPause -and $Host.Name -match 'ConsoleHost'){Write-Host ''}
}
exit $ExitCode
