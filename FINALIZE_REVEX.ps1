param(
  [string]$ProjectId = "liber-apps-cca20",
  [ValidateSet("us-central1")][string]$Region = "us-central1",
  [string]$StorageBucket = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Repo = "https://github.com/nvberegovykh/LIBER-Creative.git"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$WorkRoot = Join-Path $env:TEMP ("REVEX-FINALIZE-" + [guid]::NewGuid().ToString("N"))
$SourceRoot = Join-Path $WorkRoot "source"
$StagePayload = Join-Path $WorkRoot "addin-payload"
$RevexRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX"
$InstalledRoot = Join-Path $RevexRoot "App"
$BackupRoot = Join-Path $RevexRoot ("App.before-finalize." + $Stamp)
$LogRoot = Join-Path $RevexRoot "Logs"
$LogPath = Join-Path $LogRoot ("FINALIZE_REVEX." + $Stamp + ".log")
$LatestLog = Join-Path $LogRoot "FINALIZE_REVEX.latest.log"
$AddinPath = Join-Path $env:APPDATA "Autodesk\Revit\Addins\2026\LIBER.REVEX.addin"
$RevitDir = "C:\Program Files\Autodesk\Revit 2026"
$ProjectPath = "src\Liber.Revex.Revit\Liber.Revex.Revit.csproj"
$RenderModel = "gemini-3.1-flash-image"
$BrokerSa = "revex-energy-broker@$ProjectId.iam.gserviceaccount.com"
$WorkerSa = "revex-energy-worker@$ProjectId.iam.gserviceaccount.com"
$ReportSa = "revex-report-worker@$ProjectId.iam.gserviceaccount.com"
$ExitCode = 1
$TranscriptStarted = $false
$SourceSha = ""
$GCloud = ""
$script:EnergyService = ""
$script:RulesReleaseSnapshots = @()

# The production web app is explicitly configured for the modern default bucket.
# Preserve the legacy Storage release by selecting only the bucket REVEX actually uses.
if (-not $StorageBucket -and $ProjectId -eq "liber-apps-cca20") {
  $StorageBucket = "liber-apps-cca20.firebasestorage.app"
}

New-Item -ItemType Directory -Path $LogRoot, $WorkRoot -Force | Out-Null

function Step([string]$Message) { Write-Host ">> $Message" -ForegroundColor Cyan }
function Require-Command([string[]]$Names,[string]$Purpose) {
  foreach($name in $Names){$found=Get-Command $name -ErrorAction SilentlyContinue|Select-Object -First 1;if($found){return $found.Source}}
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}
function Invoke-Native([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory="",[switch]$Quiet) {
  $previous=$ErrorActionPreference
  try{
    $ErrorActionPreference="Continue"
    if($WorkingDirectory){Push-Location $WorkingDirectory}
    try{
      if($Quiet){& $Command @Arguments *> $null}else{& $Command @Arguments 2>&1|ForEach-Object{Write-Host ([string]$_)}}
      $code=$LASTEXITCODE;if($null-eq $code){$code=0};return [int]$code
    }finally{if($WorkingDirectory){Pop-Location}}
  }catch{if(-not $Quiet){Write-Host $_.Exception.Message -ForegroundColor Red};return 1}
  finally{$ErrorActionPreference=$previous}
}
function Capture-Native([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory="") {
  $previous=$ErrorActionPreference
  try{
    $ErrorActionPreference="Continue"
    if($WorkingDirectory){Push-Location $WorkingDirectory}
    try{$lines=@(& $Command @Arguments 2>&1|ForEach-Object{[string]$_});$code=$LASTEXITCODE;if($null-eq $code){$code=0};return [pscustomobject]@{Code=[int]$code;Text=($lines-join "`n").Trim()}}
    finally{if($WorkingDirectory){Pop-Location}}
  }finally{$ErrorActionPreference=$previous}
}
function Require-Ok([string]$Label,[string]$Command,[string[]]$Arguments,[string]$WorkingDirectory="") {
  Step $Label
  $code=Invoke-Native $Command $Arguments $WorkingDirectory
  if($code-ne 0){throw "$Label failed with exit code $code."}
}
function Ensure-GCloudAuth([string]$GCloud) {
  $state=Capture-Native $GCloud @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  if($state.Code-eq 0-and $state.Text){return}
  Write-Host "Google Cloud authorization is required once. Opening sign-in..." -ForegroundColor Yellow
  if((Invoke-Native $GCloud @("auth","login"))-ne 0){throw "Google Cloud sign-in failed."}
  $state=Capture-Native $GCloud @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  if($state.Code-ne 0-or-not $state.Text){throw "Google Cloud sign-in did not complete."}
}
function Ensure-FirebaseAuth([string]$Firebase) {
  if((Invoke-Native $Firebase @("projects:list","--json") -Quiet)-eq 0){return}
  Write-Host "Firebase authorization is required once. Opening sign-in..." -ForegroundColor Yellow
  if((Invoke-Native $Firebase @("login","--reauth"))-ne 0){throw "Firebase sign-in failed."}
  if((Invoke-Native $Firebase @("projects:list","--json") -Quiet)-ne 0){throw "Firebase sign-in did not complete."}
}
function Wait-RevitClosed {
  $announced=$false
  while(@(Get-Process -Name Revit -ErrorAction SilentlyContinue).Count-gt 0){
    if(-not $announced){Write-Host "Revit is still running. Save and close Revit completely; this same controller will continue automatically." -ForegroundColor Yellow;$announced=$true}
    Start-Sleep -Milliseconds 750
  }
}
function Invoke-ReleaseController([string]$Label,[string]$Path,[string[]]$Arguments) {
  if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw "$Label controller is missing: $Path"}
  $argv=@("-NoProfile","-ExecutionPolicy","Bypass","-File",$Path)+$Arguments
  Require-Ok $Label "powershell.exe" $argv
}

function Assert-CurrentSource([string]$Root,[string]$Node,[string]$Python) {
  $required=@(
    "REVEX_CURRENT_RELEASE.json",
    ".github\scripts\verify-revex-current-release.py",
    ".github\scripts\verify-revex-current-generation-r53.js",
    ".github\scripts\verify-revex-r99-webview-root-cache.js",
    ".github\scripts\verify-revex-r126-functional-convergence.js",
    ".github\scripts\verify-revex-r134-docs-linked-pages.js",
	    ".github\scripts\verify-revex-r135-blocks-placement.js",
	    ".github\scripts\verify-revex-external-event-pump.js",
    ".github\scripts\verify-revex-r136-project-chat.js",
    ".github\scripts\verify-revex-r137-wallt-fixer-adapters.js",
    ".github\scripts\verify-revex-r138-wallt-ui.js",
    ".github\scripts\verify-revex-r142-mobile-sheet.js",
    ".github\scripts\verify-revex-r143-ui-recovery.js",
    ".github\scripts\verify-revex-r144-experience.js",
    ".github\scripts\verify-revex-google-render-broker.js",
    ".github\scripts\verify-revex-project-chat-isolation.js",
    ".github\scripts\verify-revex-r49-live-rules.js",
    ".github\scripts\verify-revex-storage-access.js",
    ".github\scripts\verify-revex-storage-live-rules.js",
    ".github\scripts\verify-revex-storage-data-boundary.js",
    ".github\scripts\verify-revex-report-security.js",
    ".github\scripts\verify-revex-firebase-sdk-realm.js",
    ".github\scripts\verify-secure-chat-group-crypto.js",
    ".github\scripts\verify-secure-chat-recovery.js",
    ".github\scripts\verify-revex-security-boundaries.js",
    ".github\scripts\verify-revex-space-recovery.py",
    "server\revex-energy-worker\verify_en1_amendment_r145.py",
    ".github\scripts\patch-live-firestore-rules.js",
    ".github\scripts\patch-live-storage-rules.js",
    "firebase\revex-project-access-r43.rules",
    "firebase\revex-secure-chat-storage.rules",
    "firebase\deploy-current-access.ps1",
    "firebase\deploy-current-storage-access.ps1",
    "docs\liber-apps\apps\revex\workspace-r51.js",
    "docs\liber-apps\index.html",
    "docs\liber-apps\apps\revex\app.js",
    "docs\liber-apps\apps\revex\runtime.js",
    "docs\liber-apps\apps\revex\integrity.js",
    "docs\liber-apps\apps\revex\energy-r27.js",
    "docs\liber-apps\apps\revex\sync-docs-r24.js",
    "docs\liber-apps\apps\revex\history-r24.js",
    "docs\liber-apps\apps\revex\revex-r41-live.js",
    "docs\liber-apps\apps\revex\ui-integrity.js",
    "docs\liber-apps\apps\revex\experience-r144.js",
    "docs\liber-apps\apps\revex\viewer-interaction-r85.js",
    "docs\liber-apps\apps\revex\viewer-interaction-r85-loader.js",
    "docs\liber-apps\apps\revex\review-integrity-r50.js",
    "docs\liber-apps\apps\revex\docs-pages-r115.js",
    "docs\liber-apps\apps\revex\chat-convergence-r136.js",
    "docs\liber-apps\apps\revex\wallt-control-plane.js",
    "docs\liber-apps\apps\revex\wallt-cycle-history.js",
    "docs\liber-apps\apps\revex\wallt-fixer-adapters-r137.js",
    "docs\liber-apps\apps\revex\wallt-ui-r138.js",
    "docs\liber-apps\apps\revex\blocks-palette-r126.js",
    "docs\liber-apps\apps\revex\mobile-safe-r133.js",
    "docs\liber-apps\apps\revex\mobile-sheet-r142.js",
    "docs\liber-apps\apps\secure-chat\chat-crypto.js",
    "docs\liber-apps\apps\secure-chat\chat.js",
    "docs\liber-apps\apps\secure-chat\index.html",
    "docs\liber-apps\apps\secure-chat\styles.css",
    "docs\liber-apps\apps\specifications\index.html",
    "docs\liber-apps\apps\specifications\styles.css",
    "docs\liber-apps\apps\specifications\revex-source-compat-r49.js",
    "docs\liber-apps\js\firebase-service.js",
    "docs\liber-apps\apps\revex\render-agent.js",
    "docs\liber-apps\apps\revex\render-convergence-r126.js",
    "src\Liber.Revex.Revit\Services\FamilyPlacementService.cs",
    "src\Liber.Revex.Revit\Services\FamilyMutationReceiptService.cs",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_energy_contracts.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_final_touchups.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_en1_amendment.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_pipeline_runner.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_final_touchups_r125.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_pipeline_runner_r125.py",
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py",
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn",
    "server\firebase-functions\main.js",
    "server\firebase-functions\project-chat.js",
    "server\firebase-functions\revoke-revex-download-tokens.js",
    "server\revex-energy-worker\deploy-current.ps1",
    "server\revex-energy-worker\revex_geometry_evidence.py",
    "server\revex-energy-worker\verify_revit_energy_geometry_evidence_r128.py",
    "server\revex-report-functions\index.js",
    "server\revex-report-functions\report-security.js",
    "server\revex-report-functions\pdf-text-worker.js",
    "server\revex-report-functions\package.json",
    "server\revex-report-functions\package-lock.json",
    "server\revex-report-functions\deploy-current.ps1",
    $ProjectPath
  )
  foreach($relative in $required){if(-not(Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)){throw "Current REVEX source is incomplete: $relative"}}

  $release=Get-Content -Raw -LiteralPath (Join-Path $Root "REVEX_CURRENT_RELEASE.json")|ConvertFrom-Json
  if([string]$release.authority-ne "canonical-current-files"){throw "REVEX current release manifest has no canonical authority."}
  if([string]$release.current.releaseVerifier-ne ".github/scripts/verify-revex-current-release.py" -or
     [string]$release.current.secureChatRuntime-ne "docs/liber-apps/apps/secure-chat/chat.js" -or
     [string]$release.current.secureChatCryptoRuntime-ne "docs/liber-apps/apps/secure-chat/chat-crypto.js" -or
     [string]$release.current.firebaseServiceRuntime-ne "docs/liber-apps/js/firebase-service.js" -or
     [string]$release.current.projectRuntimeFunctions-ne "server/firebase-functions/main.js" -or
     [string]$release.current.projectRuntimeSecurity-ne "server/firebase-functions/project-chat.js" -or
     [string]$release.current.renderRuntime-ne "docs/liber-apps/apps/revex/render-agent.js" -or
     [string]$release.current.renderBrokerRuntime-ne "server/firebase-functions/index.js" -or
     [string]$release.current.renderBrokerFunction-ne "runRevexGoogleRender" -or
     [string]$release.current.energyDeployer-ne "server/revex-energy-worker/deploy-current.ps1" -or
     [string]$release.current.reportDeployer-ne "server/revex-report-functions/deploy-current.ps1" -or
     [string]$release.current.accessDeployer-ne "firebase/deploy-current-access.ps1" -or
     [string]$release.current.storageAccessDeployer-ne "firebase/deploy-current-storage-access.ps1" -or
     [string]$release.current.legacyDownloadTokenRevoker-ne "server/firebase-functions/revoke-revex-download-tokens.js"){
    throw "REVEX current release manifest does not point to canonical current controllers."
  }

  $workspace=Get-Content -Raw -LiteralPath (Join-Path $Root "docs\liber-apps\apps\revex\workspace-r51.js")
  $render=Get-Content -Raw -LiteralPath (Join-Path $Root "docs\liber-apps\apps\revex\render-agent.js")
  $renderConvergence=Get-Content -Raw -LiteralPath (Join-Path $Root "docs\liber-apps\apps\revex\render-convergence-r126.js")
  $renderBroker=Get-Content -Raw -LiteralPath (Join-Path $Root "server\firebase-functions\index.js")
  if($workspace.Contains("render-selfhost-r54.js")){throw "Current workspace still imports the experimental self-hosted Render owner."}
  foreach($marker in @("gemini-3.1-flash-image","httpsCallable(functions, 'runRevexGoogleRender'","Store.fileBlob(resultPath)","captureRenderReference","Save to Design Book")){if(-not($render.Contains($marker)-or$workspace.Contains($marker))){throw "Current authenticated Google Render client path is missing: $marker"}}
  foreach($forbidden in @("GoogleAuthProvider","reauthenticateWithPopup","linkWithPopup","x-goog-user-project","generativelanguage.googleapis.com")){if($render.Contains($forbidden)){throw "Current Render client still contains a browser OAuth/IAM provider seam: $forbidden"}}
  foreach($marker in @("exports.runRevexGoogleRender = onCall({","serviceAccount: GOOGLE_RENDER_SERVICE_ACCOUNT","assertProjectAccess(projectId, uid, request.auth.token || {})","acceptGoogleRenderJob","transaction.create(refs.lease","new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })")){if(-not $renderBroker.Contains($marker)){throw "Current authenticated Google Render broker is missing: $marker"}}
  foreach($marker in @("providerOwner:'render-agent.js'","localModelCache:false","legacyIframe:false")){if(-not $renderConvergence.Contains($marker)){throw "Current Render convergence is missing: $marker"}}

  Require-Ok "Current-generation regression guard" $Node @(".github\scripts\verify-revex-current-generation-r53.js") $Root
  Require-Ok "Current WebView/UI root cache guard" $Node @(".github\scripts\verify-revex-r99-webview-root-cache.js") $Root
  Require-Ok "Full UI/Docs/Issues/History/Blocks/Render convergence" $Node @(".github\scripts\verify-revex-r126-functional-convergence.js") $Root
  Require-Ok "Docs Full Set + linked-page behavioral contract" $Node @(".github\scripts\verify-revex-r134-docs-linked-pages.js") $Root
	  Require-Ok "Blocks provider-to-Revit placement contract" $Node @(".github\scripts\verify-revex-r135-blocks-placement.js") $Root
	  Require-Ok "Bounded no-lost-wakeup Revit ExternalEvent pump contract" $Node @(".github\scripts\verify-revex-external-event-pump.js") $Root
  Require-Ok "Project-isolated Secure Chat contract" $Node @(".github\scripts\verify-revex-r136-project-chat.js") $Root
  Require-Ok "Executable WALLT Helper/Fixer adapter contract" $Node @(".github\scripts\verify-revex-r137-wallt-fixer-adapters.js") $Root
  Require-Ok "Visible WALLT Helper/Fixer UI contract" $Node @(".github\scripts\verify-revex-r138-wallt-ui.js") $Root
  Require-Ok "Compact BIM/Design mobile sheet contract" $Node @(".github\scripts\verify-revex-r142-mobile-sheet.js") $Root
  Require-Ok "Responsive and accessible UI recovery contract" $Node @(".github\scripts\verify-revex-r143-ui-recovery.js") $Root
  Require-Ok "Premium responsive experience, Measure and section-picking contract" $Node @(".github\scripts\verify-revex-r144-experience.js") $Root
  Require-Ok "Authenticated all-project-member Google Render broker contract" $Node @(".github\scripts\verify-revex-google-render-broker.js") $Root
  Require-Ok "Project Chat membership isolation contract" $Node @(".github\scripts\verify-revex-project-chat-isolation.js") $Root
  Require-Ok "REVEX and Secure Chat Storage access contract" $Node @(".github\scripts\verify-revex-storage-access.js") $Root
  Require-Ok "Authenticated path-only Storage data boundary contract" $Node @(".github\scripts\verify-revex-storage-data-boundary.js") $Root
  Require-Ok "Bounded Report PDF and exact-project object boundary contract" $Node @(".github\scripts\verify-revex-report-security.js") $Root
  Require-Ok "Single-realm Firebase SDK and Auth instance contract" $Node @(".github\scripts\verify-revex-firebase-sdk-realm.js") $Root
  Require-Ok "Secure Chat direct/group encryption contract" $Node @(".github\scripts\verify-secure-chat-group-crypto.js") $Root
  Require-Ok "Secure Chat identity recovery and Firebase realm ownership contract" $Node @(".github\scripts\verify-secure-chat-recovery.js") $Root
  Require-Ok "Browser credential and authenticated proxy boundary contract" $Node @(".github\scripts\verify-revex-security-boundaries.js") $Root
  Require-Ok "Non-destructive Revit Space recovery contract" $Python @(".github\scripts\verify-revex-space-recovery.py") $Root
  Require-Ok "Publication-only Applicant/Modeler Apply-to-EN-1 contract" $Python @("server\revex-energy-worker\verify_en1_amendment_r145.py") $Root
  Require-Ok "Immutable Revit geometry evidence promotion/fallback contract" $Python @("server\revex-energy-worker\verify_revit_energy_geometry_evidence_r128.py") $Root
  Require-Ok "Canonical full current REVEX release contract" $Python @(".github\scripts\verify-revex-current-release.py") $Root
}

function Build-Addin([string]$Root,[string]$Dotnet) {
  if(-not(Test-Path -LiteralPath (Join-Path $RevitDir "RevitAPI.dll") -PathType Leaf)){throw "Revit 2026 API was not found at $RevitDir."}
  $project=Join-Path $Root $ProjectPath
  Require-Ok "Restore exact-source Revit add-in" $Dotnet @("restore",$project,"-p:Platform=x64","-p:RevitInstallDir=$RevitDir") $Root
  Require-Ok "Compile exact-source Revit 2026 add-in" $Dotnet @("build",$project,"-c","Release","-p:Platform=x64","-p:RevitInstallDir=$RevitDir","--no-restore") $Root
  $projectDir=Split-Path -Parent $project
  $dll=Get-ChildItem -LiteralPath (Join-Path $projectDir "bin") -Filter "Liber.Revex.Revit.dll" -File -Recurse|Where-Object{$_.FullName-match "Release"}|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 1
  if(-not $dll){throw "Revit build produced no Liber.Revex.Revit.dll."}
  if(Test-Path -LiteralPath $StagePayload){Remove-Item -LiteralPath $StagePayload -Recurse -Force}
  Copy-Item -LiteralPath $dll.Directory.FullName -Destination $StagePayload -Recurse -Force
  foreach($relative in @("Liber.Revex.Revit.dll","Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py","Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn")){
    if(-not(Test-Path -LiteralPath (Join-Path $StagePayload $relative) -PathType Leaf)){throw "Built add-in payload is incomplete: $relative"}
  }
}

function Verify-GoogleRenderApi([string]$GCloud) {
  Step "Verify canonical server-side Google Render provider prerequisite"
  if((Invoke-Native $GCloud @("services","enable","generativelanguage.googleapis.com","--project",$ProjectId,"--quiet") -Quiet)-ne 0){throw "Gemini API could not be enabled for $ProjectId."}
  $enabled=Capture-Native $GCloud @("services","list","--enabled","--project",$ProjectId,"--filter","config.name:generativelanguage.googleapis.com","--format","value(config.name)")
  if($enabled.Code-ne 0-or $enabled.Text-notmatch "generativelanguage.googleapis.com"){throw "Gemini API did not remain enabled for $ProjectId."}
  Write-Host "PASS: Google Generative Language API is enabled for the controlled REVEX server broker. Browser users receive no Google Cloud IAM, OAuth token or API key." -ForegroundColor Green
}
function Resolve-StorageBucket([string]$GCloud,[string]$RequestedBucket) {
  $rows=Capture-Native $GCloud @("storage","buckets","list","--project",$ProjectId,"--format","value(name)")
  if($rows.Code-ne 0){throw "Could not enumerate Firebase Storage buckets for $ProjectId."}
  $prefix=[Regex]::Escape($ProjectId)
  $names=@($rows.Text-split "`n"|ForEach-Object{$_.Trim().TrimEnd('/')-replace '^gs://',''}|Where-Object{$_}|Select-Object -Unique)
  $matches=@($names|Where-Object{$_ -match "^$prefix\.(?:appspot\.com|firebasestorage\.app)$"})
  if($RequestedBucket){
    $requested=$RequestedBucket.Trim().TrimEnd('/')-replace '^gs://',''
    if($requested -notin $matches){throw "Selected Storage bucket is not a Firebase bucket in $ProjectId: $requested"}
    return [string]$requested
  }
  $modern="$ProjectId.firebasestorage.app"
  if($modern -in $matches){return $modern}
  if($matches.Count-ne 1){throw "Firebase Storage is ambiguous for $ProjectId; pass -StorageBucket. Found: $($matches-join ', ')."}
  return [string]$matches[0]
}
function Rules-Headers([string]$GCloud) {
  $token=Capture-Native $GCloud @("auth","print-access-token")
  if($token.Code-ne 0-or-not $token.Text){throw "Google Cloud could not issue an access token for rules release transaction."}
  return @{Authorization="Bearer $($token.Text.Trim())";"x-goog-user-project"=$ProjectId}
}
function Set-RulesReleasePointer([hashtable]$Headers,[string]$ReleaseName,[string]$RulesetName) {
  $body=@{release=@{name=$ReleaseName;rulesetName=$RulesetName};updateMask="rulesetName"}|ConvertTo-Json -Depth 8
  $null=Invoke-RestMethod -Method Patch -Uri ("https://firebaserules.googleapis.com/v1/"+$ReleaseName) -Headers $Headers -ContentType "application/json" -Body $body -TimeoutSec 30
}
function Capture-RulesReleasePointers([string]$GCloud) {
  $headers=Rules-Headers $GCloud
  $firestoreName="projects/$ProjectId/releases/cloud.firestore"
  $firestore=Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/"+$firestoreName) -Headers $headers -TimeoutSec 30
  $storageName="projects/$ProjectId/releases/firebase.storage/$StorageBucket"
  $storage=Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/"+$storageName) -Headers $headers -TimeoutSec 30
  $snapshots=@(
    [pscustomobject]@{Name=$firestoreName;RulesetName=[string]$firestore.rulesetName},
    [pscustomobject]@{Name=$storageName;RulesetName=[string]$storage.rulesetName}
  )
  foreach($snapshot in $snapshots){if(-not $snapshot.RulesetName.StartsWith("projects/$ProjectId/rulesets/")){throw "Rules release has no deterministic rollback pointer: $($snapshot.Name)"}}
  $script:RulesReleaseSnapshots=$snapshots
}
function Restore-RulesReleasePointers([string]$GCloud) {
  if(-not @($script:RulesReleaseSnapshots).Count){return $true}
  try{
    $headers=Rules-Headers $GCloud
    foreach($snapshot in @($script:RulesReleaseSnapshots)){Set-RulesReleasePointer $headers ([string]$snapshot.Name) ([string]$snapshot.RulesetName)}
    foreach($snapshot in @($script:RulesReleaseSnapshots)){
      $live=Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/"+[string]$snapshot.Name) -Headers $headers -TimeoutSec 30
      if([string]$live.rulesetName -ne [string]$snapshot.RulesetName){throw "Rules rollback verification failed for $($snapshot.Name)."}
    }
    Write-Host "Previous Firestore and Storage release pointers restored." -ForegroundColor Yellow
    return $true
  }catch{
    Write-Host "CRITICAL: automatic rules release rollback failed: $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}

function Verify-LiveUi([string]$Root) {
  $assets=@(
    "index.html",
    "apps/revex/index.html",
    "apps/revex/app.js",
    "apps/revex/runtime.js",
    "apps/revex/integrity.js",
    "apps/revex/energy-r27.js",
    "apps/revex/revex-r41-live.js",
    "apps/revex/ui-integrity.js",
    "apps/revex/experience-r144.js",
    "apps/revex/viewer-interaction-r85.js",
    "apps/revex/viewer-interaction-r85-loader.js",
    "apps/revex/review-integrity-r50.js",
    "apps/revex/docs-pages-r115.js",
    "apps/revex/docs-convergence-r126.js",
    "apps/revex/blocks-palette-r126.js",
    "apps/revex/wallt-ui-r138.js",
    "apps/revex/mobile-sheet-r142.js",
    "apps/revex/render-agent.js",
    "apps/revex/store.js",
    "apps/revex/sync-docs-r24.js",
    "apps/revex/history-r24.js",
    "apps/revex/energy-identity-en1-r89.js",
    "apps/secure-chat/index.html",
    "apps/secure-chat/chat.js",
    "apps/secure-chat/styles.css",
    "apps/specifications/index.html",
    "apps/specifications/styles.css",
    "apps/specifications/revex-source-compat-r49.js",
    "js/firebase-service.js"
  )
  $sha256=[System.Security.Cryptography.SHA256]::Create()
  $client=[System.Net.Http.HttpClient]::new()
  $client.Timeout=[TimeSpan]::FromSeconds(30)
  $client.DefaultRequestHeaders.CacheControl=[System.Net.Http.Headers.CacheControlHeaderValue]::new()
  $client.DefaultRequestHeaders.CacheControl.NoCache=$true
  $client.DefaultRequestHeaders.Pragma.ParseAdd("no-cache")
  $deadline=(Get-Date).AddMinutes(10)
  try {
    while((Get-Date)-lt $deadline){
      $all=$true
      foreach($asset in $assets){
        try{
          $localPath=Join-Path $Root ("docs\liber-apps\"+$asset.Replace("/","\"))
          if(-not(Test-Path -LiteralPath $localPath -PathType Leaf)){throw "Candidate UI asset is missing: $asset"}
          $localBytes=[System.IO.File]::ReadAllBytes($localPath)
          $localHash=-join ($sha256.ComputeHash($localBytes)|ForEach-Object{$_.ToString("x2")})
          $uri="https://liberpict.com/liber-apps/$asset`?revex_source=$($SourceSha.Substring(0,12))"
          $liveBytes=$client.GetByteArrayAsync($uri).GetAwaiter().GetResult()
          $liveHash=-join ($sha256.ComputeHash($liveBytes)|ForEach-Object{$_.ToString("x2")})
          if(-not[string]::Equals($localHash,$liveHash,[StringComparison]::OrdinalIgnoreCase)){$all=$false;break}
        }catch{$all=$false;break}
      }
      if($all){Write-Host "PASS: every changed Companion/Chat/Spec runtime asset is byte-exact to source $SourceSha." -ForegroundColor Green;return}
      Start-Sleep -Seconds 10
    }
  } finally {
    $client.Dispose()
    $sha256.Dispose()
  }
  throw "Live REVEX UI did not become byte-exact to the candidate Companion/Chat/Spec assets within 10 minutes."
}

function Verify-LiveAccessSource([string]$GCloud) {
  Step "Verify live project access rules are bound to the exact release source"
  $token=Capture-Native $GCloud @("auth","print-access-token")
  if($token.Code-ne 0-or-not $token.Text){throw "Google Cloud could not issue an access token for final Firestore rules verification."}
  $headers=@{Authorization="Bearer $($token.Text.Trim())";"x-goog-user-project"=$ProjectId}
  $release=Invoke-RestMethod -Method Get -Uri "https://firebaserules.googleapis.com/v1/projects/$ProjectId/releases/cloud.firestore" -Headers $headers -TimeoutSec 30
  $rulesetName=[string]$release.rulesetName
  if(-not $rulesetName.StartsWith("projects/$ProjectId/rulesets/")){throw "Live Firestore release has no deterministic active ruleset."}
  $ruleset=Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/"+$rulesetName) -Headers $headers -TimeoutSec 30
  $files=@($ruleset.source.files)
  if($files.Count-ne 1){throw "Live Firestore ruleset has $($files.Count) files; expected one preserved source."}
  $source=[string]$files[0].content
  foreach($marker in @("REVEX_PROJECT_ACCESS_R43_BEGIN","REVEX_PROJECT_ACCESS_R43_END","REVEX_SOURCE_CANDIDATE=$SourceSha","request.auth.token.revexAdmin == true","function revexR43ChatProjectBoundary(data)","function revexR43ImmutableProjectLane(projectCollection)","projectCollection == 'revexRenderJobs'","match /revexRenderJobs/{jobId}")){
    if(-not $source.Contains($marker)){throw "Live project access binding is missing: $marker"}
  }
  Write-Host "PASS: Firestore project access is source-bound to $SourceSha." -ForegroundColor Green
}

function Verify-LiveStorageSource([string]$GCloud) {
  Step "Verify live Storage access rules are bound to the exact release source"
  $token=Capture-Native $GCloud @("auth","print-access-token")
  if($token.Code-ne 0-or-not $token.Text){throw "Google Cloud could not issue an access token for final Storage rules verification."}
  $headers=@{Authorization="Bearer $($token.Text.Trim())";"x-goog-user-project"=$ProjectId}
  $all=@();$pageToken=""
  do{
    $uri="https://firebaserules.googleapis.com/v1/projects/$ProjectId/releases?pageSize=100"
    if($pageToken){$uri += "&pageToken=$([uri]::EscapeDataString($pageToken))"}
    $page=Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 30
    $all += @($page.releases)
    $pageToken=if($page.PSObject.Properties.Name-contains 'nextPageToken'){[string]$page.nextPageToken}else{''}
  }while($pageToken)
  $storage=@($all|Where-Object{[string]$_.name-match "/releases/firebase\.storage/"})
  if($StorageBucket){$storage=@($storage|Where-Object{[string]$_.name-eq "projects/$ProjectId/releases/firebase.storage/$StorageBucket"})}
  if($storage.Count-ne 1){throw "Live Storage release is ambiguous. Pass -StorageBucket when the project has multiple buckets."}
  $rulesetName=[string]$storage[0].rulesetName
  if(-not $rulesetName.StartsWith("projects/$ProjectId/rulesets/")){throw "Live Storage release has no deterministic active ruleset."}
  $ruleset=Invoke-RestMethod -Method Get -Uri ("https://firebaserules.googleapis.com/v1/"+$rulesetName) -Headers $headers -TimeoutSec 30
  $files=@($ruleset.source.files)
  if($files.Count-ne 1){throw "Live Storage ruleset has $($files.Count) files; expected one preserved source."}
  $source=[string]$files[0].content
  foreach($marker in @("REVEX_SECURE_STORAGE_ACCESS_BEGIN","REVEX_SECURE_STORAGE_ACCESS_END","REVEX_SOURCE_CANDIDATE=$SourceSha","request.auth.token.revexAdmin == true","function revexStorageChatProjectBoundary(data)","function revexStorageChatParticipant(connId)","function revexStorageImmutableProjectObject(objectName, projectId)")){
    if(-not $source.Contains($marker)){throw "Live Storage access binding is missing: $marker"}
  }
  Write-Host "PASS: Storage access rules are source-bound to $SourceSha." -ForegroundColor Green
}

function Verify-LiveSourceBindings([string]$GCloud) {
  Step "Verify mutable live issuance services are bound to the exact release source"
  $state=Capture-Native $GCloud @("run","services","describe",$script:EnergyService,"--project",$ProjectId,"--region",$Region,"--format","json")
  if($state.Code-ne 0-or-not $state.Text){throw "Live Energy service could not be verified: $($script:EnergyService)"}
  $run=$state.Text|ConvertFrom-Json;$envs=@{};foreach($row in @($run.spec.template.spec.containers[0].env)){$envs[[string]$row.name]=[string]$row.value}
  if([string]$envs["REVEX_SOURCE_CANDIDATE"]-ne $SourceSha){throw "$($script:EnergyService) is not bound to exact source $SourceSha."}
  if([string]$envs["REVEX_STORAGE_BUCKET"]-ne $StorageBucket){throw "$($script:EnergyService) is not bound to Storage bucket $StorageBucket."}
  if([string]$run.spec.template.spec.serviceAccountName-ne $WorkerSa){throw "$($script:EnergyService) is not attached to $WorkerSa."}
  $verifyFunction={
    param([string]$functionName,[string]$functionRegion,[string]$expectedServiceAccount="",[string]$expectedBucket="")
    $fnState=Capture-Native $GCloud @("functions","describe",$functionName,"--gen2","--project",$ProjectId,"--region",$functionRegion,"--format","json")
    if($fnState.Code-ne 0-or-not $fnState.Text){throw "Live function could not be verified: $functionName in $functionRegion"}
    $fn=$fnState.Text|ConvertFrom-Json
    if([string]$fn.state-ne "ACTIVE"){throw "$functionName in $functionRegion is not ACTIVE."}
    if([string]$fn.buildConfig.runtime-ne "nodejs22"){throw "$functionName in $functionRegion is not on nodejs22."}
    if([string]$fn.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE-ne $SourceSha){throw "$functionName in $functionRegion is not bound to exact source $SourceSha."}
    if($expectedServiceAccount-and[string]$fn.serviceConfig.serviceAccountEmail-ne $expectedServiceAccount){throw "$functionName in $functionRegion is not attached to $expectedServiceAccount."}
    if($expectedBucket-and[string]$fn.serviceConfig.environmentVariables.REVEX_STORAGE_BUCKET-ne $expectedBucket){throw "$functionName in $functionRegion is not bound to Storage bucket $expectedBucket."}
  }
  & $verifyFunction "runRevexEnergy" "us-central1" $BrokerSa $StorageBucket
  & $verifyFunction "runRevexGoogleRender" "us-central1" $BrokerSa $StorageBucket
  foreach($functionName in @("documentRevexRevision","finalizeRevexDailyReport")){
    & $verifyFunction $functionName $Region $ReportSa $StorageBucket
  }
  & $verifyFunction "onChatMessageWrite" $Region $ReportSa
  foreach($functionRegion in @($Region,"europe-west1")|Select-Object -Unique){
    foreach($functionName in @("ensureProjectChatHttp","recoverSecureChatIdentityHttp","saveFcmTokenHttp")){
      & $verifyFunction $functionName $functionRegion $ReportSa
    }
  }
  Verify-LiveAccessSource $GCloud
  Verify-LiveStorageSource $GCloud
  Write-Host "PASS: Firestore/Storage access, Project Chat, secure device services, Energy, Report and the authenticated Google Render broker are ACTIVE and source-bound to $SourceSha." -ForegroundColor Green
}

function Install-AddinAtomically {
  Wait-RevitClosed
  if(-not(Test-Path -LiteralPath $StagePayload -PathType Container)){throw "Staged Revit payload disappeared before install."}
  New-Item -ItemType Directory -Path $RevexRoot,(Split-Path -Parent $AddinPath) -Force|Out-Null
  $hadOldApp=Test-Path -LiteralPath $InstalledRoot -PathType Container
  $hadOldManifest=Test-Path -LiteralPath $AddinPath -PathType Leaf
  $transactionManifest=Join-Path $WorkRoot "LIBER.REVEX.addin.before-finalize"
  $shadowManifest=Join-Path $BackupRoot "LIBER.REVEX.addin"
  if($hadOldManifest){Copy-Item -LiteralPath $AddinPath -Destination $transactionManifest -Force}
  try{
    if($hadOldApp){Move-Item -LiteralPath $InstalledRoot -Destination $BackupRoot}else{New-Item -ItemType Directory -Path $BackupRoot -Force|Out-Null}
    Move-Item -LiteralPath $StagePayload -Destination $InstalledRoot
    $assembly=Join-Path $InstalledRoot "Liber.Revex.Revit.dll"
    $marker=[ordered]@{
      schema="liber.revex.current-release.v2";repository="nvberegovykh/LIBER-Creative";sourceCommit=$SourceSha;finalizedAtUtc=[DateTime]::UtcNow.ToString("o");
      energyWorker=$script:EnergyService;renderProvider=$RenderModel;renderRuntime="Companion render-agent.js + authenticated runRevexGoogleRender broker";renderBrokerFunction="runRevexGoogleRender";renderBrokerRegion="us-central1";missingVt=0.45;actualVtWins=$true;projectAccessSourceBound=$true;storageAccessSourceBound=$true;
      geometryPolicy="whole-door + curtain-panel + physical-cover corrections";uiPolicy="current owners + visible WALLT bounded fixer + compact BIM/Design mobile sheet";previousInstalledRevisionShadow=$BackupRoot
    }|ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $InstalledRoot "REVEX-CURRENT-SOURCE.json"),$marker,[Text.UTF8Encoding]::new($false))
    $manifest=@"
<?xml version="1.0" encoding="utf-8" standalone="no"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>LIBER REVEX</Name>
    <Assembly>$assembly</Assembly>
    <AddInId>DECFCABB-63FD-4E1B-9A98-2B646874D487</AddInId>
    <FullClassName>Liber.Revex.Revit.App</FullClassName>
    <VendorId>LIBR</VendorId>
    <VendorDescription>LIBER Creative LLC</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
    [IO.File]::WriteAllText($AddinPath,$manifest,[Text.UTF8Encoding]::new($false))
    if($hadOldManifest-and(Test-Path -LiteralPath $transactionManifest -PathType Leaf)){Copy-Item -LiteralPath $transactionManifest -Destination $shadowManifest -Force}
  }catch{
    if(Test-Path -LiteralPath $InstalledRoot -PathType Container){Remove-Item -LiteralPath $InstalledRoot -Recurse -Force -ErrorAction SilentlyContinue}
    if($hadOldApp-and(Test-Path -LiteralPath $BackupRoot -PathType Container)){Remove-Item -LiteralPath $shadowManifest -Force -ErrorAction SilentlyContinue;Move-Item -LiteralPath $BackupRoot -Destination $InstalledRoot -ErrorAction SilentlyContinue}
    elseif(Test-Path -LiteralPath $BackupRoot -PathType Container){Remove-Item -LiteralPath $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue}
    if($hadOldManifest-and(Test-Path -LiteralPath $transactionManifest -PathType Leaf)){Copy-Item -LiteralPath $transactionManifest -Destination $AddinPath -Force -ErrorAction SilentlyContinue}
    elseif(-not $hadOldManifest){Remove-Item -LiteralPath $AddinPath -Force -ErrorAction SilentlyContinue}
    throw
  }
}

try{
  try{Start-Transcript -LiteralPath $LogPath -Force|Out-Null;$TranscriptStarted=$true}catch{}
  Write-Host "REVEX one-command full current release finalizer" -ForegroundColor Cyan
  Write-Host "Scope: Companion + WALLT Helper/Fixer + BIM + Design Book + Spec Book + Docs + Chat + Issues + History + Blocks + Render + Revit add-in + Energy + Report + access." -ForegroundColor Green
  Write-Host "Render: Firebase-authenticated project-member client plus controlled Google Gemini server broker; experimental Qwen worker is not a release dependency." -ForegroundColor Green
  Write-Host "VT policy: preserve actual VT; when absent use exactly 0.45." -ForegroundColor Green
  Write-Host "Persistent log: $LogPath"

  $Git=Require-Command @("git.exe","git") "Git"
  $Node=Require-Command @("node.exe","node") "Node.js"
  $Python=Require-Command @("python.exe","python") "Python"
  $Dotnet=Require-Command @("dotnet.exe","dotnet") ".NET 8 SDK"
  $GCloud=Require-Command @("gcloud.cmd","gcloud") "Google Cloud CLI"
  $Firebase=Require-Command @("firebase.cmd","firebase") "Firebase CLI"
  $null=Require-Command @("npm.cmd","npm") "npm"

  Step "Clone fresh current GitHub main"
  if((Invoke-Native $Git @("clone","--depth","1","--branch","main","--single-branch",$Repo,$SourceRoot))-ne 0){throw "Fresh current-main clone failed."}
  $sha=Capture-Native $Git @("rev-parse","HEAD") $SourceRoot
  if($sha.Code-ne 0-or $sha.Text-notmatch '^[0-9a-fA-F]{40}$'){throw "Exact current source SHA could not be resolved."}
  $SourceSha=$sha.Text.ToLowerInvariant();$short=$SourceSha.Substring(0,12)
  $script:EnergyService="revex-energy-$short"
  Write-Host "Exact release source: $SourceSha" -ForegroundColor Green

  Assert-CurrentSource $SourceRoot $Node $Python
  Build-Addin $SourceRoot $Dotnet
  Ensure-GCloudAuth $GCloud;Ensure-FirebaseAuth $Firebase
  $StorageBucket=Resolve-StorageBucket $GCloud $StorageBucket
  Capture-RulesReleasePointers $GCloud
  $env:REVEX_FIREBASE_AUTH_VERIFIED="1"
  Verify-GoogleRenderApi $GCloud

  $energyDeploy=Join-Path $SourceRoot "server\revex-energy-worker\deploy-current.ps1"
  $reportDeploy=Join-Path $SourceRoot "server\revex-report-functions\deploy-current.ps1"
  $accessDeploy=Join-Path $SourceRoot "firebase\deploy-current-access.ps1"
  $storageAccessDeploy=Join-Path $SourceRoot "firebase\deploy-current-storage-access.ps1"

  Invoke-ReleaseController "Stage and verify current Energy candidate without broker cutover" $energyDeploy @("-ProjectId",$ProjectId,"-Region",$Region,"-Service",$script:EnergyService,"-StorageBucket",$StorageBucket,"-SourceCandidate",$SourceSha,"-CandidateOnly","-NoPause")
  Step "Verify current Companion UI and Render runtime are live before access/Energy cutover"
  Verify-LiveUi $SourceRoot
  Invoke-ReleaseController "Deploy preserved source-bound project access rules" $accessDeploy @("-ProjectId",$ProjectId,"-SourceCandidate",$SourceSha,"-NoPause")
  $storageArgs=@("-ProjectId",$ProjectId,"-Bucket",$StorageBucket,"-SourceCandidate",$SourceSha,"-NoPause")
  Invoke-ReleaseController "Deploy preserved source-bound Storage access rules" $storageAccessDeploy $storageArgs
  $reportArgs=@("-ProjectId",$ProjectId,"-Region",$Region,"-FallbackRegion","europe-west1","-StorageBucket",$StorageBucket,"-SourceCandidate",$SourceSha,"-NoPause")
  Invoke-ReleaseController "Deploy source-bound Report, Daily Report, Project Chat and secure device services" $reportDeploy $reportArgs
  Invoke-ReleaseController "Cut Energy broker to the already-verified current candidate" $energyDeploy @("-ProjectId",$ProjectId,"-Region",$Region,"-Service",$script:EnergyService,"-StorageBucket",$StorageBucket,"-SourceCandidate",$SourceSha,"-BrokerOnly","-NoPause")

  Verify-LiveSourceBindings $GCloud
  Step "Install the exact same source revision into Revit"
  Install-AddinAtomically

  Write-Host ""
  Write-Host "PASS: REVEX full current release is converged." -ForegroundColor Green
  Write-Host "Source: $SourceSha"
  Write-Host "Companion/WALLT/BIM/Books/Docs/Chat/Issues/History/Blocks: exact current live runtime verified"
  Write-Host "Render: $RenderModel via Firebase-authenticated project client and source-bound runRevexGoogleRender server broker; no browser Google Cloud credentials"
  Write-Host "Energy: $($script:EnergyService) · actual VT preserved · missing VT 0.45 · complete release package required"
  Write-Host "Project Chat + secure device services + Report/Daily Report + Firestore/Storage access: source-bound $SourceSha"
  Write-Host "Revit add-in: $(Join-Path $InstalledRoot 'Liber.Revex.Revit.dll')"
  Write-Host "Previous installed add-in preserved as shadow: $BackupRoot"
  Write-Host ""
  Write-Host "Reopen Revit 2026 and run ONE fresh SYNC PROJECT. That one action publishes the source revision, then its aligned immutable Engineering revision for the acceptance run." -ForegroundColor Yellow
  $ExitCode=0
}catch{
  Write-Host ""
  $rulesRestored=if($GCloud){Restore-RulesReleasePointers $GCloud}else{$true}
  Write-Host "REVEX finalization stopped before complete convergence." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  if(-not $rulesRestored){Write-Host "Do not continue: verify the active Firestore and Storage release pointers before retrying." -ForegroundColor Red}
  Write-Host "Do not run any legacy/recovery controller. Rerun this same FINALIZE_REVEX command only after the reported dependency is corrected." -ForegroundColor Yellow
  Write-Host "Persistent log: $LogPath" -ForegroundColor Yellow
  $ExitCode=1
}finally{
  Remove-Item Env:REVEX_FIREBASE_AUTH_VERIFIED -ErrorAction SilentlyContinue
  if($TranscriptStarted){try{Stop-Transcript|Out-Null}catch{}}
  if(Test-Path -LiteralPath $LogPath){try{Copy-Item -LiteralPath $LogPath -Destination $LatestLog -Force}catch{}}
  if(Test-Path -LiteralPath $WorkRoot){try{Remove-Item -LiteralPath $WorkRoot -Recurse -Force}catch{}}
}
exit $ExitCode
