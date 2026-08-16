param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-render-worker",
  [string]$ImageTag = "r54",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$FunctionsDir = Join-Path $Root "server\revex-render-functions"
$CloudBuild = Join-Path $Root "server\revex-render-worker\cloudbuild.yaml"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-render-worker:$ImageTag"
$WorkerSa = "revex-render-worker@$ProjectId.iam.gserviceaccount.com"
$BrokerSa = "revex-render-broker@$ProjectId.iam.gserviceaccount.com"
$EnvPath = Join-Path $FunctionsDir ".env.$ProjectId"
$EnvBackup = $null

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for the one-time infrastructure deployment." }
  return $cmd.Source
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Native-Ok([string]$Command, [string[]]$Arguments) {
  try {
    & $Command @Arguments *> $null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

function Ensure-ServiceAccount([string]$GCloud, [string]$Name, [string]$DisplayName) {
  $email = "$Name@$ProjectId.iam.gserviceaccount.com"
  if (-not (Native-Ok $GCloud @("iam","service-accounts","describe",$email,"--project=$ProjectId"))) {
    Invoke-Checked "Create $DisplayName identity" $GCloud @(
      "iam","service-accounts","create",$Name,"--display-name=$DisplayName","--project=$ProjectId"
    )
  }
  return $email
}

function Add-ProjectRole([string]$GCloud, [string]$Member, [string]$Role, [string]$Label) {
  Invoke-Checked $Label $GCloud @(
    "projects","add-iam-policy-binding",$ProjectId,"--member=$Member","--role=$Role","--quiet"
  )
}

function Add-ServiceAccountUser([string]$GCloud, [string]$ServiceAccount, [string]$Member, [string]$Label) {
  Invoke-Checked $Label $GCloud @(
    "iam","service-accounts","add-iam-policy-binding",$ServiceAccount,
    "--project=$ProjectId","--member=$Member","--role=roles/iam.serviceAccountUser","--quiet"
  )
}

try {
  Write-Host "REVEX r54 private render deployment" -ForegroundColor Cyan
  Write-Host "Public model: Qwen/Qwen-Image-Edit-2511 @ 6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
  Write-Host "Runtime: private Cloud Run RTX PRO 6000; no Hugging Face login/token"
  Write-Host "Project: $ProjectId  Region: $Region"

  if (-not (Test-Path -LiteralPath $CloudBuild -PathType Leaf)) { throw "Missing $CloudBuild" }
  if (-not (Test-Path -LiteralPath $FunctionsDir -PathType Container)) { throw "Missing $FunctionsDir" }

  $GCloud = Require-Command "gcloud"
  $Firebase = Require-Command "firebase"
  $Npm = Require-Command "npm"

  $accounts = @(& $GCloud @("auth","list","--filter=status:ACTIVE","--format=value(account)")) | Where-Object { $_ }
  if ($LASTEXITCODE -ne 0 -or $accounts.Count -eq 0) {
    throw "Google Cloud administrator sign-in is required. Run 'gcloud auth login' once, then rerun this script. No render deployment was started."
  }
  $Deployer = [string]$accounts[0]
  if (-not (Native-Ok $Firebase @("projects:list","--json"))) {
    throw "Firebase administrator sign-in is required. Run 'firebase login' once, then rerun this script. No render deployment was started."
  }

  Invoke-Checked "Select Google Cloud project" $GCloud @("config","set","project",$ProjectId)
  Invoke-Checked "Enable render infrastructure APIs" $GCloud @(
    "services","enable","run.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com","cloudfunctions.googleapis.com","firebase.googleapis.com",
    "serviceusage.googleapis.com","--project=$ProjectId"
  )

  $null = Ensure-ServiceAccount $GCloud "revex-render-worker" "REVEX Render Worker"
  $null = Ensure-ServiceAccount $GCloud "revex-render-broker" "REVEX Render Broker"
  Add-ServiceAccountUser $GCloud $WorkerSa "user:$Deployer" "Allow administrator to deploy render worker"
  Add-ServiceAccountUser $GCloud $BrokerSa "user:$Deployer" "Allow administrator to deploy render broker"
  Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/storage.objectAdmin" "Grant worker render object access"
  Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/datastore.user" "Grant worker render job progress access"
  Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/storage.objectAdmin" "Grant broker source snapshot access"
  Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/datastore.user" "Grant broker render job access"

  if (-not (Native-Ok $GCloud @("artifacts","repositories","describe",$Repository,"--location=$Region","--project=$ProjectId"))) {
    Invoke-Checked "Create REVEX Artifact Registry repository" $GCloud @(
      "artifacts","repositories","create",$Repository,"--repository-format=docker",
      "--location=$Region","--project=$ProjectId","--description=REVEX managed runtime images"
    )
  }

  Invoke-Checked "Build tokenless REVEX GPU worker image" $GCloud @(
    "builds","submit",$Root,"--project=$ProjectId","--config=$CloudBuild",
    "--substitutions=_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-render-worker,_TAG=$ImageTag"
  )

  # RTX PRO 6000 Cloud Run currently requires >=20 CPU and >=80 GiB instance
  # memory. No zonal redundancy uses the lower-cost on-demand GPU tier and the
  # service still scales to zero between render sessions.
  Invoke-Checked "Deploy private REVEX RTX PRO 6000 worker" $GCloud @(
    "run","deploy",$Service,"--project=$ProjectId","--region=$Region","--platform=managed",
    "--image=$Image","--service-account=$WorkerSa","--no-allow-unauthenticated",
    "--cpu=20","--memory=80Gi","--no-cpu-throttling","--gpu=1","--gpu-type=nvidia-rtx-pro-6000",
    "--no-gpu-zonal-redundancy","--concurrency=1","--min-instances=0","--max-instances=1","--timeout=3600",
    "--set-env-vars=HF_HUB_DISABLE_TELEMETRY=1,HF_XET_HIGH_PERFORMANCE=1,HF_ENABLE_PARALLEL_LOADING=YES"
  )

  $WorkerUrl = (& $GCloud @("run","services","describe",$Service,"--project=$ProjectId","--region=$Region","--format=value(status.url)")).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $WorkerUrl) { throw "Cloud Run deployed but its service URL could not be resolved." }
  Invoke-Checked "Allow only REVEX broker to invoke private GPU worker" $GCloud @(
    "run","services","add-iam-policy-binding",$Service,"--project=$ProjectId","--region=$Region",
    "--member=serviceAccount:$BrokerSa","--role=roles/run.invoker","--quiet"
  )

  Push-Location $FunctionsDir
  try {
    Invoke-Checked "Install pinned REVEX render broker dependencies" $Npm @("install","--ignore-scripts","--no-audit","--no-fund")
    if (Test-Path -LiteralPath $EnvPath) {
      $EnvBackup = "$EnvPath.revex-r54-backup"
      Copy-Item -LiteralPath $EnvPath -Destination $EnvBackup -Force
    }
    @(
      "REVEX_RENDER_WORKER_URL=$WorkerUrl",
      "REVEX_RENDER_BROKER_SERVICE_ACCOUNT=$BrokerSa"
    ) | Set-Content -LiteralPath $EnvPath -Encoding UTF8
    Invoke-Checked "Deploy authenticated REVEX render broker" $Firebase @(
      "deploy","--project",$ProjectId,"--config",(Join-Path $FunctionsDir "firebase.json"),
      "--only","functions:revex-render","--non-interactive"
    )
  } finally {
    if (Test-Path -LiteralPath $EnvPath) { Remove-Item -LiteralPath $EnvPath -Force }
    if ($EnvBackup -and (Test-Path -LiteralPath $EnvBackup)) {
      Move-Item -LiteralPath $EnvBackup -Destination $EnvPath -Force
    }
    Pop-Location
  }

  Write-Host "" 
  Write-Host "PASS: REVEX private renderer deployed." -ForegroundColor Green
  Write-Host "Worker: $WorkerUrl"
  Write-Host "End users need no Hugging Face account, token, model download, or Google AI popup for the default renderer."
} catch {
  Write-Host "" 
  Write-Host "REVEX render deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if (-not $NoPause -and $Host.Name -match "ConsoleHost") {
    Write-Host ""
  }
}
