param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-render-current",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$CandidateOnly,
  [switch]$BrokerOnly,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
if ($CandidateOnly -and $BrokerOnly) { throw "Choose CandidateOnly or BrokerOnly, not both." }

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$FunctionsDir = Join-Path $Root "server\revex-render-functions"
$CloudBuild = Join-Path $PSScriptRoot "cloudbuild.yaml"
$WorkerSa = "revex-render-worker@$ProjectId.iam.gserviceaccount.com"
$BrokerSa = "revex-render-broker@$ProjectId.iam.gserviceaccount.com"
$Short = $SourceCandidate.Substring(0,12).ToLowerInvariant()
$ImageTag = "current-$Short"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-render-worker:$ImageTag"
$MountPath = "/mnt/revex-hf-cache"
$ModelCache = "$MountPath/models/Qwen-Image-Edit-2511-6f3ccc0"
$WarmMarker = "$MountPath/revex-render-current-$Short-ready.json"
$WarmToken = [guid]::NewGuid().ToString("N")
$ExitCode = 1

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX Render deployment." }
  return $cmd.Source
}
function Invoke-Native([string]$Command,[string[]]$Arguments,[switch]$Quiet) {
  $previous=$ErrorActionPreference
  try {
    $ErrorActionPreference="Continue"
    if($Quiet){& $Command @Arguments *> $null}else{& $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)}}
    $code=$LASTEXITCODE;if($null-eq $code){$code=0};return [int]$code
  } catch { return 1 }
  finally{$ErrorActionPreference=$previous}
}
function Capture-Native([string]$Command,[string[]]$Arguments) {
  $previous=$ErrorActionPreference
  try {
    $ErrorActionPreference="Continue"
    $lines=@(& $Command @Arguments 2>$null|ForEach-Object{[string]$_})
    $code=$LASTEXITCODE;if($null-eq $code){$code=0}
    return [pscustomobject]@{Code=[int]$code;Text=($lines-join "`n").Trim()}
  } finally{$ErrorActionPreference=$previous}
}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments,[switch]$Quiet) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code=Invoke-Native $Command $Arguments -Quiet:$Quiet
  if($code-ne 0){throw "$Label failed with exit code $code."}
}
function Native-Ok([string]$Command,[string[]]$Arguments){return (Invoke-Native $Command $Arguments -Quiet)-eq 0}
function Ensure-ServiceAccount([string]$GCloud,[string]$Name,[string]$DisplayName) {
  $email="$Name@$ProjectId.iam.gserviceaccount.com"
  if(-not(Native-Ok $GCloud @("iam","service-accounts","describe",$email,"--project",$ProjectId))){
    Require-Ok "Create $DisplayName identity" $GCloud @("iam","service-accounts","create",$Name,"--display-name",$DisplayName,"--project",$ProjectId) -Quiet
  }
  return $email
}
function Add-ProjectRole([string]$GCloud,[string]$Member,[string]$Role,[string]$Label){
  Require-Ok $Label $GCloud @("projects","add-iam-policy-binding",$ProjectId,"--member",$Member,"--role",$Role,"--quiet") -Quiet
}
function Add-ServiceAccountUser([string]$GCloud,[string]$ServiceAccount,[string]$Member,[string]$Label){
  Require-Ok $Label $GCloud @("iam","service-accounts","add-iam-policy-binding",$ServiceAccount,"--project",$ProjectId,"--member",$Member,"--role","roles/iam.serviceAccountUser","--quiet") -Quiet
}
function Resolve-FirebaseBucket([string]$GCloud) {
  $rows=Capture-Native $GCloud @("storage","buckets","list","--project",$ProjectId,"--format","value(name)")
  if($rows.Code-ne 0){throw "Could not enumerate Firebase/Cloud Storage buckets."}
  $prefix=[Regex]::Escape($ProjectId)
  $names=@($rows.Text -split "`n"|ForEach-Object{$_.Trim().TrimEnd('/') -replace '^gs://',''}|Where-Object{$_})
  $matches=@($names|Where-Object{$_ -match "^$prefix\.(?:appspot\.com|firebasestorage\.app)$"}|Select-Object -Unique)
  if($matches.Count-ne 1){throw "Expected exactly one Firebase Storage bucket for $ProjectId; found $($matches -join ', ')."}
  return [string]$matches[0]
}
function Resolve-Candidate([string]$GCloud) {
  $state=Capture-Native $GCloud @("run","services","describe",$Service,"--project",$ProjectId,"--region",$Region,"--format","json")
  if($state.Code-ne 0-or-not $state.Text){throw "Render candidate service is unavailable: $Service"}
  $run=$state.Text|ConvertFrom-Json
  $ready=@($run.status.conditions|Where-Object{$_.type-eq 'Ready'}|Select-Object -First 1)
  if($ready.Count-eq 0-or [string]$ready[0].status-ne 'True'){throw "Render candidate is not Ready; broker remains unchanged."}
  $url=[string]$run.status.url;if(-not $url){throw "Render candidate has no service URL; broker remains unchanged."}
  $envs=@{};foreach($row in @($run.spec.template.spec.containers[0].env)){$envs[[string]$row.name]=[string]$row.value}
  if([string]$envs['REVEX_SOURCE_CANDIDATE']-ne $SourceCandidate){throw "Render candidate source SHA does not match the release source."}
  $warmToken=[string]$envs['REVEX_WARM_TOKEN'];$marker=[string]$envs['REVEX_WARM_MARKER']
  if(-not $warmToken-or-not $marker){throw "Render candidate has no warm-proof binding."}
  return [pscustomobject]@{Url=$url;WarmToken=$warmToken;WarmMarker=$marker;Run=$run}
}
function Assert-Warm([string]$GCloud,[string]$Bucket,$Candidate,[int]$Minutes=35) {
  $name=[IO.Path]::GetFileName([string]$Candidate.WarmMarker)
  $markerUri="gs://$Bucket/$name"
  $deadline=(Get-Date).AddMinutes($Minutes)
  while((Get-Date)-lt $deadline){
    $marker=Capture-Native $GCloud @("storage","cat",$markerUri)
    if($marker.Code-eq 0-and $marker.Text){
      try{$payload=$marker.Text|ConvertFrom-Json}catch{$payload=$null}
      if($payload){
        if([string]$payload.warmToken-ne [string]$Candidate.WarmToken){Start-Sleep -Seconds 10;continue}
        if($payload.ok-eq $false-and $payload.error){throw "Render server model warm failed: $($payload.error)"}
        if($payload.ok-eq $true-and $payload.serverWarm-eq $true-and [string]$payload.model-eq 'Qwen/Qwen-Image-Edit-2511' -and [string]$payload.revision-eq '6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9'){
          return
        }
      }
    }
    Start-Sleep -Seconds 10
  }
  throw "Render candidate did not prove the pinned model resident within $Minutes minutes; broker remains unchanged."
}

