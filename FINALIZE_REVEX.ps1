param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1"
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
$ExitCode = 1
$TranscriptStarted = $false
$SourceSha = ""
$script:EnergyService = ""

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
    ".github\scripts\verify-revex-r136-project-chat.js",
    ".github\scripts\verify-revex-r137-wallt-fixer-adapters.js",
    ".github\scripts\patch-live-firestore-rules.js",
    "firebase\revex-project-access-r43.rules",
    "firebase\deploy-current-access.ps1",
    "docs\liber-apps\apps\revex\workspace-r51.js",
    "docs\liber-apps\apps\revex\docs-pages-r115.js",
    "docs\liber-apps\apps\revex\chat-convergence-r136.js",
    "docs\liber-apps\apps\revex\wallt-control-plane.js",
    "docs\liber-apps\apps\revex\wallt-cycle-history.js",
    "docs\liber-apps\apps\revex\wallt-fixer-adapters-r137.js",
    "docs\liber-apps\apps\revex\blocks-palette-r126.js",
    "docs\liber-apps\apps\revex\mobile-safe-r133.js",
    "docs\liber-apps\apps\revex\render-agent.js",
    "docs\liber-apps\apps\revex\render-convergence-r126.js",
    "src\Liber.Revex.Revit\Services\FamilyPlacementService.cs",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_energy_contracts.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_final_touchups.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_pipeline_runner.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_final_touchups_r125.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_pipeline_runner_r125.py",
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py",
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn",
    "server\revex-energy-worker\deploy-current.ps1",
    "server\revex-report-functions\deploy-current.ps1",
    $ProjectPath
  )
  foreach($relative in $required){if(-not(Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)){throw "Current REVEX source is incomplete: $relative"}}

  $release=Get-Content -Raw -LiteralPath (Join-Path $Root "REVEX_CURRENT_RELEASE.json")|ConvertFrom-Json
  if([string]$release.authority-ne "canonical-current-files"){throw "REVEX current release manifest has no canonical authority."}
  if([string]$release.current.releaseVerifier-ne ".github/scripts/verify-revex-current-release.py" -or
     [string]$release.current.energyDeployer-ne "server/revex-energy-worker/deploy-current.ps1" -or
     [string]$release.current.reportDeployer-ne "server/revex-report-functions/deploy-current.ps1" -or
     [string]$release.current.accessDeployer-ne "firebase/deploy-current-access.ps1"){
    throw "REVEX current release manifest does not point to canonical current controllers."
  }

  $workspace=Get-Content -Raw -LiteralPath (Join-Path $Root "docs\liber-apps\apps\revex\workspace-r51.js")
  $render=Get-Content -Raw -LiteralPath (Join-Path $Root "docs\liber-apps\apps\revex\render-agent.js")
  $renderConvergence=Get-Content -Raw -LiteralPath (Join-Path $Root "docs\liber-apps\apps\revex\render-convergence-r126.js")
  if($workspace.Contains("render-selfhost-r54.js")){throw "Current workspace still imports the experimental self-hosted Render owner."}
  foreach($marker in @("gemini-3.1-flash-image","generativelanguage.googleapis.com/v1/models/","x-goog-user-project","captureRenderReference","Save to Design Book")){if(-not($render.Contains($marker)-or$workspace.Contains($marker))){throw "Current Google Render path is missing: $marker"}}
  foreach($marker in @("providerOwner:'render-agent.js'","localModelCache:false","legacyIframe:false")){if(-not $renderConvergence.Contains($marker)){throw "Current Render convergence is missing: $marker"}}

  Require-Ok "Current-generation regression guard" $Node @(".github\scripts\verify-revex-current-generation-r53.js") $Root
  Require-Ok "Current WebView/UI root cache guard" $Node @(".github\scripts\verify-revex-r99-webview-root-cache.js") $Root
  Require-Ok "Full UI/Docs/Issues/History/Blocks/Render convergence" $Node @(".github\scripts\verify-revex-r126-functional-convergence.js") $Root
  Require-Ok "Docs Full Set + linked-page behavioral contract" $Node @(".github\scripts\verify-revex-r134-docs-linked-pages.js") $Root
  Require-Ok "Blocks provider-to-Revit placement contract" $Node @(".github\scripts\verify-revex-r135-blocks-placement.js") $Root
  Require-Ok "Project-isolated Secure Chat contract" $Node @(".github\scripts\verify-revex-r136-project-chat.js") $Root
  Require-Ok "Executable WALLT Helper/Fixer adapter contract" $Node @(".github\scripts\verify-revex-r137-wallt-fixer-adapters.js") $Root
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
  Step "Verify canonical Google Render provider"
  if((Invoke-Native $GCloud @("services","enable","generativelanguage.googleapis.com","--project",$ProjectId,"--quiet") -Quiet)-ne 0){throw "Gemini API could not be enabled for $ProjectId."}
  $enabled=Capture-Native $GCloud @("services","list","--enabled","--project",$ProjectId,"--filter","config.name:generativelanguage.googleapis.com","--format","value(config.name)")
  if($enabled.Code-ne 0-or $enabled.Text-notmatch "generativelanguage.googleapis.com"){throw "Gemini API did not remain enabled for $ProjectId."}
  Write-Host "PASS: Google Generative Language API is enabled. Runtime Render OAuth is obtained by render-agent.js with the required user scopes when Render is used." -ForegroundColor Green
}

