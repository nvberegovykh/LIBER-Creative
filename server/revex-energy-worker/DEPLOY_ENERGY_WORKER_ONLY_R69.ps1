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
$script:NativeExitCode = 0
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

# REVEX_NATIVE_EXITCODE_AUTHORITATIVE:
# Native CLIs may write normal progress/confirmation text to stderr. With the
# script-wide ErrorActionPreference=Stop, PowerShell can otherwise promote that
# text to NativeCommandError before LASTEXITCODE is examined. Treat the native
# process exit code as authoritative and restore strict PowerShell semantics
# immediately after every invocation.
function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $previous = $ErrorActionPreference
  $code = 1
  try {
    $ErrorActionPreference = "Continue"
    if ($Quiet) { & $Command @Arguments *> $null } else { & $Command @Arguments }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  } catch {
    $code = 1
  } finally {
    $ErrorActionPreference = $previous
  }
  if ([int]$code -ne 0) { throw "$Label failed with exit code $code." }
}

function Invoke-GCloudCapture([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $Command @Arguments)
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    $script:NativeExitCode = [int]$code
    return $output
  } catch {
    $script:NativeExitCode = 1
    return @()
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Native-Ok([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
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

function Assert-R69Source {
  $resolver = Join-Path $Root "server\revex-energy-worker\revex_energy_pipeline_r69.py"
  $normalizer = Join-Path $Root "server\revex-energy-worker\revex_energy_identity_normalizer.py"
  $contentAgent = Join-Path $Root "server\revex-energy-worker\revex_identity_content_agent.py"
  $identityQa = Join-Path $Root "server\revex-energy-worker\verify_identity_normalizer.py"
  $contentQa = Join-Path $Root "server\revex-energy-worker\verify_identity_content_agent.py"
  $guard = Join-Path $Root "server\revex-energy-worker\revex_energy_pipeline_guard.py"
  $docker = Join-Path $Root "server\revex-energy-worker\Dockerfile"
  foreach ($path in @($resolver,$normalizer,$contentAgent,$identityQa,$contentQa,$guard,$docker,$CloudBuild)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Current Energy source is incomplete: $path" }
  }
  $resolverText = Get-Content -Raw -LiteralPath $resolver
  $normalizerText = Get-Content -Raw -LiteralPath $normalizer
  $contentText = Get-Content -Raw -LiteralPath $contentAgent
  $guardText = Get-Content -Raw -LiteralPath $guard
  $dockerText = Get-Content -Raw -LiteralPath $docker
  foreach ($marker in @('US_CENSUS_GEOCODER_PUBLIC_AR_CURRENT','00_PAGE_FACTS_RESOLVED_R69.json','derived-only-from-immutable-active-Revit-address','import revex_energy_identity_normalizer as identity_normalizer','PROJECT_IDENTITY_NORMALIZED')) {
    if (-not $resolverText.Contains($marker)) { throw "Current identity resolver marker is missing: $marker" }
  }
  foreach ($marker in @('normalize_verified_evidence','locality_near_authoritative_address','PARTY_BOUNDARY','project-specific address mapping')) {
    if (-not $normalizerText.Contains($marker)) { throw "General identity normalizer marker is missing: $marker" }
  }
  foreach ($marker in @('content-aware-consensus-over-immutable-active-Revit-T-Z-evidence','MIN_AGENT_CONFIDENCE','validate_agent_candidate','excludedPartyEvidence','_structured_identity_complete')) {
    if (-not $contentText.Contains($marker)) { throw "Content-aware identity agent marker is missing: $marker" }
  }
  foreach ($forbidden in @('250 MIDWOOD','79 WINTHROP')) {
    if ($resolverText.ToUpperInvariant().Contains($forbidden) -or $normalizerText.ToUpperInvariant().Contains($forbidden) -or $contentText.ToUpperInvariant().Contains($forbidden)) {
      throw "Project-specific identity branch is forbidden in worker runtime: $forbidden"
    }
  }
  if (-not $guardText.Contains('import revex_identity_content_agent as content_identity') `
      -or -not $guardText.Contains('_resolve_content_identity_request(request_path, output_root)') `
      -or -not $guardText.Contains('import revex_energy_pipeline_r69 as resolver') `
      -or -not $guardText.Contains('effective_request = _resolve_r69_request(effective_request, output_root)')) {
    throw "The content-aware identity stage and deterministic fallback are not wired in order behind the preserved Energy failure guard."
  }
  foreach ($marker in @(
    'COPY server/revex-energy-worker/revex_energy_identity_normalizer.py',
    'COPY server/revex-energy-worker/revex_identity_content_agent.py',
    'COPY server/revex-energy-worker/verify_identity_normalizer.py',
    'COPY server/revex-energy-worker/verify_identity_content_agent.py',
    'python3 /opt/revex/server/verify_identity_normalizer.py',
    'python3 /opt/revex/server/verify_identity_content_agent.py',
    'REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_guard.py',
    'REVEX_PIPELINE_IMPL=/opt/revex/energy/revex_energy_pipeline.py'
  )) {
    if (-not $dockerText.Contains($marker)) { throw "Current worker image marker is missing: $marker" }
  }
  if ($dockerText.Contains('revex_energy_pipeline_guard_r87.py')) {
    throw "Exact/project-shaped r87 guard shim is forbidden; generalized identity must remain a reusable primitive."
  }
}

try {
  Write-Host "REVEX current Energy worker-only deployment" -ForegroundColor Cyan
  Write-Host "Source candidate: $SourceCandidate"
  Write-Host "No Firebase CLI and no render/GPU deployment will run."

  Assert-R69Source
  $GCloud = Require-Command "gcloud"
  $Node = Require-Command "node"
  Invoke-Checked "Run current-generation source guard" $Node @((Join-Path $Root ".github\scripts\verify-revex-current-generation-r53.js"))

  $authArgs = @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  $active = @(Invoke-GCloudCapture $GCloud $authArgs) | Where-Object { $_ }
  if ($script:NativeExitCode -ne 0 -or @($active).Count -eq 0) {
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
  if ($script:NativeExitCode -ne 0 -or -not $CloudBuildSa) { throw "Cloud Build default service account was not returned." }
  Invoke-Checked "Grant Cloud Build builder role" $GCloud @("projects","add-iam-policy-binding",$ProjectId,"--member=serviceAccount:$CloudBuildSa","--role=roles/cloudbuild.builds.builder","--quiet") -Quiet
  Invoke-Checked "Grant Cloud Build image-push access" $GCloud @("projects","add-iam-policy-binding",$ProjectId,"--member=serviceAccount:$CloudBuildSa","--role=roles/artifactregistry.writer","--quiet") -Quiet

  Invoke-Checked "Build exact current Energy worker image" $GCloud @(
    "builds","submit",$Root,"--project=$ProjectId","--config=$CloudBuild",
    "--substitutions=_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-energy-worker,_TAG=$ImageTag"
  )
  Invoke-Checked "Deploy private current Energy worker" $GCloud @(
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
  if ($script:NativeExitCode -ne 0) { throw "Energy worker deployed but could not be re-read." }
  $Ready = @($RunState.status.conditions | Where-Object { $_.type -eq 'Ready' } | Select-Object -First 1)
  if ($Ready.Count -eq 0 -or [string]$Ready[0].status -ne 'True') { throw "Current Energy worker did not report Ready after deployment." }
  $WorkerUrl = [string]$RunState.status.url
  if (-not $WorkerUrl) { throw "Current Energy worker reported Ready without a service URL." }

  Write-Host ""
  Write-Host "PASS: current Energy worker-only deployment completed from $SourceCandidate." -ForegroundColor Green
  Write-Host "Worker: $WorkerUrl"
  Write-Host "Existing runRevexEnergy broker and renderer were left untouched."
} catch {
  Write-Host ""
  Write-Host "REVEX current Energy worker-only deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') { Write-Host "" }
}
