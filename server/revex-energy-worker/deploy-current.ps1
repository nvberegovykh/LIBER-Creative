param(
  [string]$ProjectId = "liber-apps-cca20",
  [ValidateSet("us-central1")][string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-energy-current",
  [string]$StorageBucket = "",
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
$Bucket = ""
$Short = $SourceCandidate.Substring(0,12).ToLowerInvariant()
$ImageTag = "current-$Short"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-energy-worker:$ImageTag"
$EnvPath = Join-Path $FunctionsDir ".env.$ProjectId"
$EnvBackup = $null
$ExitCode = 1
$PinnedNodeVersion = "22.23.2"
$PinnedFirebaseToolsVersion = "15.26.0"

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
function Resolve-StorageBucket([string]$GCloud,[string]$RequestedBucket) {
  $rows = Capture-Native $GCloud @("storage","buckets","list","--project",$ProjectId,"--format","value(name)")
  if ($rows.Code -ne 0) { throw "Could not enumerate project Storage buckets." }
  $prefix = [Regex]::Escape($ProjectId)
  $names = @($rows.Text -split "`n" | ForEach-Object { $_.Trim().TrimEnd('/') -replace '^gs://','' } | Where-Object { $_ } | Select-Object -Unique)
  $matches = @($names | Where-Object { $_ -match "^$prefix\.(?:appspot\.com|firebasestorage\.app)$" })
  if ($RequestedBucket) {
    $requested = $RequestedBucket.Trim().TrimEnd('/') -replace '^gs://',''
    if ($requested -notmatch "^$prefix\.(?:appspot\.com|firebasestorage\.app)$") { throw "StorageBucket is not owned by $ProjectId: $requested" }
    if ($requested -notin $matches) { throw "The requested Storage bucket is not present in $ProjectId: $requested" }
    return [string]$requested
  }
  $modern = "$ProjectId.firebasestorage.app"
  if ($modern -in $matches) { return $modern }
  if ($matches.Count -ne 1) { throw "Firebase Storage is ambiguous for $ProjectId; pass -StorageBucket. Found: $($matches -join ', ')." }
  return [string]$matches[0]
}
function Resolve-VerifiedCandidate([string]$GCloud) {
  $state = Capture-Native $GCloud @("run","services","describe",$Service,"--project",$ProjectId,"--region",$Region,"--format","json")
  if ($state.Code -ne 0 -or -not $state.Text) { throw "Energy candidate service is unavailable: $Service" }
  $run = $state.Text | ConvertFrom-Json
  $ready = @($run.status.conditions | Where-Object { $_.type -eq "Ready" } | Select-Object -First 1)
  if ($ready.Count -eq 0 -or [string]$ready[0].status -ne "True") { throw "Energy candidate is not Ready; broker remains unchanged." }
  if ([string]$run.spec.template.spec.serviceAccountName -ne $WorkerSa) { throw "Energy candidate is not attached to the controlled worker identity." }
  $url = [string]$run.status.url
  if (-not $url) { throw "Energy candidate has no ready service URL; broker remains unchanged." }
  $liveEnv = @{}
  foreach ($row in @($run.spec.template.spec.containers[0].env)) { $liveEnv[[string]$row.name] = [string]$row.value }
  if ([string]$liveEnv["REVEX_SOURCE_CANDIDATE"] -ne $SourceCandidate) { throw "Energy candidate source SHA does not match the exact release source." }
  if ([string]$liveEnv["REVEX_STORAGE_BUCKET"] -ne $Bucket) { throw "Energy candidate Storage bucket does not match the selected release bucket." }
  if ([string]$liveEnv["REVEX_VERTEX_PROJECT"] -ne $ProjectId -or [string]$liveEnv["REVEX_VERTEX_LOCATION"] -ne "global") { throw "Energy candidate Vertex binding is not canonical." }
  return $url
}
function Try-ResolveVerifiedCandidate([string]$GCloud) {
  try { return [string](Resolve-VerifiedCandidate $GCloud) }
  catch { return "" }
}
function Install-PinnedFirebaseToolchain([string]$Npm) {
  Require-Ok "Install pinned Firebase Node 22 deployment toolchain" $Npm @(
    "install","--no-save","--no-package-lock","--no-audit","--no-fund",
    "node@$PinnedNodeVersion","firebase-tools@$PinnedFirebaseToolsVersion"
  )
  $nodeCandidates = @(
    (Join-Path $FunctionsDir "node_modules\node\bin\node.exe"),
    (Join-Path $FunctionsDir "node_modules\node\bin\node")
  )
  $Node22 = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $Node22) { throw "Pinned Node $PinnedNodeVersion binary was not installed in the Energy functions checkout." }
  $FirebaseJs = Join-Path $FunctionsDir "node_modules\firebase-tools\lib\bin\firebase.js"
  if (-not (Test-Path -LiteralPath $FirebaseJs -PathType Leaf)) { throw "Pinned firebase-tools $PinnedFirebaseToolsVersion entry point was not installed." }
  $nodeVersion = Capture-Native $Node22 @("--version")
  if ($nodeVersion.Code -ne 0 -or $nodeVersion.Text -ne "v$PinnedNodeVersion") { throw "Energy broker deployment requires Node v$PinnedNodeVersion; resolved '$($nodeVersion.Text)'." }
  $firebaseVersion = Capture-Native $Node22 @($FirebaseJs,"--version")
  if ($firebaseVersion.Code -ne 0 -or $firebaseVersion.Text -ne $PinnedFirebaseToolsVersion) { throw "Energy broker deployment requires firebase-tools $PinnedFirebaseToolsVersion; resolved '$($firebaseVersion.Text)'." }
  Write-Host "PASS: pinned Firebase deployment runtime is Node $PinnedNodeVersion + firebase-tools $PinnedFirebaseToolsVersion." -ForegroundColor Green
  return [pscustomobject]@{ Node=$Node22; FirebaseJs=$FirebaseJs }
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
  $Bucket = Resolve-StorageBucket $GCloud $StorageBucket

  # The Firebase codebase also owns the all-member Google Render callable. These
  # broker prerequisites are required in BrokerOnly mode as well as a full worker
  # deployment; ordinary REVEX users never receive Google Cloud IAM themselves.
  Require-Ok "Enable authenticated Firebase broker APIs" $GCloud @(
    "services","enable","cloudfunctions.googleapis.com","firebase.googleapis.com",
    "generativelanguage.googleapis.com","firestore.googleapis.com","serviceusage.googleapis.com","--project",$ProjectId
  ) -Quiet
  $null = Ensure-ServiceAccount $GCloud "revex-energy-broker" "REVEX Energy + Google Render Broker"
  Add-ServiceAccountUser $GCloud $BrokerSa "user:$Deployer" "Allow deployer to use the controlled Firebase broker identity"
  Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/datastore.user" "Grant broker durable Firestore access"
  Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/storage.objectAdmin" "Grant broker project Storage access"
  Add-ProjectRole $GCloud "serviceAccount:$BrokerSa" "roles/serviceusage.serviceUsageConsumer" "Grant broker metered Google API consumption"

  if (-not $BrokerOnly) {
    Require-Ok "Select Google Cloud project" $GCloud @("config","set","project",$ProjectId) -Quiet
    Require-Ok "Enable Energy infrastructure APIs" $GCloud @(
      "services","enable","run.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com",
      "iamcredentials.googleapis.com","cloudfunctions.googleapis.com","firebase.googleapis.com",
      "aiplatform.googleapis.com","generativelanguage.googleapis.com","firestore.googleapis.com","serviceusage.googleapis.com","--project",$ProjectId
    ) -Quiet
    $null = Ensure-ServiceAccount $GCloud "revex-energy-worker" "REVEX Energy Worker"
    Add-ServiceAccountUser $GCloud $WorkerSa "user:$Deployer" "Allow deployer to use Energy worker identity"
    Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/storage.objectAdmin" "Grant Energy worker immutable Storage access"
    Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/datastore.user" "Grant Energy worker durable Firestore access"
    Add-ProjectRole $GCloud "serviceAccount:$WorkerSa" "roles/aiplatform.user" "Grant Energy worker Vertex page-analysis access"
    if (-not (Native-Ok $GCloud @("artifacts","repositories","describe",$Repository,"--location",$Region,"--project",$ProjectId))) {
      Require-Ok "Create REVEX Artifact Registry repository" $GCloud @("artifacts","repositories","create",$Repository,"--repository-format","docker","--location",$Region,"--project",$ProjectId,"--description","REVEX managed runtimes") -Quiet
    }
    $buildSa = Capture-Native $GCloud @("builds","get-default-service-account","--project",$ProjectId,"--format","value(serviceAccountEmail)")
    if ($buildSa.Code -ne 0 -or -not $buildSa.Text) { throw "Cloud Build service account could not be resolved." }
    $CloudBuildSa = ($buildSa.Text -split "`n")[0].Trim()
    Add-ProjectRole $GCloud "serviceAccount:$CloudBuildSa" "roles/cloudbuild.builds.builder" "Grant Cloud Build builder role"
    Add-ProjectRole $GCloud "serviceAccount:$CloudBuildSa" "roles/artifactregistry.writer" "Grant Cloud Build image push access"

    $WorkerUrl = Try-ResolveVerifiedCandidate $GCloud
    if ($WorkerUrl) {
      Write-Host "PASS: exact source-bound Energy candidate is already Ready; skipping duplicate Cloud Build and Cloud Run deployment." -ForegroundColor Green
    } else {
      Require-Ok "Build exact current Energy worker image" $GCloud @(
        "builds","submit",$Root,"--project",$ProjectId,"--config",$CloudBuild,
        "--substitutions","_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-energy-worker,_TAG=$ImageTag"
      )
      Require-Ok "Deploy private current Energy candidate" $GCloud @(
        "run","deploy",$Service,"--project",$ProjectId,"--region",$Region,"--platform","managed",
        "--image",$Image,"--service-account",$WorkerSa,"--no-allow-unauthenticated",
        "--cpu=4","--memory=8Gi","--concurrency=1","--min-instances=0","--max-instances=3","--timeout=3600",
        "--set-env-vars","REVEX_ENERGY_TIMEOUT_SECONDS=3500,REVEX_SOURCE_CANDIDATE=$SourceCandidate,REVEX_STORAGE_BUCKET=$Bucket,REVEX_VERTEX_PROJECT=$ProjectId,REVEX_VERTEX_LOCATION=global,REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_current.py,REVEX_PIPELINE_IMPL=/opt/revex/energy/revex_energy_pipeline.py",
        "--quiet"
      )
      $WorkerUrl = Resolve-VerifiedCandidate $GCloud
    }
    Require-Ok "Allow only REVEX Energy broker to invoke candidate" $GCloud @(
      "run","services","add-iam-policy-binding",$Service,"--project",$ProjectId,"--region",$Region,
      "--member","serviceAccount:$BrokerSa","--role","roles/run.invoker","--quiet"
    ) -Quiet
    Write-Host "PASS: Energy candidate is Ready and source-bound; live broker has not changed yet." -ForegroundColor Green
    if ($CandidateOnly) { $ExitCode = 0; return }
  }

  $WorkerUrl = Resolve-VerifiedCandidate $GCloud
  $Npm = Require-Command "npm"
  Push-Location $FunctionsDir
  try {
    Require-Ok "Install pinned Energy broker dependencies" $Npm @("install","--omit=dev","--no-audit","--no-fund")
    $FirebaseToolchain = Install-PinnedFirebaseToolchain $Npm
    $Node22 = [string]$FirebaseToolchain.Node
    $FirebaseJs = [string]$FirebaseToolchain.FirebaseJs
    if (-not (Native-Ok $Node22 @($FirebaseJs,"projects:list","--json"))) { throw "Firebase administrator sign-in is required before Energy broker cutover." }
    if (Test-Path -LiteralPath $EnvPath) { $EnvBackup = "$EnvPath.revex-current-backup"; Copy-Item -LiteralPath $EnvPath -Destination $EnvBackup -Force }
    @(
      "REVEX_ENERGY_WORKER_URL=$WorkerUrl",
      "REVEX_ENERGY_BROKER_SERVICE_ACCOUNT=$BrokerSa",
      "REVEX_RENDER_BROKER_SERVICE_ACCOUNT=$BrokerSa",
      "REVEX_STORAGE_BUCKET=$Bucket",
      "REVEX_SOURCE_CANDIDATE=$SourceCandidate"
    ) | Set-Content -LiteralPath $EnvPath -Encoding Ascii

    $preflight = "const started=Date.now();const m=require('./main.js');const required=['runRevexEnergy','runRevexGoogleRender','ensureProjectChatHttp','recoverSecureChatIdentityHttp','saveFcmTokenHttp','onChatMessageWrite'];const missing=required.filter(k=>typeof m[k]!=='function');if(missing.length){console.error('REVEX Firebase preflight missing exports: '+missing.join(','));process.exit(2);}console.log('REVEX_FIREBASE_NODE22_PREFLIGHT=PASSED ms='+(Date.now()-started)+' exports='+required.join(','));"
    Require-Ok "Preflight-load Energy broker under pinned Node 22" $Node22 @("-e",$preflight)

    $env:FUNCTIONS_DISCOVERY_TIMEOUT = "180"
    Require-Ok "Deploy only the authenticated Energy and Google Render brokers" $Node22 @(
      $FirebaseJs,"deploy","--only","functions:revex-energy:runRevexEnergy,functions:revex-energy:runRevexGoogleRender","--project",$ProjectId,"--force","--non-interactive"
    )
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
  if ([string]$function.serviceConfig.serviceAccountEmail -ne $BrokerSa) { throw "Energy broker is not attached to the controlled broker identity." }
  if ($brokerWorker -ne $WorkerUrl) { throw "Energy broker is not bound to the verified candidate worker." }
  if ($brokerSource -ne $SourceCandidate) { throw "Energy broker source SHA does not match the release source." }
  if ([string]$function.serviceConfig.environmentVariables.REVEX_STORAGE_BUCKET -ne $Bucket) { throw "Energy broker Storage bucket does not match the selected release bucket." }
  $renderState = Capture-Native $GCloud @("functions","describe","runRevexGoogleRender","--gen2","--project",$ProjectId,"--region","us-central1","--format","json")
  if ($renderState.Code -ne 0 -or -not $renderState.Text) { throw "Google Render broker could not be verified after cutover." }
  $renderFunction = $renderState.Text | ConvertFrom-Json
  if ([string]$renderFunction.state -ne "ACTIVE") { throw "Google Render broker is not ACTIVE after cutover." }
  if ([string]$renderFunction.serviceConfig.serviceAccountEmail -ne $BrokerSa) { throw "Google Render broker is not attached to the controlled broker identity." }
  if ([string]$renderFunction.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE -ne $SourceCandidate) { throw "Google Render broker source SHA does not match the release source." }
  if ([string]$renderFunction.serviceConfig.environmentVariables.REVEX_STORAGE_BUCKET -ne $Bucket) { throw "Google Render broker Storage bucket does not match the selected release bucket." }
  $geminiApi = Capture-Native $GCloud @("services","list","--enabled","--project",$ProjectId,"--filter","config.name=generativelanguage.googleapis.com","--format","value(config.name)")
  if ($geminiApi.Code -ne 0 -or $geminiApi.Text -ne "generativelanguage.googleapis.com") { throw "Generative Language API is not enabled after Google Render cutover." }
  $consumerPolicy = Capture-Native $GCloud @("projects","get-iam-policy",$ProjectId,"--format","json")
  if ($consumerPolicy.Code -ne 0 -or -not $consumerPolicy.Text) { throw "Google Render broker IAM policy could not be verified." }
  $policy = $consumerPolicy.Text | ConvertFrom-Json
  $consumerBinding = @($policy.bindings | Where-Object {
    [string]$_.role -eq "roles/serviceusage.serviceUsageConsumer" -and @($_.members) -contains "serviceAccount:$BrokerSa"
  })
  if ($consumerBinding.Count -eq 0) { throw "Google Render broker lacks roles/serviceusage.serviceUsageConsumer." }
  Write-Host "PASS: current Energy broker is ACTIVE on the verified source-bound candidate." -ForegroundColor Green
  Write-Host "PASS: authenticated Google Render broker is ACTIVE, source-bound and uses the controlled project broker identity." -ForegroundColor Green
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