function Verify-LiveUi([string]$Root) {
  $checks=@(
    @{Rel="ui-integrity.js"; Marker="chat-convergence-r136.js?v=20260818r136-project-chat1"},
    @{Rel="ui-integrity.js"; Marker="wallt-control-plane.js?v=20260818-wallt-control2"},
    @{Rel="ui-integrity.js"; Marker="wallt-fixer-adapters-r137.js?v=20260818r137-fixer-adapters1"},
    @{Rel="docs-pages-r115.js"; Marker="BUILD='20260818r134-docs-fullset-order2'"},
    @{Rel="chat-convergence-r136.js"; Marker="BUILD='20260818r136-project-chat1'"},
    @{Rel="wallt-control-plane.js"; Marker="BUILD = '20260818-wallt-control2'"},
    @{Rel="wallt-cycle-history.js"; Marker="BUILD='20260818-wallt-cycle-history1'"},
    @{Rel="wallt-fixer-adapters-r137.js"; Marker="BUILD='20260818r137-fixer-adapters1'"},
    @{Rel="mobile-safe-r133.js"; Marker="BUILD='20260818r133-mobile-safe1'"},
    @{Rel="workspace-r51.js"; Marker="const BUILD = '20260818-current-workspace1'"},
    @{Rel="render-agent.js"; Marker="const MODEL = 'gemini-3.1-flash-image'"},
    @{Rel="render-convergence-r126.js"; Marker="providerOwner:'render-agent.js'"}
  )
  $deadline=(Get-Date).AddMinutes(10)
  while((Get-Date)-lt $deadline){
    $all=$true
    foreach($check in $checks){
      try{
        $uri="https://liberpict.com/liber-apps/apps/revex/$($check.Rel)?revex_source=$($SourceSha.Substring(0,12))"
        $live=(Invoke-WebRequest -UseBasicParsing -Uri $uri -Headers @{"Cache-Control"="no-cache";"Pragma"="no-cache"}).Content
        if(-not $live.Contains([string]$check.Marker)){$all=$false;break}
      }catch{$all=$false;break}
    }
    if($all){Write-Host "PASS: live Companion current owners (Docs/Chat/WALLT/Mobile/Render) are source-current." -ForegroundColor Green;return}
    Start-Sleep -Seconds 10
  }
  throw "Live REVEX Companion did not expose the exact current Docs/Chat/WALLT/Mobile/Render runtime within 10 minutes."
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
  foreach($marker in @("REVEX_PROJECT_ACCESS_R43_BEGIN","REVEX_PROJECT_ACCESS_R43_END","REVEX_SOURCE_CANDIDATE=$SourceSha","allow read, write: if revexR43ProjectMember(projectId);")){
    if(-not $source.Contains($marker)){throw "Live project access binding is missing: $marker"}
  }
  Write-Host "PASS: Firestore project access is source-bound to $SourceSha." -ForegroundColor Green
}