try {
  $mode=if($CandidateOnly){'candidate-only'}elseif($BrokerOnly){'broker-only'}else{'candidate+broker'}
  Write-Host "REVEX current Render deployment - $mode" -ForegroundColor Cyan
  Write-Host "Source: $SourceCandidate"
  Write-Host "Candidate service: $Service"
  Write-Host "Contract: private persistent GPU, source-bound image, server warm proof before broker cutover." -ForegroundColor Green

  foreach($required in @($FunctionsDir,$CloudBuild,(Join-Path $Root 'REVEX_CURRENT_RELEASE.json'),(Join-Path $Root '.github\scripts\verify-revex-r127-single-controller.py'))){
    if(-not(Test-Path -LiteralPath $required)){throw "Render deployment source is incomplete: $required"}
  }
  $GCloud=Require-Command 'gcloud'
  $Python=Require-Command 'python'
  Require-Ok "Validate full current REVEX revision before Render cloud changes" $Python @('.github\scripts\verify-revex-r127-single-controller.py')
  $auth=Capture-Native $GCloud @('auth','list','--filter','status:ACTIVE','--format','value(account)')
  if($auth.Code-ne 0-or-not $auth.Text){throw 'Google Cloud administrator sign-in is required before Render deployment.'}
  $Deployer=($auth.Text -split "`n")[0].Trim()
  $Bucket=Resolve-FirebaseBucket $GCloud

  if(-not $BrokerOnly){
    Require-Ok 'Select Google Cloud project' $GCloud @('config','set','project',$ProjectId) -Quiet
    Require-Ok 'Enable Render infrastructure APIs' $GCloud @('services','enable','run.googleapis.com','cloudbuild.googleapis.com','artifactregistry.googleapis.com','iamcredentials.googleapis.com','cloudfunctions.googleapis.com','firestore.googleapis.com','serviceusage.googleapis.com','--project',$ProjectId) -Quiet
    $null=Ensure-ServiceAccount $GCloud 'revex-render-worker' 'REVEX Render Worker'
    $null=Ensure-ServiceAccount $GCloud 'revex-render-broker' 'REVEX Render Broker'
    Add-ServiceAccountUser $GCloud $WorkerSa "user:$Deployer" 'Allow deployer to use Render worker identity'
    Add-ServiceAccountUser $GCloud $BrokerSa "user:$Deployer" 'Allow deployer to use Render broker identity'
    Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" 'roles/storage.objectAdmin' 'Grant Render worker persistent cache/result storage'
    Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" 'roles/datastore.user' 'Grant Render worker job progress access'
    Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" 'roles/storage.objectAdmin' 'Grant Render broker snapshot access'
    Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" 'roles/datastore.user' 'Grant Render broker job access'
    if(-not(Native-Ok $GCloud @('artifacts','repositories','describe',$Repository,'--location',$Region,'--project',$ProjectId))){
      Require-Ok 'Create REVEX Artifact Registry repository' $GCloud @('artifacts','repositories','create',$Repository,'--repository-format','docker','--location',$Region,'--project',$ProjectId,'--description','REVEX managed runtimes') -Quiet
    }
    Require-Ok 'Build exact current Render worker image' $GCloud @('builds','submit',$Root,'--project',$ProjectId,'--config',$CloudBuild,'--substitutions',"_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-render-worker,_TAG=$ImageTag")
    Require-Ok 'Deploy private warm Render candidate' $GCloud @(
      'run','deploy',$Service,'--project',$ProjectId,'--region',$Region,'--platform','managed',
      '--image',$Image,'--service-account',$WorkerSa,'--no-allow-unauthenticated',
      '--execution-environment=gen2','--cpu=20','--memory=80Gi','--no-cpu-throttling',
      '--gpu=1','--gpu-type=nvidia-rtx-pro-6000','--no-gpu-zonal-redundancy',
      '--concurrency=1','--min-instances=1','--max-instances=1','--timeout=3600',
      '--add-volume',"mount-path=$MountPath,type=cloud-storage,bucket=$Bucket,readonly=false",
      '--set-env-vars',"HF_HOME=$MountPath/huggingface,REVEX_MODEL_CACHE_DIR=$ModelCache,REVEX_WARM_MARKER=$WarmMarker,REVEX_WARM_TOKEN=$WarmToken,REVEX_SOURCE_CANDIDATE=$SourceCandidate,HF_HUB_ETAG_TIMEOUT=120,HF_HUB_DOWNLOAD_TIMEOUT=900,HF_HUB_DISABLE_TELEMETRY=1,HF_XET_HIGH_PERFORMANCE=1,HF_ENABLE_PARALLEL_LOADING=YES",
      '--quiet')
    $Candidate=Resolve-Candidate $GCloud
    $runText=$Candidate.Run|ConvertTo-Json -Depth 50
    if($runText-notmatch '"minInstanceCount"\s*:\s*1' -and $runText-notmatch '"autoscaling\.knative\.dev/minScale"\s*:\s*"1"'){throw 'Render candidate did not retain min-instances=1.'}
    Write-Host 'Worker service is up; waiting for server-side model residency proof...' -ForegroundColor Yellow
    Assert-Warm $GCloud $Bucket $Candidate 35
    Require-Ok 'Allow only REVEX Render broker to invoke candidate' $GCloud @('run','services','add-iam-policy-binding',$Service,'--project',$ProjectId,'--region',$Region,'--member',"serviceAccount:$BrokerSa",'--role','roles/run.invoker','--quiet') -Quiet
    Write-Host 'PASS: Render candidate is source-bound, warm and private; live broker has not changed yet.' -ForegroundColor Green
    if($CandidateOnly){$ExitCode=0;return}
  }

  $Candidate=Resolve-Candidate $GCloud
  Assert-Warm $GCloud $Bucket $Candidate 2
  $Npm=Require-Command 'npm';$Node=Require-Command 'node'
  Require-Ok 'Install pinned Render broker dependencies' $Npm @('install','--ignore-scripts','--no-audit','--no-fund')
  Push-Location $FunctionsDir
  try {
    $package=Get-Content -LiteralPath (Join-Path $FunctionsDir 'package.json') -Raw|ConvertFrom-Json
    if([string]$package.engines.node-ne '22'){throw 'REVEX render broker package.json must pin engines.node to 22.'}
    Require-Ok 'Preflight callable Render broker export' $Node @('-e',"const m=require('./index.js');if(typeof m.runRevexRender!=='function')throw new Error('runRevexRender export missing');console.log('REVEX render broker module OK')")
  } finally {Pop-Location}
  Require-Ok 'Cut authenticated Render broker over to verified candidate' $GCloud @(
    'functions','deploy','runRevexRender','--gen2','--region',$Region,'--project',$ProjectId,
    '--runtime','nodejs22','--source',$FunctionsDir,'--entry-point','runRevexRender','--trigger-http','--allow-unauthenticated','--service-account',$BrokerSa,
    '--set-env-vars',"REVEX_RENDER_WORKER_URL=$($Candidate.Url),REVEX_RENDER_BROKER_SERVICE_ACCOUNT=$BrokerSa,REVEX_STORAGE_BUCKET=$Bucket,REVEX_SOURCE_CANDIDATE=$SourceCandidate",
    '--memory','1GiB','--timeout','3600s','--concurrency','4','--max-instances','4','--quiet')
  $function=Capture-Native $GCloud @('functions','describe','runRevexRender','--gen2','--project',$ProjectId,'--region',$Region,'--format','json')
  if($function.Code-ne 0-or-not $function.Text){throw 'Render broker could not be verified after cutover.'}
  $live=$function.Text|ConvertFrom-Json
  if([string]$live.state-ne 'ACTIVE'){throw 'Render broker is not ACTIVE after cutover.'}
  if([string]$live.buildConfig.runtime-ne 'nodejs22'){throw 'Render broker runtime is not nodejs22.'}
  if([string]$live.serviceConfig.environmentVariables.REVEX_RENDER_WORKER_URL-ne [string]$Candidate.Url){throw 'Render broker worker binding mismatch.'}
  if([string]$live.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE-ne $SourceCandidate){throw 'Render broker source SHA mismatch.'}
  if([string]$live.serviceConfig.environmentVariables.REVEX_STORAGE_BUCKET-ne $Bucket){throw 'Render broker storage binding mismatch.'}
  Write-Host 'PASS: current Render broker is ACTIVE on the verified warm source-bound candidate.' -ForegroundColor Green
  $ExitCode=0
}
catch{
  Write-Host "REVEX current Render deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  if(-not $BrokerOnly){Write-Host 'A failed candidate never cuts the live Render broker over.' -ForegroundColor Yellow}
  $ExitCode=1
}
finally{
  if(-not $NoPause-and $Host.Name-match 'ConsoleHost'){Write-Host 'Press Enter to close.';[void](Read-Host)}
}
exit $ExitCode
