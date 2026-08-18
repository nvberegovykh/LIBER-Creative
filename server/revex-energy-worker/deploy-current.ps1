param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-energy-current",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$CandidateOnly,
  [switch]$BrokerOnly,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
if ($CandidateOnly -and $BrokerOnly) { throw "Choose CandidateOnly or BrokerOnly, not both." }

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$FunctionsDir = Join-Path $Root "server\firebase-functions"
$CloudBuild = Join-Path $PSScriptRoot "cloudbuild.yaml"
$Verifier = Join-Path $Root ".github\scripts\verify-revex-current-release.py"
$WorkerSa = "revex-energy-worker@$ProjectId.iam.gserviceaccount.com"
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
$Short = $SourceCandidate.Substring(0,12).ToLowerInvariant()
$ImageTag = "current-$Short"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-energy-worker:$ImageTag"
$EnvPath = Join-Path $FunctionsDir ".env.$ProjectId"
$EnvBackup = $null
$ExitCode = 1

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX Energy deployment." }
  return $cmd.Source
}
function Invoke-Native([string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($Quiet) { & $Command @Arguments *> $null }
    else { & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) } }
    $code = $LASTEXITCODE; if ($null -eq $code) { $code = 0 }; return [int]$code
  } catch { return 1 }
  finally { $ErrorActionPreference = $previous }
}
function Capture-Native([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $lines = @(& $Command @Arguments 2>$null | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE; if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ Code=[int]$code; Text=($lines -join "`n").Trim() }
  } finally { $ErrorActionPreference = $previous }
}
function Require-Ok([string]$Label, [string]$Command, [string[]]$Arguments, [switch]$Quiet) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $code = Invoke-Native $Command $Arguments -Quiet:$Quiet
  if ($code -ne 0) { throw "$Label failed with exit code $code." }
}
function Native-Ok([string]$Command,[string[]]$Arguments){ return (Invoke-Native $Command $Arguments -Quiet) -eq 0 }
function Ensure-ServiceAccount([string]$GCloud,[string]$Name,[string]$DisplayName) {
  $email = "$Name@$ProjectId.iam.gserviceaccount.com"
  if (-not (Native-Ok $GCloud @("iam","service-accounts","describe",$email,"--project",$ProjectId))) {
    Require-Ok "Create $DisplayName identity" $GCloud @("iam","service-accounts","create",$Name,"--display-name",$DisplayName,"--project",$ProjectId) -Quiet
  }
  return $email
}
function Add-ProjectRole([string]$GCloud,[string]$Member,[string]$Role,[string]$Label) {
  Require-Ok $Label $GCloud @("projects","add-iam-policy-binding",$ProjectId,"--member",$Member,"--role",$Role,"--quiet") -Quiet
}
function Add-ServiceAccountUser([string]$GCloud,[string]$ServiceAccount,[string]$Member,[string]$Label) {
  Require-Ok $Label $GCloud @("iam","service-accounts","add-iam-policy-binding",$ServiceAccount,"--project",$ProjectId,"--member",$Member,"--role","roles/iam.serviceAccountUser","--quiet") -Quiet
}
function Resolve-VerifiedCandidate([string]$GCloud) {
  $state = Capture-Native $GCloud @("run","services","describe",$Service,"--project",$ProjectId,"--region",$Region,"--format","json")
  if ($state.Code -ne 0 -or -not $state.Text) { throw "Energy candidate service is unavailable: $Service" }
  $run = $state.Text | ConvertFrom-Json
  $ready = @($run.status.conditions | Where-Object { $_.type -eq "Ready" } | Select-Object -First 1)
  if ($ready.Count -eq 0 -or [string]$ready[0].status -ne "True") { throw "Energy candidate is not Ready; broker remains unchanged." }
  $url = [string]$run.status.url
  if (-not $url) { throw "Energy candidate has no ready service URL; broker remains unchanged." }
  $liveEnv = @{}
  foreach ($row in @($run.spec.template.spec.containers[0].env)) { $liveEnv[[string]$row.name] = [string]$row.value }
  if ([string]$liveEnv["REVEX_SOURCE_CANDIDATE"] -ne $SourceCandidate) { throw "Energy candidate source SHA does not match the exact release source." }
  if ([string]$liveEnv["REVEX_VERTEX_PROJECT"] -ne $ProjectId -or [string]$liveEnv["REVEX_VERTEX_LOCATION"] -ne "global") { throw "Energy candidate Vertex binding is not canonical." }
  return $url
}