function Verify-LiveSourceBindings([string]$GCloud) {
  Step "Verify mutable live issuance services are bound to the exact release source"
  $state=Capture-Native $GCloud @("run","services","describe",$script:EnergyService,"--project",$ProjectId,"--region",$Region,"--format","json")
  if($state.Code-ne 0-or-not $state.Text){throw "Live Energy service could not be verified: $($script:EnergyService)"}
  $run=$state.Text|ConvertFrom-Json;$envs=@{};foreach($row in @($run.spec.template.spec.containers[0].env)){$envs[[string]$row.name]=[string]$row.value}
  if([string]$envs["REVEX_SOURCE_CANDIDATE"]-ne $SourceSha){throw "$($script:EnergyService) is not bound to exact source $SourceSha."}
  foreach($functionName in @("runRevexEnergy","documentRevexRevision","finalizeRevexDailyReport")){
    $fnState=Capture-Native $GCloud @("functions","describe",$functionName,"--gen2","--project",$ProjectId,"--region",$Region,"--format","json")
    if($fnState.Code-ne 0-or-not $fnState.Text){throw "Live function could not be verified: $functionName"}
    $fn=$fnState.Text|ConvertFrom-Json
    if([string]$fn.state-ne "ACTIVE"){throw "$functionName is not ACTIVE."}
    if([string]$fn.serviceConfig.environmentVariables.REVEX_SOURCE_CANDIDATE-ne $SourceSha){throw "$functionName is not bound to exact source $SourceSha."}
  }
  Verify-LiveAccessSource $GCloud
  Write-Host "PASS: Access, Energy and Report are source-bound to $SourceSha; Render is the verified live Companion client path." -ForegroundColor Green
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
      energyWorker=$script:EnergyService;renderProvider=$RenderModel;renderRuntime="Companion render-agent.js";missingVt=0.45;actualVtWins=$true;projectAccessSourceBound=$true;
      geometryPolicy="whole-door + curtain-panel + physical-cover corrections";uiPolicy="current owners + WALLT bounded fixer";previousInstalledRevisionShadow=$BackupRoot
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
  Write-Host "Render: verified Google Gemini image path in Companion; experimental Qwen worker is not a release dependency." -ForegroundColor Green
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
  $env:REVEX_FIREBASE_AUTH_VERIFIED="1"
  Verify-GoogleRenderApi $GCloud

  $energyDeploy=Join-Path $SourceRoot "server\revex-energy-worker\deploy-current.ps1"
  $reportDeploy=Join-Path $SourceRoot "server\revex-report-functions\deploy-current.ps1"
  $accessDeploy=Join-Path $SourceRoot "firebase\deploy-current-access.ps1"

  Invoke-ReleaseController "Stage and verify current Energy candidate without broker cutover" $energyDeploy @("-ProjectId",$ProjectId,"-Region",$Region,"-Service",$script:EnergyService,"-SourceCandidate",$SourceSha,"-CandidateOnly","-NoPause")
  Step "Verify current Companion UI and Render runtime are live before access/Energy cutover"
  Verify-LiveUi $SourceRoot
  Invoke-ReleaseController "Deploy preserved source-bound project access rules" $accessDeploy @("-ProjectId",$ProjectId,"-SourceCandidate",$SourceSha,"-NoPause")
  Invoke-ReleaseController "Deploy source-bound Report and Daily Report" $reportDeploy @("-ProjectId",$ProjectId,"-Region",$Region,"-SourceCandidate",$SourceSha,"-NoPause")
  Invoke-ReleaseController "Cut Energy broker to the already-verified current candidate" $energyDeploy @("-ProjectId",$ProjectId,"-Region",$Region,"-Service",$script:EnergyService,"-SourceCandidate",$SourceSha,"-BrokerOnly","-NoPause")

  Verify-LiveSourceBindings $GCloud
  Step "Install the exact same source revision into Revit"
  Install-AddinAtomically

  Write-Host ""
  Write-Host "PASS: REVEX full current release is converged." -ForegroundColor Green
  Write-Host "Source: $SourceSha"
  Write-Host "Companion/WALLT/BIM/Books/Docs/Chat/Issues/History/Blocks: exact current live runtime verified"
  Write-Host "Render: $RenderModel via canonical Companion render-agent.js; Google Generative Language API enabled"
  Write-Host "Energy: $($script:EnergyService) · actual VT preserved · missing VT 0.45 · complete release package required"
  Write-Host "Report/Daily Report + access: source-bound $SourceSha"
  Write-Host "Revit add-in: $(Join-Path $InstalledRoot 'Liber.Revex.Revit.dll')"
  Write-Host "Previous installed add-in preserved as shadow: $BackupRoot"
  Write-Host ""
  Write-Host "Reopen Revit 2026 and run ONE fresh SYNC ENGINEERING. That immutable revision is the acceptance run." -ForegroundColor Yellow
  $ExitCode=0
}catch{
  Write-Host ""
  Write-Host "REVEX finalization stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
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
