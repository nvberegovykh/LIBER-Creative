param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Source = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ChatSource = Join-Path $Root 'server\firebase-functions'
$Verifier = Join-Path $Root '.github\scripts\verify-revex-current-release.py'
$ReportSa = "revex-report-worker@$ProjectId.iam.gserviceaccount.com"
$ExitCode = 1

function Require-Command([string]$Name){$cmd=Get-Command $Name -ErrorAction SilentlyContinue|Select-Object -First 1;if(-not $cmd){throw "$Name is required."};return $cmd.Source}
function Invoke-Native([string]$Command,[string[]]$Arguments,[switch]$Quiet){$previous=$ErrorActionPreference;try{$ErrorActionPreference='Continue';if($Quiet){& $Command @Arguments *> $null}else{& $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)}};$code=$LASTEXITCODE;if($null-eq $code){$code=0};return [int]$code}finally{$ErrorActionPreference=$previous}}
function Capture-Native([string]$Command,[string[]]$Arguments){$previous=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$lines=@(& $Command @Arguments 2>$null|ForEach-Object{[string]$_});$code=$LASTEXITCODE;if($null-eq $code){$code=0};return [pscustomobject]@{Code=[int]$code;Text=($lines-join "`n").Trim()}}finally{$ErrorActionPreference=$previous}}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments,[switch]$Quiet){Write-Host ">> $Label" -ForegroundColor DarkCyan;$code=Invoke-Native $Command $Arguments -Quiet:$Quiet;if($code-ne 0){throw "$Label failed with exit code $code."}}
function Native-Ok([string]$Command,[string[]]$Arguments){return (Invoke-Native $Command $Arguments -Quiet)-eq 0}
function Resolve-Bucket([string]$GCloud){
  $rows=Capture-Native $GCloud @('storage','buckets','list','--project',$ProjectId,'--format','value(name)');if($rows.Code-ne 0){throw 'Could not enumerate project Storage buckets.'}
  $prefix=[Regex]::Escape($ProjectId);$names=@($rows.Text -split "`n"|ForEach-Object{$_.Trim().TrimEnd('/') -replace '^gs://',''}|Where-Object{$_});$matches=@($names|Where-Object{$_ -match "^$prefix\.(?:appspot\.com|firebasestorage\.app)$"}|Select-Object -Unique)
  if($matches.Count-ne 1){throw "Expected exactly one Firebase Storage bucket for $ProjectId; found $($matches -join ', ')."};return [string]$matches[0]
}
function Add-Role([string]$GCloud,[string]$Role,[string]$Label){Require-Ok $Label $GCloud @('projects','add-iam-policy-binding',$ProjectId,'--member',"serviceAccount:$ReportSa",'--role',$Role,'--quiet') -Quiet}
function Verify-Function([string]$GCloud,[string]$FunctionName,[switch]$RequiresStorage){
  $state=Capture-Native $GCloud @('functions','describe',$FunctionName,'--gen2','--project',$ProjectId,'--region',$Region,'--format','json');if($state.Code-ne 0-or-not $state.Text){throw "$FunctionName could not be verified after deployment."};$fn=$state.Text|ConvertFrom-Json
  if([string]$fn.state-ne 'ACTIVE'){throw "$FunctionName is not ACTIVE after deployment."}
  if([string]$fn.buildConfig.runtime-ne 'nodejs22'){throw "$FunctionName runtime is not nodejs22."}
  if([string]$fn.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE-ne $SourceCandidate){throw "$FunctionName source SHA does not match the current release."}
  if($RequiresStorage-and[string]$fn.serviceConfig.environmentVariables.REVEX_STORAGE_BUCKET-ne $Bucket){throw "$FunctionName Storage binding mismatch."}
  return $fn
}

