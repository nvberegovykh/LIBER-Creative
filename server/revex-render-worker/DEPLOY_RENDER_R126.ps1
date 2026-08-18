param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-render-worker-r126",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$CloudBuild = Join-Path $PSScriptRoot "cloudbuild.yaml"
$BaseBrokerDeploy = Join-Path $PSScriptRoot "DEPLOY_RENDER_SERVER.ps1"
$ImageTag = "r126"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-render-worker:$ImageTag"
$WorkerSa = "revex-render-worker@$ProjectId.iam.gserviceaccount.com"
$MountPath = "/mnt/revex-hf-cache"
$ModelCache = "$MountPath/models/Qwen-Image-Edit-2511-6f3ccc0"
$WarmMarker = "$MountPath/revex-render-r126-ready.json"
$WarmToken = [guid]::NewGuid().ToString("N")
$ExitCode = 1

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX Render deployment." }
  return $cmd.Source
}
function Invoke-Native([string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($Quiet) { & $Command @Arguments *> $null }
    else { & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) } }
    $code = $LASTEXITCODE;if ($null -eq $code) { $code = 0 };return [int]$code
  } finally { $ErrorActionPreference = $previous }
}
function Capture-Native([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $lines = @(& $Command @Arguments 2>$null | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE;if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ Code=[int]$code; Text=($lines -join "`n").Trim() }
  } finally { $ErrorActionPreference = $previous }
}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code=Invoke-Native $Command $Arguments
  if($code-ne 0){throw "$Label failed with exit code $code."}
}
function Native-Ok([string]$Command,[string[]]$Arguments){return (Invoke-Native $Command $Arguments -Quiet) -eq 0}
function Ensure-ServiceAccount([string]$GCloud,[string]$Name,[string]$DisplayName){
  $email="$Name@$ProjectId.iam.gserviceaccount.com"
  if(-not (Native-Ok $GCloud @("iam","service-accounts","describe",$email,"--project",$ProjectId))){Require-Ok "Create $DisplayName" $GCloud @("iam","service-accounts","create",$Name,"--display-name",$DisplayName,"--project",$ProjectId)}
  return $email
}
function Resolve-FirebaseBucket([string]$GCloud) {
  $rows=Capture-Native $GCloud @("storage","buckets","list","--project",$ProjectId,"--format=value(name)")
  if($rows.Code-ne 0){throw "Could not enumerate Firebase/Cloud Storage buckets."}
  $prefix=[Regex]::Escape($ProjectId)
  $names=@($rows.Text -split "`n"|ForEach-Object{$_.Trim().TrimEnd('/') -replace '^gs://',''}|Where-Object{$_})
  $matches=@($names|Where-Object{$_ -match "^$prefix\.(?:appspot\.com|firebasestorage\.app)$"}|Select-Object -Unique)
  if($matches.Count-ne 1){throw "Expected exactly one Firebase Storage bucket for $ProjectId; found $($matches -join ', ')."}
  return [string]$matches[0]
}
function Add-ProjectRole([string]$GCloud,[string]$Member,[string]$Role,[string]$Label){Require-Ok $Label $GCloud @("projects","add-iam-policy-binding",$ProjectId,"--member",$Member,"--role",$Role,"--quiet")}

