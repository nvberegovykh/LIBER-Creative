param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-render-worker",
  [string]$ImageTag = "r54",
  [switch]$BrokerOnly,
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

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for the REVEX managed deployment." }
  return $cmd.Source
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
}

function Invoke-NativeCapture([string]$Command, [string[]]$Arguments) {
  $output = @(& $Command @Arguments)
  $code = $LASTEXITCODE
  return @{ Code = $code; Output = $output }
}

function Native-Ok([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Command @Arguments *> $null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Ensure-ServiceAccount([string]$GCloud, [string]$Name, [string]$DisplayName) {
  $email = "$Name@$ProjectId.iam.gserviceaccount.com"
  if (-not (Native-Ok $GCloud @("iam","service-accounts","describe",$email,"--project",$ProjectId))) {
    Invoke-Checked "Create $DisplayName identity" $GCloud @(
      "iam","service-accounts","create",$Name,"--display-name",$DisplayName,"--project",$ProjectId
    )
  }
  return $email
}

function Add-ProjectRole([string]$GCloud, [string]$Member, [string]$Role, [string]$Label) {
  Invoke-Checked $Label $GCloud @(
    "projects","add-iam-policy-binding",$ProjectId,"--member",$Member,"--role",$Role,"--quiet"
  )
}

function Add-ServiceAccountUser([string]$GCloud, [string]$ServiceAccount, [string]$Member, [string]$Label) {
  Invoke-Checked $Label $GCloud @(
    "iam","service-accounts","add-iam-policy-binding",$ServiceAccount,
    "--project",$ProjectId,"--member",$Member,"--role","roles/iam.serviceAccountUser","--quiet"
  )
}

function Resolve-FirebaseStorageBucket([string]$GCloud) {
  $listed = Invoke-NativeCapture $GCloud @(
    "storage","buckets","list","--project",$ProjectId,"--format","value(name)"
  )
  if ($listed.Code -ne 0) { throw "Could not enumerate Google Cloud Storage buckets for $ProjectId." }
  $prefix = [Regex]::Escape($ProjectId)
  $names = @($listed.Output | ForEach-Object {
    ([string]$_).Trim().TrimEnd('/') -replace '^gs://',''
  } | Where-Object { $_ } | Select-Object -Unique)
  $firebaseBuckets = @($names | Where-Object { $_ -match "^$prefix\.(?:appspot\.com|firebasestorage\.app)$" })
  if ($firebaseBuckets.Count -ne 1) {
    $detail = if ($names.Count) { $names -join ', ' } else { '<none>' }
    throw "REVEX requires exactly one Firebase Storage bucket for $ProjectId; discovered: $detail"
  }
  return [string]$firebaseBuckets[0]
}

try {
  Write-Host "REVEX r113 private render deployment" -ForegroundColor Cyan
  Write-Host "Public model: Qwen/Qwen-Image-Edit-2511 @ 6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
  Write-Host "Runtime: private Cloud Run RTX PRO 6000; tokenless public model"
  Write-Host "Project: $ProjectId  Region: $Region"
  if ($BrokerOnly) {
    Write-Host "Resume mode: GPU worker is preserved; only the callable broker is updated." -ForegroundColor Green
  }

  if (-not $BrokerOnly -and -not (Test-Path -LiteralPath $CloudBuild -PathType Leaf)) { throw "Missing $CloudBuild" }
  if (-not (Test-Path -LiteralPath $FunctionsDir -PathType Container)) { throw "Missing $FunctionsDir" }

  $GCloud = Require-Command "gcloud"
  $Npm = Require-Command "npm"
  $Node = Require-Command "node"

  $auth = Invoke-NativeCapture $GCloud @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  $accounts = @($auth.Output | Where-Object { $_ })
  if ($auth.Code -ne 0 -or $accounts.Count -eq 0) {
    throw "Google Cloud administrator sign-in is required. Run 'gcloud auth login' once, then rerun the unified REVEX deployment."
  }
  $Deployer = [string]$accounts[0]

  Invoke-Checked "Select Google Cloud project" $GCloud @("config","set","project",$ProjectId)
  Invoke-Checked "Enable render infrastructure APIs" $GCloud @(
    "services","enable","run.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com","cloudfunctions.googleapis.com","serviceusage.googleapis.com",
    "--project",$ProjectId
  )

  $null = Ensure-ServiceAccount $GCloud "revex-render-worker" "REVEX Render Worker"
  $null = Ensure-ServiceAccount $GCloud "revex-render-broker" "REVEX Render Broker"
  Add-ServiceAccountUser $GCloud $WorkerSa "user:$Deployer" "Allow administrator to deploy render worker"
  Add-ServiceAccountUser $GCloud $BrokerSa "user:$Deployer" "Allow administrator to deploy render broker"
  Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/storage.objectAdmin" "Grant worker render object access"
  Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/datastore.user" "Grant worker render job progress access"
  Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/storage.objectAdmin" "Grant broker source snapshot access"
  Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/datastore.user" "Grant broker render job access"

  if (-not $BrokerOnly) {
    if ($env:REVEX_ARTIFACT_REPOSITORY_VERIFIED -ne "1" -and -not (Native-Ok $GCloud @("artifacts","repositories","describe",$Repository,"--location",$Region,"--project",$ProjectId))) {
      Invoke-Checked "Create REVEX Artifact Registry repository" $GCloud @(
        "artifacts","repositories","create",$Repository,"--repository-format","docker",
        "--location",$Region,"--project",$ProjectId,"--description","REVEX managed runtime images"
      )
    }

    Invoke-Checked "Build tokenless REVEX GPU worker image" $GCloud @(
      "builds","submit",$Root,"--project",$ProjectId,"--config",$CloudBuild,
      "--substitutions","_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-render-worker,_TAG=$ImageTag"
    )

    Invoke-Checked "Deploy private REVEX RTX PRO 6000 worker" $GCloud @(
      "run","deploy",$Service,"--project",$ProjectId,"--region",$Region,"--platform","managed",
      "--image",$Image,"--service-account",$WorkerSa,"--no-allow-unauthenticated",
      "--cpu=20","--memory=80Gi","--no-cpu-throttling","--gpu=1","--gpu-type=nvidia-rtx-pro-6000",
      "--no-gpu-zonal-redundancy","--concurrency=1","--min-instances=0","--max-instances=1","--timeout=3600",
      "--set-env-vars","HF_HUB_DISABLE_TELEMETRY=1,HF_XET_HIGH_PERFORMANCE=1,HF_ENABLE_PARALLEL_LOADING=YES",
      "--quiet"
    )
  }

  $worker = Invoke-NativeCapture $GCloud @(
    "run","services","describe",$Service,"--project",$ProjectId,"--region",$Region,"--format","value(status.url)"
  )
  $WorkerUrl = (@($worker.Output) -join "").Trim()
  if ($worker.Code -ne 0 -or -not $WorkerUrl) {
    throw "The private REVEX GPU worker URL could not be resolved."
  }

  $StorageBucket = Resolve-FirebaseStorageBucket $GCloud
  Write-Host "Firebase Storage authority: $StorageBucket" -ForegroundColor DarkGray

  Invoke-Checked "Allow only REVEX broker to invoke private GPU worker" $GCloud @(
    "run","services","add-iam-policy-binding",$Service,"--project",$ProjectId,"--region",$Region,
    "--member","serviceAccount:$BrokerSa","--role","roles/run.invoker","--quiet"
  )

  Invoke-Checked "Install pinned REVEX render broker dependencies" $Npm @(
    "install","--ignore-scripts","--no-audit","--no-fund"
  ) $FunctionsDir

  $previousWorker = $env:REVEX_RENDER_WORKER_URL
  $previousBroker = $env:REVEX_RENDER_BROKER_SERVICE_ACCOUNT
  $previousStorage = $env:REVEX_STORAGE_BUCKET
  try {
    $env:REVEX_RENDER_WORKER_URL = $WorkerUrl
    $env:REVEX_RENDER_BROKER_SERVICE_ACCOUNT = $BrokerSa
    $env:REVEX_STORAGE_BUCKET = $StorageBucket

    $package = Get-Content -LiteralPath (Join-Path $FunctionsDir "package.json") -Raw | ConvertFrom-Json
    if ([string]$package.engines.node -ne "22") {
      throw "REVEX render broker package.json must pin engines.node to 22."
    }

    $localNodeVersion = (& $Node --version).Trim()
    Write-Host "Local broker preflight uses $localNodeVersion; deployed runtime is pinned separately to nodejs22." -ForegroundColor DarkGray
    Invoke-Checked "Preflight callable broker export" $Node @(
      "-e",
      "const t=Date.now();const m=require('./index.js');if(typeof m.runRevexRender!=='function')throw new Error('runRevexRender export missing');const ms=Date.now()-t;console.log('REVEX broker module OK in '+ms+' ms on '+process.version+'; deployment runtime=nodejs22');"
    ) $FunctionsDir

    Invoke-Checked "Deploy authenticated REVEX render broker" $GCloud @(
      "functions","deploy","runRevexRender","--gen2","--region",$Region,"--project",$ProjectId,
      "--runtime","nodejs22","--source",$FunctionsDir,"--entry-point","runRevexRender","--trigger-http",
      "--allow-unauthenticated","--service-account",$BrokerSa,
      "--set-env-vars","REVEX_RENDER_WORKER_URL=$WorkerUrl,REVEX_RENDER_BROKER_SERVICE_ACCOUNT=$BrokerSa,REVEX_STORAGE_BUCKET=$StorageBucket",
      "--memory","1GiB","--timeout","3600s","--concurrency","4","--max-instances","4","--quiet"
    )
  } finally {
    $env:REVEX_RENDER_WORKER_URL = $previousWorker
    $env:REVEX_RENDER_BROKER_SERVICE_ACCOUNT = $previousBroker
    $env:REVEX_STORAGE_BUCKET = $previousStorage
  }

  $function = Invoke-NativeCapture $GCloud @(
    "functions","describe","runRevexRender","--gen2","--project",$ProjectId,"--region",$Region,"--format","value(state)"
  )
  $FunctionState = (@($function.Output) -join "").Trim()
  if ($function.Code -ne 0 -or $FunctionState -ne "ACTIVE") {
    throw "REVEX render broker did not report ACTIVE after deployment; state=$FunctionState"
  }

  $runtime = Invoke-NativeCapture $GCloud @(
    "functions","describe","runRevexRender","--gen2","--project",$ProjectId,"--region",$Region,"--format","value(buildConfig.runtime)"
  )
  $RuntimeName = (@($runtime.Output) -join "").Trim()
  if ($runtime.Code -ne 0 -or $RuntimeName -ne "nodejs22") {
    throw "REVEX render broker runtime mismatch after deployment; expected nodejs22, got $RuntimeName."
  }

  $bucketState = Invoke-NativeCapture $GCloud @(
    "functions","describe","runRevexRender","--gen2","--project",$ProjectId,"--region",$Region,
    "--format","value(serviceConfig.environmentVariables.REVEX_STORAGE_BUCKET)"
  )
  $LiveStorageBucket = (@($bucketState.Output) -join "").Trim()
  if ($bucketState.Code -ne 0 -or $LiveStorageBucket -ne $StorageBucket) {
    throw "REVEX render broker storage binding mismatch after deployment; expected $StorageBucket, got $LiveStorageBucket."
  }

  Write-Host ""
  Write-Host "PASS: REVEX private renderer is deployed end-to-end." -ForegroundColor Green
  Write-Host "Worker: $WorkerUrl"
  Write-Host "Storage: $StorageBucket"
  Write-Host "Broker: runRevexRender ACTIVE · runtime nodejs22"
  Write-Host "Default renderer needs no Hugging Face account/token and performs no browser-side model inference."
} catch {
  Write-Host ""
  Write-Host "REVEX render deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if (-not $NoPause -and $Host.Name -match "ConsoleHost") { Write-Host "" }
}