try{
  Write-Host 'REVEX current revision-documentation + Daily Report + Project Chat deployment' -ForegroundColor Cyan
  Write-Host "Source: $SourceCandidate"
  Write-Host 'Authority: deterministic revision diff + native affected plans + active issues; Secure Chat remains the message/storage owner; technical history remains separate.' -ForegroundColor Green
  foreach($required in @(
    (Join-Path $Root 'REVEX_CURRENT_RELEASE.json'),$Verifier,
    (Join-Path $Source 'index.js'),(Join-Path $Source 'package.json'),
    (Join-Path $ChatSource 'main.js'),(Join-Path $ChatSource 'project-chat.js'),(Join-Path $ChatSource 'project-access.js'),(Join-Path $ChatSource 'package.json')
  )){if(-not(Test-Path -LiteralPath $required)){throw "Project-runtime function deployment source is incomplete: $required"}}

  $GCloud=Require-Command 'gcloud';$Npm=Require-Command 'npm';$Node=Require-Command 'node';$Python=Require-Command 'python'
  Require-Ok 'Validate full current REVEX revision before project-runtime cloud changes' $Python @($Verifier)
  Require-Ok 'Validate Project Chat composition syntax' $Node @('--check',(Join-Path $ChatSource 'main.js'))
  Require-Ok 'Validate Project Chat boundary syntax' $Node @('--check',(Join-Path $ChatSource 'project-chat.js'))
  $auth=Capture-Native $GCloud @('auth','list','--filter','status:ACTIVE','--format','value(account)');if($auth.Code-ne 0-or-not $auth.Text){throw 'Google Cloud administrator sign-in is required.'};$Deployer=($auth.Text -split "`n")[0].Trim()
  Require-Ok 'Select Google Cloud project' $GCloud @('config','set','project',$ProjectId) -Quiet
  Require-Ok 'Enable project-runtime function infrastructure APIs' $GCloud @('services','enable','cloudfunctions.googleapis.com','run.googleapis.com','eventarc.googleapis.com','firestore.googleapis.com','cloudbuild.googleapis.com','artifactregistry.googleapis.com','--project',$ProjectId) -Quiet
  if(-not(Native-Ok $GCloud @('iam','service-accounts','describe',$ReportSa,'--project',$ProjectId))){Require-Ok 'Create REVEX Project Runtime Worker identity' $GCloud @('iam','service-accounts','create','revex-report-worker','--display-name','REVEX Project Runtime Worker','--project',$ProjectId) -Quiet}
  Require-Ok 'Allow deployer to use Project Runtime Worker identity' $GCloud @('iam','service-accounts','add-iam-policy-binding',$ReportSa,'--project',$ProjectId,'--member',"user:$Deployer",'--role','roles/iam.serviceAccountUser','--quiet') -Quiet
  Add-Role $GCloud 'roles/datastore.user' 'Grant project-runtime Firestore access';Add-Role $GCloud 'roles/storage.objectAdmin' 'Grant Report Storage access';Add-Role $GCloud 'roles/eventarc.eventReceiver' 'Grant Report Eventarc receipt';Add-Role $GCloud 'roles/run.invoker' 'Grant project-runtime trigger invocation'

  $Bucket=Resolve-Bucket $GCloud
  $firestore=Capture-Native $GCloud @('firestore','databases','describe','--database=(default)','--project',$ProjectId,'--format','value(locationId)');if($firestore.Code-ne 0-or-not $firestore.Text){throw 'Could not resolve the Firestore database location.'};$TriggerLocation=($firestore.Text -split "`n")[0].Trim()
  Push-Location $Source
  try{
    Require-Ok 'Install pinned Report dependencies' $Npm @('install','--ignore-scripts','--no-audit','--no-fund')
    Require-Ok 'Static-load Report worker' $Node @('-e',"const m=require('./index.js');if(typeof m.documentRevexRevision!=='function'||typeof m.finalizeRevexDailyReport!=='function')throw new Error('report exports missing');console.log('REVEX report module OK')")
  }finally{Pop-Location}

  $envs="REVEX_STORAGE_BUCKET=$Bucket,REVEX_WALLT_PROXY_URL=https://europe-west1-$ProjectId.cloudfunctions.net/openaiProxy,REVEX_WALLT_MODEL=gpt-4.1,REVEX_SOURCE_CANDIDATE=$SourceCandidate"
  Require-Ok 'Deploy source-bound post-sync revision documentation trigger' $GCloud @(
    'functions','deploy','documentRevexRevision','--gen2','--project',$ProjectId,'--region',$Region,
    '--runtime','nodejs22','--source',$Source,'--entry-point','documentRevexRevision','--service-account',$ReportSa,'--trigger-service-account',$ReportSa,
    '--trigger-location',$TriggerLocation,'--trigger-event-filters=type=google.cloud.firestore.document.v1.created','--trigger-event-filters=database=(default)','--trigger-event-filters-path-pattern=document=projects/{projectId}/revexRevisions/{revision}',
    '--set-env-vars',$envs,'--memory','2GiB','--timeout','540s','--max-instances','2','--retry','--quiet')
  Require-Ok 'Deploy source-bound authenticated Daily Report finalizer' $GCloud @(
    'functions','deploy','finalizeRevexDailyReport','--gen2','--project',$ProjectId,'--region',$Region,
    '--runtime','nodejs22','--source',$Source,'--entry-point','finalizeRevexDailyReport','--trigger-http','--allow-unauthenticated','--service-account',$ReportSa,
    '--set-env-vars',$envs,'--memory','2GiB','--timeout','540s','--concurrency','2','--max-instances','2','--quiet')

  # Secure Chat remains the message/storage owner. This endpoint only resolves/repairs the
  # exact active REVEX project's deterministic chat connection after Firebase bearer auth.
  $chatEnvs="REVEX_SOURCE_CANDIDATE=$SourceCandidate"
  Require-Ok 'Deploy source-bound authenticated Project Chat resolver' $GCloud @(
    'functions','deploy','ensureProjectChatHttp','--gen2','--project',$ProjectId,'--region',$Region,
    '--runtime','nodejs22','--source',$ChatSource,'--entry-point','ensureProjectChatHttp','--trigger-http','--allow-unauthenticated','--service-account',$ReportSa,
    '--set-env-vars',$chatEnvs,'--memory','512MiB','--timeout','60s','--concurrency','20','--max-instances','4','--quiet')

  $null=Verify-Function $GCloud 'documentRevexRevision' -RequiresStorage
  $null=Verify-Function $GCloud 'finalizeRevexDailyReport' -RequiresStorage
  $null=Verify-Function $GCloud 'ensureProjectChatHttp'
  Write-Host 'PASS: current Daily Report + revision documentation + Project Chat resolver are ACTIVE and source-bound.' -ForegroundColor Green
  $ExitCode=0
}catch{
  Write-Host "REVEX current project-runtime function deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode=1
}finally{
  if(-not $NoPause-and $Host.Name-match 'ConsoleHost'){Write-Host 'Press Enter to close.';[void](Read-Host)}
}
exit $ExitCode