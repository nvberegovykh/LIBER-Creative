param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [switch]$NoPause
)

$ErrorActionPreference="Stop"
Set-StrictMode -Version 3.0
$Source=$PSScriptRoot
$ReportSa="revex-report-worker@$ProjectId.iam.gserviceaccount.com"
$ExitCode=1

function Require-Command([string]$Name){$cmd=Get-Command $Name -ErrorAction SilentlyContinue|Select-Object -First 1;if(-not$cmd){throw "$Name is required."};return $cmd.Source}
function Invoke-Native([string]$Command,[string[]]$Arguments,[switch]$Quiet){$old=$ErrorActionPreference;try{$ErrorActionPreference="Continue";if($Quiet){&$Command @Arguments *> $null}else{&$Command @Arguments 2>&1|ForEach-Object{Write-Host([string]$_)}};$code=$LASTEXITCODE;if($null-eq$code){$code=0};return[int]$code}finally{$ErrorActionPreference=$old}}
function Capture([string]$Command,[string[]]$Arguments){$old=$ErrorActionPreference;try{$ErrorActionPreference="Continue";$lines=@(&$Command @Arguments 2>$null|ForEach-Object{[string]$_});$code=$LASTEXITCODE;if($null-eq$code){$code=0};return[pscustomobject]@{Code=[int]$code;Text=($lines-join"`n").Trim()}}finally{$ErrorActionPreference=$old}}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments){Write-Host ">> $Label" -ForegroundColor DarkCyan;if((Invoke-Native $Command $Arguments)-ne0){throw "$Label failed."}}
function Native-Ok([string]$Command,[string[]]$Arguments){return(Invoke-Native $Command $Arguments -Quiet)-eq0}
function Resolve-Bucket([string]$GCloud){$rows=Capture $GCloud @("storage","buckets","list","--project",$ProjectId,"--format=value(name)");if($rows.Code-ne0){throw"Could not enumerate project buckets."};$p=[Regex]::Escape($ProjectId);$names=@($rows.Text-split"`n"|ForEach-Object{$_.Trim().TrimEnd('/')-replace'^gs://',''}|Where-Object{$_});$m=@($names|Where-Object{$_-match"^$p\.(?:appspot\.com|firebasestorage\.app)$"}|Select-Object -Unique);if($m.Count-ne1){throw"Expected exactly one Firebase Storage bucket; found $($m-join', ')."};return[string]$m[0]}
function Add-Role([string]$GCloud,[string]$Role,[string]$Label){Require-Ok $Label $GCloud @("projects","add-iam-policy-binding",$ProjectId,"--member","serviceAccount:$ReportSa","--role",$Role,"--quiet")}
try{
  Write-Host "REVEX r126 revision-documentation + Daily Report deployment" -ForegroundColor Cyan
  Write-Host "Trigger: every successful immutable BIM synchronization." -ForegroundColor Green
  Write-Host "Authority: deterministic revision diff + native affected plans + active issues. WALLT is grounding-only and fail-soft." -ForegroundColor Green
  $GCloud=Require-Command"gcloud";$Npm=Require-Command"npm";$Node=Require-Command"node"
  $auth=Capture $GCloud @("auth","list","--filter=status:ACTIVE","--format=value(account)");if($auth.Code-ne0-or-not$auth.Text){throw"Google Cloud administrator sign-in is required."}
  $Deployer=($auth.Text-split"`n")[0].Trim()
  Require-Ok"Select Google Cloud project"$GCloud@("config","set","project",$ProjectId)
  Require-Ok"Enable report-worker APIs"$GCloud@("services","enable","cloudfunctions.googleapis.com","run.googleapis.com","eventarc.googleapis.com","firestore.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com","--project",$ProjectId)
  if(-not(Native-Ok $GCloud @("iam","service-accounts","describe",$ReportSa,"--project",$ProjectId))){Require-Ok"Create REVEX Report Worker identity"$GCloud@("iam","service-accounts","create","revex-report-worker","--display-name","REVEX Report Worker","--project",$ProjectId)}
  Require-Ok"Allow deployer to use Report Worker identity"$GCloud@("iam","service-accounts","add-iam-policy-binding",$ReportSa,"--project",$ProjectId,"--member","user:$Deployer","--role","roles/iam.serviceAccountUser","--quiet")
  Add-Role $GCloud "roles/datastore.user" "Grant report Firestore access"
  Add-Role $GCloud "roles/storage.objectAdmin" "Grant report Storage access"
  Add-Role $GCloud "roles/eventarc.eventReceiver" "Grant report Eventarc receipt"
  Add-Role $GCloud "roles/run.invoker" "Grant report trigger invocation"
  $Bucket=Resolve-Bucket $GCloud
  $firestore=Capture $GCloud @("firestore","databases","describe","--database=(default)","--project",$ProjectId,"--format=value(locationId)");if($firestore.Code-ne0-or-not$firestore.Text){throw"Could not resolve the Firestore database location."};$TriggerLocation=($firestore.Text-split"`n")[0].Trim()
  Write-Host "Firestore trigger location: $TriggerLocation" -ForegroundColor Green
  Write-Host "Report storage: gs://$Bucket" -ForegroundColor Green
  Require-Ok"Install pinned report-worker dependencies"$Npm@("install","--ignore-scripts","--no-audit","--no-fund")
  Require-Ok"Static-load report worker"$Node@("-e","const m=require('./index.js');if(typeof m.documentRevexRevision!=='function'||typeof m.finalizeRevexDailyReport!=='function')throw new Error('report exports missing');console.log('REVEX report module OK')")

  $envs="REVEX_STORAGE_BUCKET=$Bucket,REVEX_WALLT_PROXY_URL=https://europe-west1-$ProjectId.cloudfunctions.net/openaiProxy,REVEX_WALLT_MODEL=gpt-4.1"
  Require-Ok"Deploy post-sync revision documentation trigger"$GCloud@(
    "functions","deploy","documentRevexRevision","--gen2","--project",$ProjectId,"--region",$Region,"--runtime","nodejs22","--source",$Source,"--entry-point","documentRevexRevision","--service-account",$ReportSa,
    "--trigger-location",$TriggerLocation,
    "--trigger-event-filters=type=google.cloud.firestore.document.v1.created",
    "--trigger-event-filters=database=(default)",
    "--trigger-event-filters-path-pattern=document=projects/{projectId}/revexRevisions/{revision}",
    "--set-env-vars",$envs,"--memory","2GiB","--timeout","540s","--max-instances","2","--retry","--quiet")
  Require-Ok"Deploy authenticated manual Daily Report finalizer"$GCloud@(
    "functions","deploy","finalizeRevexDailyReport","--gen2","--project",$ProjectId,"--region",$Region,"--runtime","nodejs22","--source",$Source,"--entry-point","finalizeRevexDailyReport","--trigger-http","--allow-unauthenticated","--service-account",$ReportSa,"--set-env-vars",$envs,"--memory","2GiB","--timeout","540s","--concurrency","2","--max-instances","2","--quiet")
  foreach($fn in@("documentRevexRevision","finalizeRevexDailyReport")){$state=Capture $GCloud @("functions","describe",$fn,"--gen2","--project",$ProjectId,"--region",$Region,"--format=value(state)");if($state.Code-ne0-or$state.Text.Trim()-ne"ACTIVE"){throw"$fn is not ACTIVE after deployment; state=$($state.Text)."}}
  Write-Host"PASS: r126 Daily Report worker + post-sync trigger are ACTIVE."-ForegroundColor Green
  $ExitCode=0
}catch{Write-Host"REVEX r126 report deployment stopped safely: $($_.Exception.Message)"-ForegroundColor Red;$ExitCode=1}
finally{if(-not$NoPause-and$Host.Name-match'ConsoleHost'){Write-Host"Press Enter to close.";[void](Read-Host)}}
exit $ExitCode
