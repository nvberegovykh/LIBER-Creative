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
$CloudBuild = Join-Path $Root "server\revex-energy-worker\cloudbuild.yaml"
$ImageTag = "current-$($SourceCandidate.Substring(0,12).ToLowerInvariant())"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-energy-worker:$ImageTag"
$WorkerSa = "revex-energy-worker@$ProjectId.iam.gserviceaccount.com"
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX Energy worker deployment." }
  return $cmd.Source
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  if ($Quiet) { & $Command @Arguments *> $null } else { & $Command @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Invoke-GCloudCapture([string]$Command, [string[]]$Arguments) {
  return @(& $Command @Arguments)
}

function Native-Ok([string]$Command, [string[]]$Arguments) {
  try { & $Command @Arguments *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

try {
  Write-Host "REVEX r69 Energy worker-only deployment" -ForegroundColor Cyan
  Write-Host "Source candidate: $SourceCandidate"
  Write-Host "No Firebase CLI and no render/GPU deployment will run."

  $GCloud = Require-Command "gcloud"
  $Node = Require-Command "node"
  Invoke-Checked "Run current-generation source guard" $Node @((Join-Path $Root ".github\scripts\verify-revex-current-generation-r53.js"))
  if (Test-Path -LiteralPath (Join-Path $Root ".github\scripts\verify-revex-r69-energy-finish.py")) {
    $Python = Require-Command "python"
    Invoke-Checked "Run r69 Energy/finish deterministic guard" $Python @((Join-Path $Root ".github\scripts\verify-revex-r69-energy-finish.py"))
  }

  $authArgs = @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  $active = @(Invoke-GCloudCapture $GCloud $authArgs) | Where-Object { $_ }
  if ($LASTEXITCODE -ne 0 -or @($active).Count -eq 0) {
    throw "Google Cloud administrator authentication is required once. Run 'gcloud auth login', then rerun."
  }
  $Deployer = [string](@($active)[0])

  Invoke-Checked "Verify Google Cloud project" $GCloud @("projects","describe",$ProjectId,"--format=value(projectId)") -Quiet
  Invoke-Checked "Select Google Cloud project" $GCloud @("config","set","project",$ProjectId) -Quiet
  Invoke-Checked "Enable Energy worker APIs" $GCloud @(
    "services","enable","run.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com","aiplatform.googleapis.com","serviceusage.googleapis.com","--project=$ProjectId"
  ) -Quiet

  if (-not (Native-Ok $GCloud @("iam","service-accounts","describe",$WorkerSa,"--project=$ProjectId"))) {
    Invoke-Checked "Create REVEX Energy worker identity" $GCloud @("iam","service-accounts","create","revex-energy-worker","--display-name=REVEX Energy Worker","--project=$ProjectId") -Quiet
  }
  Invoke-Checked "Allow administrator to deploy Energy worker" $GCloud @(
    "iam","service-accounts","add-iam-policy-binding",$WorkerSa,"--project=$ProjectId",
    "--member=user:$Deployer","--role=roles/iam.serviceAccountUser","--quiet"
  ) -Quiet
  Invoke-Checked "Grant Energy worker immutable artifact access" $GCloud @(
    "projects","add-iam-policy-binding",$ProjectId,"--member=serviceAccount:$WorkerSa","--role=roles/storage.objectAdmin","--quiet"
  ) -Quiet
  Invoke-Checked "Grant Energy worker page-scan access" $GCloud @(
    "projects","add-iam-policy-binding",$ProjectId,"--member=serviceAccount:$WorkerSa","--role=roles/aiplatform.user","--quiet"
  ) -Quiet

  if (-not (Native-Ok $GCloud @("artifacts","repositories","describe",$Repository,"--location=$Region","--project=$ProjectId"))) {
    throw "REVEX Artifact Registry repository '$Repository' is missing; worker-only deployment will not create unrelated infrastructure silently."
  }
  $buildSaArgs = @("builds","get-default-service-account","--project=$ProjectId","--format=value(serviceAccountEmail)")
  $CloudBuildSa = ((Invoke-GCloudCapture $GCloud $buildSaArgs) -join "").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $CloudBuildSa) { throw "Cloud Build default service account was not returned." }
  Invoke-Checked "Grant Cloud Build builder role" $GCloud @("projects","add-iam-policy-binding",$ProjectId,"--member=serviceAccount:$CloudBuildSa","--role=roles/cloudbuild.builds.builder","--quiet") -Quiet
  Invoke-Checked "Grant Cloud Build image-push access" $GCloud @("projects","add-iam-policy-binding",$ProjectId,"--member=serviceAccount:$CloudBuildSa","--role=roles/artifactregistry.writer","--quiet") -Quiet

  Invoke-Checked "Build exact r69 Energy worker image" $GCloud @(
    "builds","submit",$Root,"--project=$ProjectId","--config=$CloudBuild",
    "--substitutions=_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-energy-worker,_TAG=$ImageTag"
  )
  Invoke-Checked "Deploy private r69 Energy worker" $GCloud @(
    "run","deploy",$Service,"--project=$ProjectId","--region=$Region","--image=$Image",
    "--service-account=$WorkerSa","--no-allow-unauthenticated","--cpu=4","--memory=8Gi",
    "--concurrency=1","--min-instances=0","--max-instances=3","--timeout=3600",
    "--set-env-vars=REVEX_ENERGY_TIMEOUT_SECONDS=3500,REVEX_SOURCE_CANDIDATE=$SourceCandidate","--quiet"
  )
  Invoke-Checked "Preserve Energy broker invocation access" $GCloud @(
    "run","services","add-iam-policy-binding",$Service,"--project=$ProjectId","--region=$Region",
    "--member=serviceAccount:$BrokerSa","--role=roles/run.invoker","--quiet"
  ) -Quiet

  $serviceArgs = @("run","services","describe",$Service,"--project=$ProjectId","--region=$Region","--format=json")
  $RunState = ((Invoke-GCloudCapture $GCloud $serviceArgs) -join "`n") | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Energy worker deployed but could not be re-read." }
  $Ready = @($RunState.status.conditions | Where-Object { $_.type -eq 'Ready' } | Select-Object -First 1)
  if ($Ready.Count -eq 0 -or [string]$Ready[0].status -ne 'True') { throw "r69 Energy worker did not report Ready after deployment." }
  $WorkerUrl = [string]$RunState.status.url
  if (-not $WorkerUrl) { throw "r69 Energy worker reported Ready without a service URL." }

  Write-Host ""
  Write-Host "PASS: r69 Energy worker-only deployment completed from $SourceCandidate." -ForegroundColor Green
  Write-Host "Worker: $WorkerUrl"
  Write-Host "Existing runRevexEnergy broker and renderer were left untouched."
} catch {
  Write-Host ""
  Write-Host "REVEX r69 Energy worker-only deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') { Write-Host "" }
}