try {
  Write-Host "REVEX r126 Render deployment - warm persistent private GPU" -ForegroundColor Cyan
  Write-Host "Model: Qwen/Qwen-Image-Edit-2511 @ 6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
  Write-Host "Contract: persistent server cache + min instance 1 + server warm proof before broker cutover." -ForegroundColor Green
  Write-Host "Client contract: viewport image + prompt only; no browser/local model inference or 57 GB cache." -ForegroundColor Green

  if(-not(Test-Path -LiteralPath $CloudBuild -PathType Leaf)){throw "Missing $CloudBuild"}
  if(-not(Test-Path -LiteralPath $BaseBrokerDeploy -PathType Leaf)){throw "Missing $BaseBrokerDeploy"}
  $GCloud=Require-Command "gcloud";$null=Require-Command "npm";$null=Require-Command "node"
  $auth=Capture-Native $GCloud @("auth","list","--filter=status:ACTIVE","--format=value(account)")
  if($auth.Code-ne 0-or-not $auth.Text){throw "Google Cloud administrator sign-in is required before deployment."}
  $Deployer=($auth.Text -split "`n")[0].Trim()

  Require-Ok "Select Google Cloud project" $GCloud @("config","set","project",$ProjectId)
  Require-Ok "Enable Render infrastructure APIs" $GCloud @("services","enable","run.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com","iamcredentials.googleapis.com","cloudfunctions.googleapis.com","serviceusage.googleapis.com","--project",$ProjectId)
  $null=Ensure-ServiceAccount $GCloud "revex-render-worker" "REVEX Render Worker"
  Require-Ok "Allow deployer to use Render worker identity" $GCloud @("iam","service-accounts","add-iam-policy-binding",$WorkerSa,"--project",$ProjectId,"--member","user:$Deployer","--role","roles/iam.serviceAccountUser","--quiet")
  Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/storage.objectAdmin" "Grant Render worker persistent cache/result storage"
  Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/datastore.user" "Grant Render worker job progress access"

  if(-not(Native-Ok $GCloud @("artifacts","repositories","describe",$Repository,"--location",$Region,"--project",$ProjectId))){Require-Ok "Create REVEX Artifact Registry" $GCloud @("artifacts","repositories","create",$Repository,"--repository-format","docker","--location",$Region,"--project",$ProjectId,"--description","REVEX managed runtime images")}
  $Bucket=Resolve-FirebaseBucket $GCloud
  Write-Host "Persistent server model storage: gs://$Bucket" -ForegroundColor Green

  Require-Ok "Build exact r126 Render worker image" $GCloud @("builds","submit",$Root,"--project",$ProjectId,"--config",$CloudBuild,"--substitutions","_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-render-worker,_TAG=$ImageTag")

  # Deploy a new service name so the current renderer remains untouched until the
  # replacement has loaded the entire pinned model and proven readiness.
  Require-Ok "Deploy warm private RTX PRO 6000 Render worker" $GCloud @(
    "run","deploy",$Service,"--project",$ProjectId,"--region",$Region,"--platform","managed",
    "--image",$Image,"--service-account",$WorkerSa,"--no-allow-unauthenticated",
    "--execution-environment=gen2","--cpu=20","--memory=80Gi","--no-cpu-throttling",
    "--gpu=1","--gpu-type=nvidia-rtx-pro-6000","--no-gpu-zonal-redundancy",
    "--concurrency=1","--min-instances=1","--max-instances=1","--timeout=3600",
    "--add-volume","mount-path=$MountPath,type=cloud-storage,bucket=$Bucket,readonly=false",
    "--set-env-vars","HF_HOME=$MountPath/huggingface,REVEX_MODEL_CACHE_DIR=$ModelCache,REVEX_WARM_MARKER=$WarmMarker,REVEX_WARM_TOKEN=$WarmToken,HF_HUB_ETAG_TIMEOUT=120,HF_HUB_DOWNLOAD_TIMEOUT=900,HF_HUB_DISABLE_TELEMETRY=1,HF_XET_HIGH_PERFORMANCE=1,HF_ENABLE_PARALLEL_LOADING=YES",
    "--quiet")

  $state=Capture-Native $GCloud @("run","services","describe",$Service,"--project",$ProjectId,"--region",$Region,"--format=json")
  if($state.Code-ne 0-or-not $state.Text){throw "Could not verify the r126 Render service after deployment."}
  if($state.Text-notmatch '"minInstanceCount"\s*:\s*1' -and $state.Text-notmatch '"autoscaling\.knative\.dev/minScale"\s*:\s*"1"'){
    throw "r126 Render worker did not retain min-instances=1; refusing broker cutover."
  }
  $url=Capture-Native $GCloud @("run","services","describe",$Service,"--project",$ProjectId,"--region",$Region,"--format=value(status.url)")
  if($url.Code-ne 0-or-not $url.Text){throw "r126 Render worker URL is unavailable."}
  Write-Host "Worker service is up; waiting for server-side model residency proof..." -ForegroundColor Yellow

  $markerUri="gs://$Bucket/revex-render-r126-ready.json"
  $deadline=(Get-Date).AddMinutes(35);$ready=$false
  while((Get-Date)-lt $deadline){
    Start-Sleep -Seconds 10
    $marker=Capture-Native $GCloud @("storage","cat",$markerUri)
    if($marker.Code-ne 0-or-not $marker.Text){continue}
    try{$payload=$marker.Text|ConvertFrom-Json}catch{continue}
    if([string]$payload.warmToken-ne $WarmToken){continue}
    if($payload.ok-eq $true -and $payload.serverWarm-eq $true -and [string]$payload.model-eq "Qwen/Qwen-Image-Edit-2511" -and [string]$payload.revision-eq "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"){$ready=$true;break}
    if($payload.ok-eq $false -and $payload.error){throw "r126 server model warm failed: $($payload.error)"}
  }
  if(-not $ready){throw "r126 Render worker did not prove the pinned model resident on the server within 35 minutes; broker was not changed."}
  Write-Host "PASS: pinned Qwen model is resident on the persistent private GPU service." -ForegroundColor Green

  Write-Host ">> Cut authenticated Render broker over to proven warm r126 worker" -ForegroundColor DarkCyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BaseBrokerDeploy -ProjectId $ProjectId -Region $Region -Repository $Repository -Service $Service -BrokerOnly -NoPause
  if($LASTEXITCODE-ne 0){throw "Render broker cutover failed with exit code $LASTEXITCODE."}

  Write-Host ""
  Write-Host "PASS: REVEX r126 Render is warm, persistent and broker-connected." -ForegroundColor Green
  Write-Host "The browser/workstation never downloads the model; every render request sends only the prepared viewport + prompt." -ForegroundColor Green
  $ExitCode=0
}
catch{
  Write-Host ""
  Write-Host "REVEX r126 Render deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "The prior Render broker/worker remains authoritative because cutover occurs only after warm proof." -ForegroundColor Yellow
  $ExitCode=1
}
finally{
  if(-not $NoPause-and $Host.Name-match 'ConsoleHost'){Write-Host "";Write-Host "Press Enter to close.";[void](Read-Host)}
}
exit $ExitCode
