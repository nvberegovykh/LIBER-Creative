param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-energy-worker",
  [string]$ReleaseTag = "0.8.19-r41",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$LogPath = Join-Path $PSScriptRoot "DEPLOY_ENERGY_SERVER.latest.log"
$StageRoot = Join-Path ([IO.Path]::GetTempPath()) "revex-energy-deploy-r41"
$TranscriptPath = Join-Path ([IO.Path]::GetTempPath()) ("revex-energy-deploy-r41-{0}.log" -f $PID)
$TranscriptStarted = $false

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Step,
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @(),
    [switch]$QuietOutput
  )
  Write-Host ">> $Step" -ForegroundColor DarkCyan
  if ($QuietOutput) { & $Command @Arguments | Out-Null } else { & $Command @Arguments }
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "$Step failed with exit code $code." }
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory = $true)][string]$Step,
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )
  $output = @(& $Command @Arguments)
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    if ($output.Length -gt 0) { Write-Host ($output -join [Environment]::NewLine) }
    throw "$Step failed with exit code $code."
  }
  return $output
}

function Test-NativeSuccess {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $code = -1
  try {
    # Existence/authentication probes intentionally use the native exit code.
    # Suppress the probe's stderr so NOT_FOUND cannot become a terminating
    # PowerShell error before the create-or-login branch can run.
    $ErrorActionPreference = "SilentlyContinue"
    & $Command @Arguments *> $null
    $code = $LASTEXITCODE
  } catch {
    $code = -1
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return ($code -eq 0)
}

function Resolve-Executable {
  param([Parameter(Mandatory = $true)][string[]]$Names)
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  return $null
}

function Refresh-AdminPath {
  $extra = @(
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin",
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin",
    "${env:ProgramFiles(x86)}\Google\Cloud SDK\google-cloud-sdk\bin",
    "$env:ProgramFiles\nodejs",
    "${env:ProgramFiles(x86)}\nodejs",
    "$env:APPDATA\npm"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  foreach ($entry in $extra) {
    if (($env:Path -split ';') -notcontains $entry) { $env:Path += ";$entry" }
  }
}

function Ensure-Winget {
  $winget = Resolve-Executable @("winget.exe", "winget")
  if (-not $winget) {
    throw "Windows Package Manager (winget) is required only to install missing deployment tools. Install Google Cloud CLI and Node.js LTS, then rerun this same script."
  }
  return $winget
}

function Ensure-GCloud {
  Refresh-AdminPath
  $gcloud = Resolve-Executable @("gcloud.cmd", "gcloud.exe", "gcloud")
  if ($gcloud) { return $gcloud }
  $winget = Ensure-Winget
  Invoke-Checked "Install Google Cloud CLI (one-time deployment dependency)" $winget @(
    "install", "--id", "Google.CloudSDK", "-e",
    "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
  )
  Refresh-AdminPath
  $gcloud = Resolve-Executable @("gcloud.cmd", "gcloud.exe", "gcloud")
  if (-not $gcloud) {
    throw "Google Cloud CLI installed but is not visible to this PowerShell process. Close this window and rerun DEPLOY_ENERGY_SERVER.cmd once; the cloud deployment has not started yet."
  }
  return $gcloud
}

function Ensure-Firebase {
  Refresh-AdminPath
  $firebase = Resolve-Executable @("firebase.cmd", "firebase.exe", "firebase")
  if ($firebase) { return $firebase }
  $npm = Resolve-Executable @("npm.cmd", "npm.exe", "npm")
  if (-not $npm) {
    $winget = Ensure-Winget
    Invoke-Checked "Install Node.js LTS (one-time Firebase CLI dependency)" $winget @(
      "install", "--id", "OpenJS.NodeJS.LTS", "-e",
      "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
    )
    Refresh-AdminPath
    $npm = Resolve-Executable @("npm.cmd", "npm.exe", "npm")
  }
  if (-not $npm) {
    throw "Node.js LTS installed but npm is not visible to this PowerShell process. Close this window and rerun DEPLOY_ENERGY_SERVER.cmd once; the cloud deployment has not started yet."
  }
  Invoke-Checked "Install Firebase CLI (one-time deployment dependency)" $npm @("install", "-g", "firebase-tools")
  Refresh-AdminPath
  $firebase = Resolve-Executable @("firebase.cmd", "firebase.exe", "firebase")
  if (-not $firebase) {
    throw "Firebase CLI installed but is not visible to this PowerShell process. Close this window and rerun DEPLOY_ENERGY_SERVER.cmd once; the cloud deployment has not started yet."
  }
  return $firebase
}

function Assert-SourceFile {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $path = Join-Path $Root $RelativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required r41 source file is missing: $RelativePath. Wait for the existing LIBER_REVEX_0.8.19_SOURCE Drive folder to finish syncing, then rerun."
  }
  return $path
}

function Assert-SourceDirectory {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $path = Join-Path $Root $RelativePath
  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    throw "Required r41 source directory is missing: $RelativePath. Wait for the existing LIBER_REVEX_0.8.19_SOURCE Drive folder to finish syncing, then rerun."
  }
  return $path
}

