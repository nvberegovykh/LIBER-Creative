param(
  [string]$ProjectId = "liber-apps-cca20",
  [ValidateSet("us-central1")][string]$Region = "us-central1",
  [ValidateSet("europe-west1")][string]$FallbackRegion = "europe-west1",
  [string]$StorageBucket = "",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$ChatOnly,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Source = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ChatSource = Join-Path $Root 'server\firebase-functions'
$Verifier = Join-Path $Root '.github\scripts\verify-revex-current-release.py'
$ReportSecurityVerifier = Join-Path $Root '.github\scripts\verify-revex-report-security.js'
$ReportSa = "revex-report-worker@$ProjectId.iam.gserviceaccount.com"
$AuthReaderRoleId = 'revexAuthRevocationReader'
$FcmSenderRoleId = 'revexFcmMessageSender'
$ExitCode = 1
$Bucket = ""

function Require-Command([string]$Name){$cmd=Get-Command $Name -ErrorAction SilentlyContinue|Select-Object -First 1;if(-not $cmd){throw "$Name is required."};return $cmd.Source}
function Invoke-Native([string]$Command,[string[]]$Arguments,[switch]$Quiet){$previous=$ErrorActionPreference;try{$ErrorActionPreference='Continue';if($Quiet){& $Command @Arguments *> $null}else{& $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)}};$code=$LASTEXITCODE;if($null-eq $code){$code=0};return [int]$code}finally{$ErrorActionPreference=$previous}}
function Capture-Native([string]$Command,[string[]]$Arguments){$previous=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$lines=@(& $Command @Arguments 2>$null|ForEach-Object{[string]$_});$code=$LASTEXITCODE;if($null-eq $code){$code=0};return [pscustomobject]@{Code=[int]$code;Text=($lines-join "`n").Trim()}}finally{$ErrorActionPreference=$previous}}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments,[switch]$Quiet){Write-Host ">> $Label" -ForegroundColor DarkCyan;$code=Invoke-Native $Command $Arguments -Quiet:$Quiet;if($code-ne 0){throw "$Label failed with exit code $code."}}
function Native-Ok([string]$Command,[string[]]$Arguments){return (Invoke-Native $Command $Arguments -Quiet)-eq 0}
function Resolve-Bucket([string]$GCloud,[string]$RequestedBucket){
  $rows=Capture-Native $GCloud @('storage','buckets','list','--project',$ProjectId,'--format','value(name)');if($rows.Code-ne 0){throw 'Could not enumerate project Storage buckets.'}
  $prefix=[Regex]::Escape($ProjectId);$names=@($rows.Text -split "`n"|ForEach-Object{$_.Trim().TrimEnd('/') -replace '^gs://',''}|Where-Object{$_}|Select-Object -Unique);$matches=@($names|Where-Object{$_ -match "^$prefix\.(?:appspot\.com|firebasestorage\.app)$"})
  if($RequestedBucket){
    $requested=$RequestedBucket.Trim().TrimEnd('/') -replace '^gs://',''
    if($requested-notmatch "^$prefix\.(?:appspot\.com|firebasestorage\.app)$"){throw "StorageBucket is not a Firebase bucket owned by $ProjectId: $requested"}
    if($requested-notin $matches){throw "The requested Storage bucket is not present in $ProjectId: $requested"}
    return [string]$requested
  }
  $modern="$ProjectId.firebasestorage.app"
  if($modern-in $matches){return $modern}
  if($matches.Count-ne 1){throw "Firebase Storage is ambiguous for $ProjectId; pass -StorageBucket. Found: $($matches -join ', ')."}
  return [string]$matches[0]
}
function Add-Role([string]$GCloud,[string]$Role,[string]$Label){Require-Ok $Label $GCloud @('projects','add-iam-policy-binding',$ProjectId,'--member',"serviceAccount:$ReportSa",'--role',$Role,'--quiet') -Quiet}
function Ensure-AuthRevocationReader([string]$GCloud){
  $roleName="projects/$ProjectId/roles/$AuthReaderRoleId"
  $describe=Capture-Native $GCloud @('iam','roles','describe',$AuthReaderRoleId,'--project',$ProjectId,'--format','value(name)')
  if($describe.Code-ne 0-or-not $describe.Text){
    Require-Ok 'Create least-privilege Firebase Auth revocation reader role' $GCloud @('iam','roles','create',$AuthReaderRoleId,'--project',$ProjectId,'--title','REVEX Firebase Auth Revocation Reader','--description','Allows verifyIdToken(checkRevoked) to read one Firebase Auth user record.','--permissions','firebaseauth.users.get','--stage','GA','--quiet') -Quiet
  }else{
    Require-Ok 'Reconcile least-privilege Firebase Auth revocation reader role' $GCloud @('iam','roles','update',$AuthReaderRoleId,'--project',$ProjectId,'--title','REVEX Firebase Auth Revocation Reader','--description','Allows verifyIdToken(checkRevoked) to read one Firebase Auth user record.','--permissions','firebaseauth.users.get','--stage','GA','--quiet') -Quiet
  }
  Add-Role $GCloud $roleName 'Grant only Firebase Auth user-read permission for revocation checks'
}
function Ensure-FcmMessageSender([string]$GCloud){
  $roleName="projects/$ProjectId/roles/$FcmSenderRoleId"
  $describe=Capture-Native $GCloud @('iam','roles','describe',$FcmSenderRoleId,'--project',$ProjectId,'--format','value(name)')
  if($describe.Code-ne 0-or-not $describe.Text){
    Require-Ok 'Create least-privilege Firebase Cloud Messaging sender role' $GCloud @('iam','roles','create',$FcmSenderRoleId,'--project',$ProjectId,'--title','REVEX FCM Message Sender','--description','Allows the encrypted-chat trigger to send FCM messages only.','--permissions','firebasecloudmessaging.messages.create','--stage','GA','--quiet') -Quiet
  }else{
    Require-Ok 'Reconcile least-privilege Firebase Cloud Messaging sender role' $GCloud @('iam','roles','update',$FcmSenderRoleId,'--project',$ProjectId,'--title','REVEX FCM Message Sender','--description','Allows the encrypted-chat trigger to send FCM messages only.','--permissions','firebasecloudmessaging.messages.create','--stage','GA','--quiet') -Quiet
  }
  Add-Role $GCloud $roleName 'Grant only Firebase Cloud Messaging send permission'
}
function Verify-Function([string]$GCloud,[string]$FunctionName,[string]$FunctionRegion=$Region,[switch]$RequiresStorage){
  $state=Capture-Native $GCloud @('functions','describe',$FunctionName,'--gen2','--project',$ProjectId,'--region',$FunctionRegion,'--format','json');if($state.Code-ne 0-or-not $state.Text){throw "$FunctionName could not be verified after deployment in $FunctionRegion."};$fn=$state.Text|ConvertFrom-Json
  if([string]$fn.state-ne 'ACTIVE'){throw "$FunctionName is not ACTIVE after deployment."}
  if([string]$fn.buildConfig.runtime-ne 'nodejs22'){throw "$FunctionName runtime is not nodejs22."}
  if([string]$fn.serviceConfig.serviceAccountEmail-ne $ReportSa){throw "$FunctionName is not attached to the controlled project-runtime identity."}
  if([string]$fn.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE-ne $SourceCandidate){throw "$FunctionName source SHA does not match the current release."}
  if($RequiresStorage-and[string]$fn.serviceConfig.environmentVariables.REVEX_STORAGE_BUCKET-ne $Bucket){throw "$FunctionName Storage binding mismatch."}
  if($FunctionName-in @('documentRevexRevision','onChatMessageWrite')-and[string]$fn.eventTrigger.serviceAccountEmail-ne $ReportSa){throw "$FunctionName Eventarc trigger is not attached to the controlled project-runtime identity."}
  if($FunctionName-eq 'ensureProjectChatHttp'){
    if([string]$fn.serviceConfig.availableCpu-ne '1'){throw 'ensureProjectChatHttp must run with exactly 1 vCPU so concurrency > 1 is valid.'}
    if([int]$fn.serviceConfig.maxInstanceRequestConcurrency-ne 20){throw 'ensureProjectChatHttp concurrency must remain exactly 20.'}
  }
  return $fn
}

