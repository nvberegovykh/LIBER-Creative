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
$FunctionsDir = Join-Path $Root "server\firebase-functions"
$CloudBuild = Join-Path $Root "server\revex-energy-worker\cloudbuild.yaml"
$ImageTag = "current-$($SourceCandidate.Substring(0,12).ToLowerInvariant())"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-energy-worker:$ImageTag"
$WorkerSa = "revex-energy-worker@$ProjectId.iam.gserviceaccount.com"
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
$VertexProject = $ProjectId
$VertexLocation = "global"
$EnvPath = Join-Path $FunctionsDir ".env.$ProjectId"
$EnvBackup = $null

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for the one-time managed deployment." }
  return $cmd.Source
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $previous = $ErrorActionPreference
  $code = 1
  try {
    # Native CLIs (especially Firebase) legitimately write progress to stderr.
    # PowerShell must judge them by LASTEXITCODE, not by stderr text.
    $ErrorActionPreference = "Continue"
    if ($Quiet) { & $Command @Arguments *> $null } else { & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) } }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  } catch {
    $code = 1
  } finally {
    $ErrorActionPreference = $previous
  }
  if ([int]$code -ne 0) { throw "$Label failed with exit code $code." }
}

function Native-Ok([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    # REVEX_NATIVE_EXITCODE_AUTHORITATIVE: benign native stderr is not failure.
    $ErrorActionPreference = "Continue"
    & $Command @Arguments *> $null
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return ([int]$code -eq 0)
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Ensure-ServiceAccount([string]$GCloud, [string]$Name, [string]$DisplayName) {
  $email = "$Name@$ProjectId.iam.gserviceaccount.com"
  if (-not (Native-Ok $GCloud @("iam","service-accounts","describe",$email,"--project=$ProjectId"))) {
    Invoke-Checked "Create $DisplayName identity" $GCloud @(
      "iam","service-accounts","create",$Name,"--display-name=$DisplayName","--project=$ProjectId"
    ) -Quiet
  }
  return $email
}

function Add-ProjectRole([string]$GCloud, [string]$Member, [string]$Role, [string]$Label) {
  Invoke-Checked $Label $GCloud @(
    "projects","add-iam-policy-binding",$ProjectId,"--member=$Member","--role=$Role","--quiet"
  ) -Quiet
}

function Add-ServiceAccountUser([string]$GCloud, [string]$ServiceAccount, [string]$Member, [string]$Label) {
  Invoke-Checked $Label $GCloud @(
    "iam","service-accounts","add-iam-policy-binding",$ServiceAccount,
    "--project=$ProjectId","--member=$Member","--role=roles/iam.serviceAccountUser","--quiet"
  ) -Quiet
}

function Assert-CurrentSource {
  $gbxml = Join-Path $Root "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py"
  $energyQa = Join-Path $Root "src\Liber.Revex.Revit\Engineering\Energy\verify_revex_r49_energy.py"
  $worker = Join-Path $Root "server\revex-energy-worker\app.py"
  $broker = Join-Path $Root "server\firebase-functions\index.js"
  $cloudProject = Join-Path $Root "server\revex-energy-worker\revex_cloud_project.py"
  $vertexQa = Join-Path $Root "server\revex-energy-worker\verify_vertex_project_binding_r98.py"
  $guard = Join-Path $Root ".github\scripts\verify-revex-current-generation-r53.js"
  foreach ($path in @($gbxml,$energyQa,$worker,$broker,$cloudProject,$vertexQa,$guard,$CloudBuild)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Current REVEX source is incomplete: $path" }
  }
  $gbxmlText = Get-Content -Raw -LiteralPath $gbxml
  $qaText = Get-Content -Raw -LiteralPath $energyQa
  $workerText = Get-Content -Raw -LiteralPath $worker
  $brokerText = Get-Content -Raw -LiteralPath $broker
  $cloudProjectText = Get-Content -Raw -LiteralPath $cloudProject
  foreach ($marker in @('reconcile_publication_message_severity','REVIT_TO_GBXML_GEOMETRY_INTEGRITY_REVIEW')) {
    if (-not $gbxmlText.Contains($marker) -and -not $qaText.Contains($marker)) {
      throw "Current accepted-gbXML Energy contract is missing marker: $marker"
    }
  }
  if (-not $qaText.Contains('sub-80 geometry integrity failure was incorrectly downgraded')) {
    throw "Current Energy source is missing the sub-80 hard-stop regression guard."
  }
  if (-not $workerText.Contains('MIN_INTEGRITY = 0.80') -or -not $workerText.Contains('QUALITY_TARGET = 0.95')) {
    throw "Current Energy worker is missing the >=80% hard-stop / >=95% review-target contract."
  }
  if (-not $brokerText.Contains('SOURCE_CANDIDATE') -or -not $brokerText.Contains('REVEX_ENERGY_WORKER_URL')) {
    throw "Current Energy broker is missing immutable source-candidate/worker binding."
  }
  foreach ($marker in @('REVEX_VERTEX_PROJECT','GOOGLE_CLOUD_PROJECT','google.auth.default','not a valid substitute')) {
    if (-not $cloudProjectText.Contains($marker)) { throw "Current Vertex project resolver is missing marker: $marker" }
  }
}

try {
  Write-Host "REVEX current managed Energy deployment" -ForegroundColor Cyan
  Write-Host "Source candidate: $SourceCandidate"
  Write-Host "Project: $ProjectId  Region: $Region"
  Write-Host "Vertex AI project: $VertexProject  location: $VertexLocation"
  Write-Host "This path builds the current source directly; it never restores the legacy r49 Drive archive."

  Assert-CurrentSource
  $GCloud = Require-Command "gcloud"
  $Firebase = Require-Command "firebase"
  $Npm = Require-Command "npm"
  $Node = Require-Command "node"

  Invoke-Checked "Run current-generation source guard before cloud changes" $Node @(
    (Join-Path $Root ".github\scripts\verify-revex-current-generation-r53.js")
  )

  $active = @(& $GCloud @("auth","list","--filter=status:ACTIVE","--format=value(account)")) | Where-Object { $_ }
  if ($LASTEXITCODE -ne 0 -or @($active).Count -eq 0) {
    throw "Google Cloud administrator authentication is required once. Run 'gcloud auth login', then rerun the unified REVEX deployment. No cloud change was started."
  }
  $Deployer = [string](@($active)[0])

  # The root launcher performs the interactive Firebase authentication once and
  # exports REVEX_FIREBASE_AUTH_VERIFIED=1 for this exact child process. Do not
  # reinterpret the same successful CLI session through another fragile probe.
  if ($env:REVEX_FIREBASE_AUTH_VERIFIED -ne "1" -and -not (Native-Ok $Firebase @("projects:list","--json"))) {
    throw "Firebase administrator authentication is required once. Run 'firebase login', then rerun the unified REVEX deployment. No Energy deployment was started."
  }
  Write-Host "Firebase administrator session accepted for managed Energy deployment." -ForegroundColor Green

  Invoke-Checked "Verify Google Cloud project" $GCloud @("projects","describe",$ProjectId,"--format=value(projectId)") -Quiet
  Invoke-Checked "Select Google Cloud project" $GCloud @("config","set","project",$ProjectId) -Quiet
  Invoke-Checked "Enable managed Energy APIs" $GCloud @(
    "services","enable","run.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com","cloudfunctions.googleapis.com","firebase.googleapis.com",
    "aiplatform.googleapis.com","serviceusage.googleapis.com","--project=$ProjectId"
  ) -Quiet

  $null = Ensure-ServiceAccount $GCloud "revex-energy-worker" "REVEX Energy Worker"
  $null = Ensure-ServiceAccount $GCloud "revex-energy-broker" "REVEX Energy Broker"
  Add-ServiceAccountUser $GCloud $WorkerSa "user:$Deployer" "Allow administrator to deploy Energy worker"
  Add-ServiceAccountUser $GCloud $BrokerSa "user:$Deployer" "Allow administrator to deploy Energy broker"
  Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/storage.objectAdmin" "Grant Energy worker immutable artifact access"
  Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/aiplatform.user" "Grant Energy worker T/Z/EN page-scan access"
  Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/datastore.user" "Grant Energy broker Firestore access"

  if (-not (Native-Ok $GCloud @("artifacts","repositories","describe",$Repository,"--location=$Region","--project=$ProjectId"))) {
    Invoke-Checked "Create REVEX Artifact Registry repository" $GCloud @(
      "artifacts","repositories","create",$Repository,"--repository-format=docker",
      "--location=$Region","--project=$ProjectId","--description=REVEX managed runtimes"
    ) -Quiet
  }

  $CloudBuildSa = (& $GCloud @("builds","get-default-service-account","--project=$ProjectId","--format=value(serviceAccountEmail)")).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $CloudBuildSa) { throw "Cloud Build default service account was not returned." }
  Add-ProjectRole $GCloud "serviceAccount:$CloudBuildSa" "roles/cloudbuild.builds.builder" "Grant Cloud Build builder role"
  Add-ProjectRole $GCloud "serviceAccount:$CloudBuildSa" "roles/artifactregistry.writer" "Grant Cloud Build image-push access"

  Invoke-Checked "Build exact current Energy worker image" $GCloud @(
    "builds","submit",$Root,"--project=$ProjectId","--config=$CloudBuild",
    "--substitutions=_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-energy-worker,_TAG=$ImageTag"
  )

  Invoke-Checked "Deploy private current Energy worker" $GCloud @(
    "run","deploy",$Service,"--project=$ProjectId","--region=$Region",
    "--image=$Image","--service-account=$WorkerSa","--no-allow-unauthenticated",
    "--cpu=4","--memory=8Gi","--concurrency=1","--min-instances=0","--max-instances=3",
    "--timeout=3600",
    "--set-env-vars=REVEX_ENERGY_TIMEOUT_SECONDS=3500,REVEX_SOURCE_CANDIDATE=$SourceCandidate,REVEX_VERTEX_PROJECT=$VertexProject,REVEX_VERTEX_LOCATION=$VertexLocation",
    "--quiet"
  )

  $WorkerUrl = (& $GCloud @("run","services","describe",$Service,"--project=$ProjectId","--region=$Region","--format=value(status.url)")).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $WorkerUrl) { throw "Current Energy worker deployed but no ready service URL was returned." }
  Invoke-Checked "Allow only REVEX Energy broker to invoke worker" $GCloud @(
    "run","services","add-iam-policy-binding",$Service,"--project=$ProjectId","--region=$Region",
    "--member=serviceAccount:$BrokerSa","--role=roles/run.invoker","--quiet"
  ) -Quiet

  Push-Location $FunctionsDir
  try {
    Invoke-Checked "Install current Energy broker dependencies" $Npm @("install","--omit=dev","--no-audit","--no-fund")
    if (Test-Path -LiteralPath $EnvPath) {
      $EnvBackup = "$EnvPath.revex-current-backup"
      Copy-Item -LiteralPath $EnvPath -Destination $EnvBackup -Force
    }
    @(
      "REVEX_ENERGY_WORKER_URL=$WorkerUrl",
      "REVEX_ENERGY_BROKER_SERVICE_ACCOUNT=$BrokerSa",
      "REVEX_SOURCE_CANDIDATE=$SourceCandidate"
    ) | Set-Content -LiteralPath $EnvPath -Encoding Ascii
    $env:FUNCTIONS_DISCOVERY_TIMEOUT = "60"
    Invoke-Checked "Deploy current authenticated runRevexEnergy broker" $Firebase @(
      "deploy","--only","functions:revex-energy","--project",$ProjectId,"--force","--non-interactive"
    )
  } finally {
    if (Test-Path -LiteralPath $EnvPath) { Remove-Item -LiteralPath $EnvPath -Force }
    if ($EnvBackup -and (Test-Path -LiteralPath $EnvBackup)) { Move-Item -LiteralPath $EnvBackup -Destination $EnvPath -Force }
    Pop-Location
  }

  $FunctionState = (& $GCloud @("functions","describe","runRevexEnergy","--gen2","--project=$ProjectId","--region=$Region","--format=json")) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or [string]$FunctionState.state -ne "ACTIVE") {
    throw "Current Energy broker did not report ACTIVE after deployment."
  }
  $RunState = (& $GCloud @("run","services","describe",$Service,"--project=$ProjectId","--region=$Region","--format=json")) | ConvertFrom-Json
  $Ready = @($RunState.status.conditions | Where-Object { $_.type -eq 'Ready' } | Select-Object -First 1)
  if ($Ready.Count -eq 0 -or [string]$Ready[0].status -ne 'True') {
    throw "Current Energy worker did not report Ready after deployment."
  }
  $LiveEnv = @{}
  foreach ($row in @($RunState.spec.template.spec.containers[0].env)) { $LiveEnv[[string]$row.name] = [string]$row.value }
  if ([string]$LiveEnv['REVEX_SOURCE_CANDIDATE'] -ne $SourceCandidate) { throw "Live worker source candidate is not the exact deployed source." }
  if ([string]$LiveEnv['REVEX_VERTEX_PROJECT'] -ne $VertexProject) { throw "Live worker Vertex AI project is not bound to the deployment Google Cloud project." }
  if ([string]$LiveEnv['REVEX_VERTEX_LOCATION'] -ne $VertexLocation) { throw "Live worker Vertex AI location is not the expected deployment location." }

  Write-Host "" 
  Write-Host "PASS: current REVEX Energy worker + broker deployed from $SourceCandidate." -ForegroundColor Green
  Write-Host "Worker: $WorkerUrl"
  Write-Host "Vertex AI project: $($LiveEnv['REVEX_VERTEX_PROJECT'])  location: $($LiveEnv['REVEX_VERTEX_LOCATION'])"
  Write-Host "No local production simulation server was created."
} catch {
  Write-Host "" 
  Write-Host "REVEX current Energy deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') { Write-Host "" }
}