function Add-ProjectRole {
  param(
    [Parameter(Mandatory = $true)][string]$Member,
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Invoke-Checked $Label $script:GCloud @(
    "projects", "add-iam-policy-binding", $ProjectId,
    "--member=$Member", "--role=$Role", "--quiet"
  ) -QuietOutput
}

function Add-ServiceAccountUser {
  param(
    [Parameter(Mandatory = $true)][string]$ServiceAccount,
    [Parameter(Mandatory = $true)][string]$Member,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Invoke-Checked $Label $script:GCloud @(
    "iam", "service-accounts", "add-iam-policy-binding", $ServiceAccount,
    "--project=$ProjectId", "--member=$Member", "--role=roles/iam.serviceAccountUser", "--quiet"
  ) -QuietOutput
}

function Publish-DeploymentLog {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return $false }
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
      Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue
      return $true
    } catch {
      if ($attempt -lt 5) { Start-Sleep -Milliseconds 750 }
      else {
        Write-Warning "The deployment finished, but Google Drive kept the rotating log locked. The complete temporary log remains at $Source. $($_.Exception.Message)"
      }
    }
  }
  return $false
}

try {
  try {
    if (Test-Path -LiteralPath $TranscriptPath) { Remove-Item -LiteralPath $TranscriptPath -Force }
    Start-Transcript -LiteralPath $TranscriptPath -Force -ErrorAction Stop | Out-Null
    $TranscriptStarted = $true
  } catch {
    $TranscriptStarted = $false
    Write-Warning "Detailed transcript logging could not start; deployment will continue and console output remains authoritative. $($_.Exception.Message)"
  }

  Write-Host "REVEX managed Energy deployment 0.8.19-r41" -ForegroundColor Cyan
  Write-Host "Production target: private Google Cloud Run + Firebase broker"
  Write-Host "Project: $ProjectId  Region: $Region"
  Write-Host "Log: $LogPath"

  $WorkerDir = Assert-SourceDirectory "server\revex-energy-worker"
  $EnergyDir = Assert-SourceDirectory "src\Liber.Revex.Revit\Engineering\Energy"
  $FunctionsDir = Assert-SourceDirectory "server\firebase-functions"
  $Dockerfile = Assert-SourceFile "server\revex-energy-worker\Dockerfile"
  $WorkerApp = Assert-SourceFile "server\revex-energy-worker\app.py"
  $WorkerRequirements = Assert-SourceFile "server\revex-energy-worker\requirements-server.txt"
  $CloudBuildConfig = Assert-SourceFile "server\revex-energy-worker\cloudbuild.yaml"
  $FunctionIndex = Assert-SourceFile "server\firebase-functions\index.js"
  $FunctionPackage = Assert-SourceFile "server\firebase-functions\package.json"
  $FirebaseConfig = Assert-SourceFile "server\firebase-functions\firebase.json"

  $appHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $WorkerApp).Hash.ToLowerInvariant()
  $buildHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CloudBuildConfig).Hash.ToLowerInvariant()
  if ($appHash -ne "2851214e05ab8cb27f1acad6817455fd2cdd31884c11a8688172366a192999b5") {
    throw "app.py does not match the locked r41 Drive source hash. Deployment stopped before cloud changes."
  }
  if ($buildHash -ne "6c8bbf8b2f6c64b9c3b3344ec86c31ef332bf499e5b663843ed704e292ebef00") {
    throw "cloudbuild.yaml does not match the locked r41 Drive source hash. Deployment stopped before cloud changes."
  }

  $script:GCloud = Ensure-GCloud
  $Firebase = Ensure-Firebase
  $Npm = Resolve-Executable @("npm.cmd", "npm.exe", "npm")
  if (-not $Npm) {
    throw "npm is required to install the Firebase broker dependencies. Close this window and rerun DEPLOY_ENERGY_SERVER.cmd once."
  }

  $activeAccounts = @(
    @(Invoke-Captured "Read active Google Cloud account" $script:GCloud @(
      "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"
    )) | Where-Object { $_ -and ([string]$_).Trim() }
  )
  if ($activeAccounts.Length -eq 0) {
    Invoke-Checked "Google Cloud administrator sign-in" $script:GCloud @("auth", "login")
    $activeAccounts = @(
      @(Invoke-Captured "Verify Google Cloud sign-in" $script:GCloud @(
        "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"
      )) | Where-Object { $_ -and ([string]$_).Trim() }
    )
  }
  if ($activeAccounts.Length -eq 0) { throw "Google Cloud sign-in did not produce an active account." }
  $Deployer = [string]$activeAccounts[0]

  if (-not (Test-NativeSuccess $Firebase @("projects:list", "--json"))) {
    Invoke-Checked "Firebase administrator sign-in" $Firebase @("login")
  }
  $firebaseProjects = @(Invoke-Captured "Verify Firebase project access" $Firebase @("projects:list", "--json")) -join [Environment]::NewLine
  if ($firebaseProjects -notmatch [regex]::Escape($ProjectId)) {
    throw "The active Firebase account cannot access $ProjectId. Sign in with the project administrator and rerun."
  }

  Invoke-Checked "Verify Google Cloud project access" $script:GCloud @(
    "projects", "describe", $ProjectId, "--format=value(projectId)"
  ) -QuietOutput
  Invoke-Checked "Set active Google Cloud project" $script:GCloud @("config", "set", "project", $ProjectId) -QuietOutput
  Invoke-Checked "Enable required managed-service APIs" $script:GCloud @(
    "services", "enable",
    "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com", "cloudfunctions.googleapis.com", "firebase.googleapis.com",
    "aiplatform.googleapis.com", "serviceusage.googleapis.com",
    "--project=$ProjectId"
  ) -QuietOutput

  $WorkerSaName = "revex-energy-worker"
  $BrokerSaName = "revex-energy-broker"
  $WorkerSa = "$WorkerSaName@$ProjectId.iam.gserviceaccount.com"
  $BrokerSa = "$BrokerSaName@$ProjectId.iam.gserviceaccount.com"
  $accounts = @(Invoke-Captured "List REVEX service accounts" $script:GCloud @(
    "iam", "service-accounts", "list", "--project=$ProjectId", "--format=value(email)"
  ))
  if ($accounts -notcontains $WorkerSa) {
    Invoke-Checked "Create REVEX Energy worker identity" $script:GCloud @(
      "iam", "service-accounts", "create", $WorkerSaName,
      "--display-name=REVEX Energy Worker", "--project=$ProjectId"
    ) -QuietOutput
  }
  if ($accounts -notcontains $BrokerSa) {
    Invoke-Checked "Create REVEX Energy broker identity" $script:GCloud @(
      "iam", "service-accounts", "create", $BrokerSaName,
      "--display-name=REVEX Energy Broker", "--project=$ProjectId"
    ) -QuietOutput
  }

  Add-ServiceAccountUser $WorkerSa "user:$Deployer" "Allow the administrator to deploy the private worker"
  Add-ServiceAccountUser $BrokerSa "user:$Deployer" "Allow the administrator to deploy the Firebase broker"
  Add-ProjectRole "serviceAccount:$WorkerSa" "roles/storage.objectAdmin" "Grant worker result-object access"
  Add-ProjectRole "serviceAccount:$WorkerSa" "roles/aiplatform.user" "Grant worker managed page-scan access"
  Add-ProjectRole "serviceAccount:$BrokerSa" "roles/datastore.user" "Grant broker Firestore access"

  $repositoryExists = Test-NativeSuccess $script:GCloud @(
    "artifacts", "repositories", "describe", $Repository,
    "--project=$ProjectId", "--location=$Region"
  )
  if (-not $repositoryExists) {
    Invoke-Checked "Create REVEX Artifact Registry repository" $script:GCloud @(
      "artifacts", "repositories", "create", $Repository,
      "--repository-format=docker", "--location=$Region",
      "--description=REVEX managed runtimes", "--project=$ProjectId"
    ) -QuietOutput
  }

  $CloudBuildSa = [string](@(Invoke-Captured "Resolve the actual Cloud Build default identity" $script:GCloud @(
    "builds", "get-default-service-account", "--project=$ProjectId", "--format=value(serviceAccountEmail)"
  )) | Select-Object -First 1)
  if (-not $CloudBuildSa.Trim()) { throw "Cloud Build default service account was not returned." }
  Add-ProjectRole "serviceAccount:$CloudBuildSa" "roles/cloudbuild.builds.builder" "Grant the actual Cloud Build identity its standard builder role"
  Add-ProjectRole "serviceAccount:$CloudBuildSa" "roles/artifactregistry.writer" "Grant the actual Cloud Build identity image-push access"
  Write-Host "Cloud Functions service-agent creation is delegated to the real Firebase deployment; ACTIVE broker verification remains mandatory." -ForegroundColor DarkGray

  if (Test-Path -LiteralPath $StageRoot) { Remove-Item -LiteralPath $StageRoot -Recurse -Force }
  $StageWorker = Join-Path $StageRoot "server\revex-energy-worker"
  $StageEnergy = Join-Path $StageRoot "src\Liber.Revex.Revit\Engineering\Energy"
  $StageFunctions = Join-Path $StageRoot "server\firebase-functions"
  New-Item -ItemType Directory -Path $StageWorker, $StageEnergy, $StageFunctions -Force | Out-Null
  Copy-Item -LiteralPath $Dockerfile, $WorkerApp, $WorkerRequirements, $CloudBuildConfig -Destination $StageWorker -Force
  Copy-Item -Path (Join-Path $EnergyDir "*") -Destination $StageEnergy -Recurse -Force
  Copy-Item -LiteralPath $FunctionIndex, $FunctionPackage, $FirebaseConfig -Destination $StageFunctions -Force

  $Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/revex-energy-worker`:$ReleaseTag"
  $reuseWorker = $false
  if ((Test-NativeSuccess $script:GCloud @(
    "artifacts", "docker", "images", "describe", $Image, "--project=$ProjectId"
  )) -and (Test-NativeSuccess $script:GCloud @(
    "run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region"
  ))) {
    try {
      $desiredImageDigest = [string](@(Invoke-Captured "Resolve pinned r41 image digest" $script:GCloud @(
        "artifacts", "docker", "images", "describe", $Image, "--project=$ProjectId",
        "--format=value(image_summary.fully_qualified_digest)"
      )) | Select-Object -First 1)
      $existingRunJson = @(Invoke-Captured "Inspect existing private REVEX Energy worker" $script:GCloud @(
        "run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json"
      )) -join [Environment]::NewLine
      $existingRunState = $existingRunJson | ConvertFrom-Json
      $existingWorkerUrl = [string]$existingRunState.status.url
      $existingReady = @($existingRunState.status.conditions | Where-Object { $_.type -eq "Ready" } | Select-Object -First 1)
      $existingImage = [string]$existingRunState.spec.template.spec.containers[0].image
      if ($desiredImageDigest.Trim() -and $existingWorkerUrl.Trim() -and
          $existingReady.Length -gt 0 -and [string]$existingReady[0].status -eq "True" -and
          ($existingImage -eq $Image -or $existingImage -eq $desiredImageDigest)) {
        $reuseWorker = $true
        Write-Host "Pinned r41 private worker is already ready; skipping duplicate image build and Cloud Run deployment." -ForegroundColor DarkGray
      }
    } catch {
      Write-Warning "Existing worker could not be proven identical to the pinned r41 image; it will be rebuilt safely. $($_.Exception.Message)"
    }
  }

  if (-not $reuseWorker) {
    Push-Location $StageRoot
    try {
      Invoke-Checked "Build and push the pinned r41 managed image" $script:GCloud @(
        "builds", "submit", "--project=$ProjectId",
        "--config=server/revex-energy-worker/cloudbuild.yaml",
        "--substitutions=_REGION=$Region,_REPOSITORY=$Repository,_IMAGE=revex-energy-worker,_TAG=$ReleaseTag",
        "."
      )
    } finally { Pop-Location }

    Invoke-Checked "Deploy private REVEX Energy worker to Cloud Run" $script:GCloud @(
      "run", "deploy", $Service, "--project=$ProjectId", "--region=$Region",
      "--image=$Image", "--service-account=$WorkerSa", "--no-allow-unauthenticated",
      "--cpu=4", "--memory=8Gi", "--concurrency=1", "--min-instances=0", "--max-instances=3",
      "--timeout=3600", "--set-env-vars=REVEX_ENERGY_TIMEOUT_SECONDS=3500", "--quiet"
    )
  }

  $runJsonText = @(Invoke-Captured "Verify Cloud Run service readiness" $script:GCloud @(
    "run", "services", "describe", $Service, "--project=$ProjectId", "--region=$Region", "--format=json"
  )) -join [Environment]::NewLine
  $runState = $runJsonText | ConvertFrom-Json
  $WorkerUrl = [string]$runState.status.url
  $readyCondition = @($runState.status.conditions | Where-Object { $_.type -eq "Ready" } | Select-Object -First 1)
  if (-not $WorkerUrl.Trim() -or $readyCondition.Length -eq 0 -or [string]$readyCondition[0].status -ne "True") {
    throw "Cloud Run did not report a ready private worker revision."
  }
  Invoke-Checked "Grant broker-only private worker invocation" $script:GCloud @(
    "run", "services", "add-iam-policy-binding", $Service,
    "--project=$ProjectId", "--region=$Region", "--member=serviceAccount:$BrokerSa",
    "--role=roles/run.invoker", "--quiet"
  ) -QuietOutput

  Set-Content -LiteralPath (Join-Path $StageFunctions ".env.$ProjectId") -Encoding Ascii -Value @(
    "REVEX_ENERGY_WORKER_URL=$WorkerUrl",
    "REVEX_ENERGY_BROKER_SERVICE_ACCOUNT=$BrokerSa"
  )
  Push-Location $StageFunctions
  try {
    Invoke-Checked "Install Firebase broker dependencies" $Npm @(
      "install", "--omit=dev", "--no-audit", "--no-fund"
    )
    $env:FUNCTIONS_DISCOVERY_TIMEOUT = "60"
    Invoke-Checked "Deploy Firebase runRevexEnergy broker" $Firebase @(
      "deploy", "--only", "functions:revex-energy", "--project", $ProjectId, "--force"
    )
  } finally { Pop-Location }

  $functionJsonText = @(Invoke-Captured "Verify Firebase broker deployment" $script:GCloud @(
    "functions", "describe", "runRevexEnergy", "--gen2", "--project=$ProjectId", "--region=$Region", "--format=json"
  )) -join [Environment]::NewLine
  $functionState = $functionJsonText | ConvertFrom-Json
  if ([string]$functionState.state -ne "ACTIVE" -or -not [string]$functionState.serviceConfig.uri) {
    throw "Firebase broker did not report ACTIVE state and a managed URI."
  }

  Write-Host ""
  Write-Host "REVEX Energy server deployed and verified." -ForegroundColor Green
  Write-Host "Worker: $WorkerUrl"
  Write-Host "Broker: $($functionState.serviceConfig.uri)"
  Write-Host "Cloud Run is private; only the REVEX Energy broker identity can invoke it."
  Write-Host "The workstation is not a production simulation host."
  if (-not $NoPause) {
    try { Read-Host "Deployment verified. Press Enter to close this deployment window" | Out-Null } catch { }
  }
} catch {
  Write-Host ""
  Write-Host "REVEX Energy deployment stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "No local production server was created. Rerunning this script is safe."
  Write-Host "Exact log: $LogPath"
  if (-not $NoPause) {
    try { Read-Host "Press Enter to close this deployment window" | Out-Null } catch { }
  }
  throw
} finally {
  if (Test-Path -LiteralPath $StageRoot) {
    try { Remove-Item -LiteralPath $StageRoot -Recurse -Force } catch { Write-Warning "Temporary staging cleanup failed: $($_.Exception.Message)" }
  }
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch { } }
  Publish-DeploymentLog -Source $TranscriptPath -Destination $LogPath | Out-Null
}