try {
  $mode = if ($CandidateOnly) { "candidate-only" } elseif ($BrokerOnly) { "broker-only" } else { "candidate+broker" }
  Write-Host "REVEX current Energy deployment - $mode" -ForegroundColor Cyan
  Write-Host "Source: $SourceCandidate"
  Write-Host "Candidate service: $Service"
  Write-Host "Policy: canonical typed evidence + proven simulation/filing engine + missing VT 0.45" -ForegroundColor Green

  foreach ($required in @(
    $CloudBuild,$FunctionsDir,
    (Join-Path $Root "REVEX_CURRENT_RELEASE.json"),$Verifier,
    (Join-Path $Root "server\revex-energy-worker\revex_energy_pipeline_current.py"),
    (Join-Path $Root "src\Liber.Revex.Revit\Engineering\Energy\revex_energy_contracts.py"),
    (Join-Path $Root "src\Liber.Revex.Revit\Engineering\Energy\revex_final_touchups.py")
  )) { if (-not (Test-Path -LiteralPath $required)) { throw "Energy deployment source is incomplete: $required" } }

  $GCloud = Require-Command "gcloud"
  $Python = Require-Command "python"
  Require-Ok "Validate full current REVEX revision before Energy cloud changes" $Python @($Verifier)
  $auth = Capture-Native $GCloud @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  if ($auth.Code -ne 0 -or -not $auth.Text) { throw "Google Cloud administrator sign-in is required before Energy deployment." }
  $Deployer = ($auth.Text -split "`n")[0].Trim()

  if (-not $BrokerOnly) {
    Require-Ok "Select Google Cloud project" $GCloud @("config","set","project",$ProjectId) -Quiet
    Require-Ok "Enable Energy infrastructure APIs" $GCloud @(
      "services","enable","run.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com",
      "iamcredentials.googleapis.com","cloudfunctions.googleapis.com","firebase.googleapis.com",
      "aiplatform.googleapis.com","firestore.googleapis.com","serviceusage.googleapis.com","--project",$ProjectId
    ) -Quiet
    $null = Ensure-ServiceAccount $GCloud "revex-energy-worker" "REVEX Energy Worker"
    $null = Ensure-ServiceAccount $GCloud "revex-energy-broker" "REVEX Energy Broker"
    Add-ServiceAccountUser $GCloud $WorkerSa "user:$Deployer" "Allow deployer to use Energy worker identity"
    Add-ServiceAccountUser $GCloud $BrokerSa "user:$Deployer" "Allow deployer to use Energy broker identity"
    Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/storage.objectAdmin" "Grant Energy worker immutable Storage access"
    Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/datastore.user" "Grant Energy worker durable Firestore access"
    Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/aiplatform.user" "Grant Energy worker Vertex page-analysis access"
    Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/datastore.user" "Grant Energy broker Firestore access"
    Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/storage.objectAdmin" "Grant Energy broker Storage access"
    if (-not (Native-Ok $GCloud @("artifacts","repositories","describe",$Repository,"--location",$Region,"--project",$ProjectId))) {
      Require-Ok "Create REVEX Artifact Registry repository" $GCloud @("artifacts","repositories","create",$Repository,"--repository-format","docker","--location",$Region,"--project",$ProjectId,"--description","REVEX managed runtimes") -Quiet
    }
    $buildSa = Capture-Native $GCloud @("builds","get-default-service-account","--project",$ProjectId,"--format","value(serviceAccountEmail)")
    if ($buildSa.Code -ne 0 -or -not $buildSa.Text) { throw "Cloud Build service account could not be resolved." }
    $CloudBuildSa = ($buildSa.Text -split "`n")[0].Trim()
    Add-ProjectRole $GCloud "serviceAccount:$CloudBuildSa" "roles/cloudbuild.builds.builder" "Grant Cloud Build builder role"
    Add-ProjectRole $GCloud "serviceAccount:$CloudBuildSa" "roles/artifactregistry.writer" "Grant Cloud Build image push access"
    Require-Ok "Build exact current Energy worker image" $GCloud @(
      "builds","submit",$Root,"--project",$ProjectId,"--config",$CloudBuild,
      "--substitutions","_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-energy-worker,_TAG=$ImageTag"
    )
    Require-Ok "Deploy private current Energy candidate" $GCloud @(
      "run","deploy",$Service,"--project",$ProjectId,"--region",$Region,"--platform","managed",
      "--image",$Image,"--service-account",$WorkerSa,"--no-allow-unauthenticated",
      "--cpu=4","--memory=8Gi","--concurrency=1","--min-instances=0","--max-instances=3","--timeout=3600",
      "--set-env-vars","REVEX_ENERGY_TIMEOUT_SECONDS=3500,REVEX_SOURCE_CANDIDATE=$SourceCandidate,REVEX_VERTEX_PROJECT=$ProjectId,REVEX_VERTEX_LOCATION=global",
      "--quiet"
    )
    $WorkerUrl = Resolve-VerifiedCandidate $GCloud
    Require-Ok "Allow only REVEX Energy broker to invoke candidate" $GCloud @(
      "run","services","add-iam-policy-binding",$Service,"--project",$ProjectId,"--region",$Region,
      "--member","serviceAccount:$BrokerSa","--role","roles/run.invoker","--quiet"
    ) -Quiet
    Write-Host "PASS: Energy candidate is Ready and source-bound; live broker has not changed yet." -ForegroundColor Green
    if ($CandidateOnly) { $ExitCode = 0; return }
  }

  $WorkerUrl = Resolve-VerifiedCandidate $GCloud
  $Firebase = Require-Command "firebase"
  $Npm = Require-Command "npm"
  if (-not (Native-Ok $Firebase @("projects:list","--json"))) { throw "Firebase administrator sign-in is required before Energy broker cutover." }
  Push-Location $FunctionsDir
  try {
    Require-Ok "Install pinned Energy broker dependencies" $Npm @("install","--omit=dev","--no-audit","--no-fund")
    if (Test-Path -LiteralPath $EnvPath) { $EnvBackup = "$EnvPath.revex-current-backup"; Copy-Item -LiteralPath $EnvPath -Destination $EnvBackup -Force }
    @(
      "REVEX_ENERGY_WORKER_URL=$WorkerUrl",
      "REVEX_ENERGY_BROKER_SERVICE_ACCOUNT=$BrokerSa",
      "REVEX_SOURCE_CANDIDATE=$SourceCandidate"
    ) | Set-Content -LiteralPath $EnvPath -Encoding Ascii
    $env:FUNCTIONS_DISCOVERY_TIMEOUT = "60"
    Require-Ok "Cut authenticated Energy broker over to verified candidate" $Firebase @("deploy","--only","functions:revex-energy","--project",$ProjectId,"--force","--non-interactive")
  } finally {
    if (Test-Path -LiteralPath $EnvPath) { Remove-Item -LiteralPath $EnvPath -Force }
    if ($EnvBackup -and (Test-Path -LiteralPath $EnvBackup)) { Move-Item -LiteralPath $EnvBackup -Destination $EnvPath -Force }
    Pop-Location
  }
  $functionState = Capture-Native $GCloud @("functions","describe","runRevexEnergy","--gen2","--project",$ProjectId,"--region",$Region,"--format","json")
  if ($functionState.Code -ne 0 -or -not $functionState.Text) { throw "Energy broker could not be verified after cutover." }
  $function = $functionState.Text | ConvertFrom-Json
  if ([string]$function.state -ne "ACTIVE") { throw "Energy broker is not ACTIVE after cutover." }
  $brokerWorker = [string]$function.serviceConfig.environmentVariables.REVEX_ENERGY_WORKER_URL
  $brokerSource = [string]$function.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE
  if ($brokerWorker -ne $WorkerUrl) { throw "Energy broker is not bound to the verified candidate worker." }
  if ($brokerSource -ne $SourceCandidate) { throw "Energy broker source SHA does not match the release source." }
  Write-Host "PASS: current Energy broker is ACTIVE on the verified source-bound candidate." -ForegroundColor Green
  $ExitCode = 0
}
catch {
  Write-Host "REVEX current Energy deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  if (-not $BrokerOnly) { Write-Host "A failed candidate never cuts the live Energy broker over." -ForegroundColor Yellow }
  $ExitCode = 1
}
finally {
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') { Write-Host "Press Enter to close."; [void](Read-Host) }
}
exit $ExitCode