try{
  if($ChatOnly){Write-Host 'REVEX current Project Chat + secure device services deployment' -ForegroundColor Cyan}else{Write-Host 'REVEX current revision-documentation + Daily Report + Project Chat + secure device services deployment' -ForegroundColor Cyan}
  Write-Host "Source: $SourceCandidate"
  Write-Host 'Authority: Secure Chat remains the message/storage/UI owner; REVEX Project Chat only resolves project identity and preserves an existing crypto key.' -ForegroundColor Green
  foreach($required in @(
    (Join-Path $Root 'REVEX_CURRENT_RELEASE.json'),$Verifier,
    (Join-Path $Source 'index.js'),(Join-Path $Source 'report-security.js'),(Join-Path $Source 'pdf-text-worker.js'),(Join-Path $Source 'package.json'),(Join-Path $Source 'package-lock.json'),$ReportSecurityVerifier,
    (Join-Path $ChatSource 'main.js'),(Join-Path $ChatSource 'project-chat.js'),(Join-Path $ChatSource 'project-access.js'),(Join-Path $ChatSource 'package.json')
  )){if(-not(Test-Path -LiteralPath $required)){throw "Project-runtime function deployment source is incomplete: $required"}}

  $GCloud=Require-Command 'gcloud';$Npm=Require-Command 'npm';$Node=Require-Command 'node';$Python=Require-Command 'python'
  Push-Location $Root
  try{
    Require-Ok 'Validate full current REVEX revision before project-runtime cloud changes' $Python @($Verifier)
    Require-Ok 'Validate hostile Report PDF and cross-project object boundaries' $Node @($ReportSecurityVerifier)
    Require-Ok 'Validate Project Chat composition syntax' $Node @('--check',(Join-Path $ChatSource 'main.js'))
    Require-Ok 'Validate Project Chat boundary syntax' $Node @('--check',(Join-Path $ChatSource 'project-chat.js'))
  }finally{Pop-Location}
  $auth=Capture-Native $GCloud @('auth','list','--filter','status:ACTIVE','--format','value(account)');if($auth.Code-ne 0-or-not $auth.Text){throw 'Google Cloud administrator sign-in is required.'};$Deployer=($auth.Text -split "`n")[0].Trim()
  Require-Ok 'Select Google Cloud project' $GCloud @('config','set','project',$ProjectId) -Quiet
  Require-Ok 'Enable project-runtime function infrastructure APIs' $GCloud @('services','enable','cloudfunctions.googleapis.com','run.googleapis.com','eventarc.googleapis.com','firestore.googleapis.com','cloudbuild.googleapis.com','artifactregistry.googleapis.com','identitytoolkit.googleapis.com','fcm.googleapis.com','--project',$ProjectId) -Quiet
  if(-not(Native-Ok $GCloud @('iam','service-accounts','describe',$ReportSa,'--project',$ProjectId))){Require-Ok 'Create REVEX Project Runtime Worker identity' $GCloud @('iam','service-accounts','create','revex-report-worker','--display-name','REVEX Project Runtime Worker','--project',$ProjectId) -Quiet}
  Require-Ok 'Allow deployer to use Project Runtime Worker identity' $GCloud @('iam','service-accounts','add-iam-policy-binding',$ReportSa,'--project',$ProjectId,'--member',"user:$Deployer",'--role','roles/iam.serviceAccountUser','--quiet') -Quiet
  Add-Role $GCloud 'roles/datastore.user' 'Grant project-runtime Firestore access'
  Add-Role $GCloud 'roles/run.invoker' 'Grant project-runtime trigger invocation'
  Add-Role $GCloud 'roles/eventarc.eventReceiver' 'Grant Project Chat push trigger Eventarc receipt'
  Ensure-AuthRevocationReader $GCloud
  Ensure-FcmMessageSender $GCloud
  $firestore=Capture-Native $GCloud @('firestore','databases','describe','--database=(default)','--project',$ProjectId,'--format','value(locationId)');if($firestore.Code-ne 0-or-not $firestore.Text){throw 'Could not resolve the Firestore database location.'};$TriggerLocation=($firestore.Text -split "`n")[0].Trim()

  if(-not $ChatOnly){
    Add-Role $GCloud 'roles/storage.objectAdmin' 'Grant Report Storage access'
    $Bucket=Resolve-Bucket $GCloud $StorageBucket
    Push-Location $Source
    try{
      Require-Ok 'npm ci --ignore-scripts --no-audit --no-fund' $Npm @('ci','--ignore-scripts','--no-audit','--no-fund')
      Require-Ok 'npm audit --omit=dev --audit-level=high' $Npm @('audit','--omit=dev','--audit-level=high','--no-fund')
      $DependencyGate=@'
const fs=require('node:fs'),path=require('node:path');
const manifests=[['pdf-parse/package.json','2.4.5','pdf-parse@2.4.5'],['pdfjs-dist/package.json','5.4.296','pdfjs-dist@5.4.296'],['uuid/package.json','11.1.1','uuid@11.1.1']];
for(const [relative,expected,label] of manifests){const file=path.join(process.cwd(),'node_modules',relative);if(!fs.existsSync(file))throw new Error('Missing installed '+relative);const actual=JSON.parse(fs.readFileSync(file,'utf8')).version;if(actual!==expected)throw new Error(relative+' resolved '+actual+' instead of '+expected);console.log(label);}
'@
      Require-Ok 'Verify exact installed Report parser and transitive security metadata' $Node @('-e',$DependencyGate)
      Require-Ok 'Syntax-check isolated Report PDF parser' $Node @('--check',(Join-Path $Source 'pdf-text-worker.js'))
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
  }

  # Secure Chat remains the application/message/storage owner. This endpoint only
  # resolves the exact active REVEX project after Firebase bearer auth. Existing
  # connection keys are preserved; project identity is stored separately.
  $chatEnvs="REVEX_SOURCE_CANDIDATE=$SourceCandidate"
  $HttpRegions=@($Region,$FallbackRegion)|Where-Object{$_}|Select-Object -Unique
  foreach($DeployRegion in $HttpRegions){
    Require-Ok "Deploy source-bound authenticated Project Chat resolver in $DeployRegion" $GCloud @(
      'functions','deploy','ensureProjectChatHttp','--gen2','--project',$ProjectId,'--region',$DeployRegion,
      '--runtime','nodejs22','--source',$ChatSource,'--entry-point','ensureProjectChatHttp','--trigger-http','--allow-unauthenticated','--service-account',$ReportSa,
      '--set-env-vars',$chatEnvs,'--memory','512MiB','--cpu','1','--timeout','60s','--concurrency','20','--max-instances','4','--quiet')
    Require-Ok "Deploy recent-auth Secure Chat identity recovery in $DeployRegion" $GCloud @(
      'functions','deploy','recoverSecureChatIdentityHttp','--gen2','--project',$ProjectId,'--region',$DeployRegion,
      '--runtime','nodejs22','--source',$ChatSource,'--entry-point','recoverSecureChatIdentityHttp','--trigger-http','--allow-unauthenticated','--service-account',$ReportSa,
      '--set-env-vars',$chatEnvs,'--memory','512MiB','--cpu','1','--timeout','60s','--concurrency','20','--max-instances','4','--quiet')
    Require-Ok "Deploy authenticated private FCM registration in $DeployRegion" $GCloud @(
      'functions','deploy','saveFcmTokenHttp','--gen2','--project',$ProjectId,'--region',$DeployRegion,
      '--runtime','nodejs22','--source',$ChatSource,'--entry-point','saveFcmTokenHttp','--trigger-http','--allow-unauthenticated','--service-account',$ReportSa,
      '--set-env-vars',$chatEnvs,'--memory','512MiB','--cpu','1','--timeout','30s','--concurrency','40','--max-instances','4','--quiet')
  }
  Require-Ok 'Deploy bounded encrypted-chat FCM sender trigger' $GCloud @(
    'functions','deploy','onChatMessageWrite','--gen2','--project',$ProjectId,'--region',$Region,
    '--runtime','nodejs22','--source',$ChatSource,'--entry-point','onChatMessageWrite','--service-account',$ReportSa,'--trigger-service-account',$ReportSa,
    '--trigger-location',$TriggerLocation,'--trigger-event-filters=type=google.cloud.firestore.document.v1.created','--trigger-event-filters=database=(default)','--trigger-event-filters-path-pattern=document=chatMessages/{connId}/messages/{messageId}',
    '--set-env-vars',$chatEnvs,'--memory','256MiB','--timeout','60s','--max-instances','10','--retry','--quiet')

  if(-not $ChatOnly){
    $null=Verify-Function $GCloud 'documentRevexRevision' -RequiresStorage
    $null=Verify-Function $GCloud 'finalizeRevexDailyReport' -RequiresStorage
  }
  foreach($VerifyRegion in $HttpRegions){
    $null=Verify-Function $GCloud 'ensureProjectChatHttp' $VerifyRegion
    $null=Verify-Function $GCloud 'recoverSecureChatIdentityHttp' $VerifyRegion
    $null=Verify-Function $GCloud 'saveFcmTokenHttp' $VerifyRegion
  }
  $null=Verify-Function $GCloud 'onChatMessageWrite' $Region
  if($ChatOnly){Write-Host 'PASS: Project Chat HTTP region failover, recent-auth recovery, private FCM registration and bounded push sender are ACTIVE and source-bound.' -ForegroundColor Green}else{Write-Host 'PASS: Daily Report, revision documentation, Project Chat and secure device services are ACTIVE and source-bound; regional HTTP failover and bounded push delivery are verified.' -ForegroundColor Green}
  $ExitCode=0
}catch{
  Write-Host "REVEX current project-runtime function deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode=1
}finally{
  if(-not $NoPause-and $Host.Name-match 'ConsoleHost'){Write-Host 'Press Enter to close.';[void](Read-Host)}
}
exit $ExitCode
