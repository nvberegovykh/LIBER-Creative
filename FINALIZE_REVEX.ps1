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
$ExitCode = 1
$TranscriptStarted = $false
$SourceSha = ""

New-Item -ItemType Directory -Path $LogRoot, $WorkRoot -Force | Out-Null

function Step([string]$Message) { Write-Host ">> $Message" -ForegroundColor Cyan }

function Require-Command([string[]]$Names, [string]$Purpose) {
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  throw "$Purpose is required. Missing: $($Names -join ', ')."
}

function Invoke-Native([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "", [switch]$Quiet) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
      if ($Quiet) { & $Command @Arguments *> $null }
      else { & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) } }
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      return [int]$code
    }
    finally { if ($WorkingDirectory) { Pop-Location } }
  }
  catch { Write-Host $_.Exception.Message -ForegroundColor Red; return 1 }
  finally { $ErrorActionPreference = $previous }
}

function Capture-Native([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
      $lines = @(& $Command @Arguments 2>&1 | ForEach-Object { [string]$_ })
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      return [pscustomobject]@{ Code=[int]$code; Text=($lines -join "`n").Trim() }
    }
    finally { if ($WorkingDirectory) { Pop-Location } }
  }
  finally { $ErrorActionPreference = $previous }
}

function Require-Ok([string]$Label, [string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  Step $Label
  $code = Invoke-Native $Command $Arguments $WorkingDirectory
  if ($code -ne 0) { throw "$Label failed with exit code $code." }
}

function Ensure-GCloudAuth([string]$GCloud) {
  $state = Capture-Native $GCloud @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  if ($state.Code -eq 0 -and $state.Text) { return }
  Write-Host "Google Cloud authorization is required once. Opening sign-in..." -ForegroundColor Yellow
  if ((Invoke-Native $GCloud @("auth","login")) -ne 0) { throw "Google Cloud sign-in failed." }
  $state = Capture-Native $GCloud @("auth","list","--filter","status:ACTIVE","--format","value(account)")
  if ($state.Code -ne 0 -or -not $state.Text) { throw "Google Cloud sign-in did not complete." }
}

function Ensure-FirebaseAuth([string]$Firebase) {
  if ((Invoke-Native $Firebase @("projects:list","--json") "" -Quiet) -eq 0) { return }
  Write-Host "Firebase authorization is required once. Opening sign-in..." -ForegroundColor Yellow
  if ((Invoke-Native $Firebase @("login","--reauth")) -ne 0) { throw "Firebase sign-in failed." }
  if ((Invoke-Native $Firebase @("projects:list","--json") "" -Quiet) -ne 0) { throw "Firebase sign-in did not complete." }
}

function Wait-RevitClosed {
  $announced = $false
  while (@(Get-Process -Name Revit -ErrorAction SilentlyContinue).Count -gt 0) {
    if (-not $announced) {
      Write-Host "Revit is still running. Save and close Revit completely; this same controller will continue automatically." -ForegroundColor Yellow
      $announced = $true
    }
    Start-Sleep -Milliseconds 750
  }
}

function Assert-CurrentSource([string]$Root, [string]$Node, [string]$Python) {
  $required = @(
    ".github\scripts\verify-revex-current-generation-r53.js",
    ".github\scripts\verify-revex-r99-webview-root-cache.js",
    ".github\scripts\verify-revex-r126-functional-convergence.js",
    ".github\scripts\verify-revex-r127-single-controller.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_energy_contracts.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_final_touchups_r125.py",
    "src\Liber.Revex.Revit\Engineering\Energy\revex_pipeline_runner_r125.py",
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py",
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn",
    "server\revex-energy-worker\DEPLOY_ENERGY_R127.ps1",
    "server\revex-report-functions\DEPLOY_REPORT_R126.ps1",
    "server\revex-render-worker\DEPLOY_RENDER_R126.ps1",
    $ProjectPath
  )
  foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) { throw "Current REVEX source is incomplete: $relative" }
  }

  Require-Ok "Current-generation regression guard" $Node @(".github\scripts\verify-revex-current-generation-r53.js") $Root
  Require-Ok "Current WebView/UI root cache guard" $Node @(".github\scripts\verify-revex-r99-webview-root-cache.js") $Root
  Require-Ok "Full r126 UI/Docs/Issues/History/Render convergence" $Node @(".github\scripts\verify-revex-r126-functional-convergence.js") $Root
  Require-Ok "r127 typed Energy + fixed VT + geometry + controller guard" $Python @(".github\scripts\verify-revex-r127-single-controller.py") $Root
}

function Build-Addin([string]$Root, [string]$Dotnet) {
  if (-not (Test-Path -LiteralPath (Join-Path $RevitDir "RevitAPI.dll") -PathType Leaf)) { throw "Revit 2026 API was not found at $RevitDir." }
  $project = Join-Path $Root $ProjectPath
  Require-Ok "Restore exact-source Revit add-in" $Dotnet @("restore",$project,"-p:Platform=x64","-p:RevitInstallDir=$RevitDir") $Root
  Require-Ok "Compile exact-source Revit 2026 add-in" $Dotnet @("build",$project,"-c","Release","-p:Platform=x64","-p:RevitInstallDir=$RevitDir","--no-restore") $Root

  $projectDir = Split-Path -Parent $project
  $dll = Get-ChildItem -LiteralPath (Join-Path $projectDir "bin") -Filter "Liber.Revex.Revit.dll" -File -Recurse |
    Where-Object { $_.FullName -match "Release" } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $dll) { throw "Revit build produced no Liber.Revex.Revit.dll." }
  if (Test-Path -LiteralPath $StagePayload) { Remove-Item -LiteralPath $StagePayload -Recurse -Force }
  Copy-Item -LiteralPath $dll.Directory.FullName -Destination $StagePayload -Recurse -Force
  foreach ($relative in @("Liber.Revex.Revit.dll","Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py","Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn")) {
    if (-not (Test-Path -LiteralPath (Join-Path $StagePayload $relative) -PathType Leaf)) { throw "Built add-in payload is incomplete: $relative" }
  }
}

function Verify-LiveUi([string]$Root) {
  $sourceUi = Get-Content -LiteralPath (Join-Path $Root "docs\liber-apps\apps\revex\ui-integrity.js") -Raw
  $match = [regex]::Match($sourceUi, "BUILD='([^']+)'")
  if (-not $match.Success) { throw "Current UI BUILD marker could not be resolved." }
  $build = $match.Groups[1].Value
  $uri = "https://liberpict.com/liber-apps/apps/revex/ui-integrity.js?revex_source=$($SourceSha.Substring(0,12))"
  $deadline = (Get-Date).AddMinutes(6)
  while ((Get-Date) -lt $deadline) {
    try {
      $live = (Invoke-WebRequest -UseBasicParsing -Uri $uri -Headers @{"Cache-Control"="no-cache"}).Content
      if ($live.Contains("BUILD='$build'")) {
        Write-Host "PASS: live Companion UI is current ($build)." -ForegroundColor Green
        return
      }
    } catch { }
    Start-Sleep -Seconds 10
  }
  throw "Live REVEX Companion did not expose the same current UI BUILD within 6 minutes. Local add-in was not installed."
}

function Install-AddinAtomically {
  Wait-RevitClosed
  if (-not (Test-Path -LiteralPath $StagePayload -PathType Container)) { throw "Staged Revit payload disappeared before install." }
  New-Item -ItemType Directory -Path $RevexRoot, (Split-Path -Parent $AddinPath) -Force | Out-Null
  $oldManifest = $AddinPath + ".before-finalize"
  if (Test-Path -LiteralPath $AddinPath) { Copy-Item -LiteralPath $AddinPath -Destination $oldManifest -Force }
  $movedOld = $false
  try {
    if (Test-Path -LiteralPath $InstalledRoot -PathType Container) {
      Move-Item -LiteralPath $InstalledRoot -Destination $BackupRoot
      $movedOld = $true
    }
    Move-Item -LiteralPath $StagePayload -Destination $InstalledRoot
    $assembly = Join-Path $InstalledRoot "Liber.Revex.Revit.dll"
    $marker = [ordered]@{
      schema = "liber.revex.current-release.v1"
      repository = "nvberegovykh/LIBER-Creative"
      sourceCommit = $SourceSha
      finalizedAtUtc = [DateTime]::UtcNow.ToString("o")
      energyWorker = $script:EnergyService
      renderWorker = $script:RenderService
      missingVt = 0.45
      geometryPolicy = "r125 whole-door + curtain-panel + physical-cover corrections"
      uiPolicy = "current r126 convergence"
    } | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $InstalledRoot "REVEX-CURRENT-SOURCE.json"),$marker,[Text.UTF8Encoding]::new($false))
    $manifest = @"
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
  }
  catch {
    if (Test-Path -LiteralPath $InstalledRoot -PathType Container) { Remove-Item -LiteralPath $InstalledRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if ($movedOld -and (Test-Path -LiteralPath $BackupRoot -PathType Container)) { Move-Item -LiteralPath $BackupRoot -Destination $InstalledRoot -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $oldManifest -PathType Leaf) { Copy-Item -LiteralPath $oldManifest -Destination $AddinPath -Force -ErrorAction SilentlyContinue }
    throw
  }
  finally { Remove-Item -LiteralPath $oldManifest -Force -ErrorAction SilentlyContinue }
}

try {
  try { Start-Transcript -LiteralPath $LogPath -Force | Out-Null; $TranscriptStarted = $true } catch { }
  Write-Host "REVEX single-source full finalizer" -ForegroundColor Cyan
  Write-Host "One exact GitHub revision will own Companion UI, Revit add-in, Energy, Report and Render." -ForegroundColor Green
  Write-Host "Missing VT policy: preserve actual VT; otherwise 0.45." -ForegroundColor Green
  Write-Host "Persistent log: $LogPath"

  $Git = Require-Command @("git.exe","git") "Git"
  $Node = Require-Command @("node.exe","node") "Node.js"
  $Python = Require-Command @("python.exe","python") "Python"
  $Dotnet = Require-Command @("dotnet.exe","dotnet") ".NET 8 SDK"
  $GCloud = Require-Command @("gcloud.cmd","gcloud") "Google Cloud CLI"
  $Firebase = Require-Command @("firebase.cmd","firebase") "Firebase CLI"
  $null = Require-Command @("npm.cmd","npm") "npm"

  Step "Clone fresh current GitHub main"
  if ((Invoke-Native $Git @("clone","--depth","1","--branch","main","--single-branch",$Repo,$SourceRoot)) -ne 0) { throw "Fresh current-main clone failed." }
  $sha = Capture-Native $Git @("rev-parse","HEAD") $SourceRoot
  if ($sha.Code -ne 0 -or $sha.Text -notmatch '^[0-9a-fA-F]{40}$') { throw "Exact current source SHA could not be resolved." }
  $SourceSha = $sha.Text.ToLowerInvariant()
  $short = $SourceSha.Substring(0,8)
  $script:EnergyService = "revex-energy-r127-$short"
  $script:RenderService = "revex-render-r127-$short"
  Write-Host "Exact release source: $SourceSha" -ForegroundColor Green

  Assert-CurrentSource $SourceRoot $Node $Python
  Build-Addin $SourceRoot $Dotnet

  Ensure-GCloudAuth $GCloud
  Ensure-FirebaseAuth $Firebase
  $env:REVEX_FIREBASE_AUTH_VERIFIED = "1"

  $energyDeploy = Join-Path $SourceRoot "server\revex-energy-worker\DEPLOY_ENERGY_R127.ps1"
  Step "Deploy proven current Energy worker/broker from the same exact source"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $energyDeploy -ProjectId $ProjectId -Region $Region -Service $script:EnergyService -SourceCandidate $SourceSha -NoPause
  if ($LASTEXITCODE -ne 0) { throw "Energy deployment failed. Existing Energy authority remains; Revit add-in was not installed." }

  $reportDeploy = Join-Path $SourceRoot "server\revex-report-functions\DEPLOY_REPORT_R126.ps1"
  Step "Deploy current post-sync Report/Daily Report"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reportDeploy -ProjectId $ProjectId -Region $Region -NoPause
  if ($LASTEXITCODE -ne 0) { throw "Report deployment failed. Revit add-in was not installed." }

  $renderDeploy = Join-Path $SourceRoot "server\revex-render-worker\DEPLOY_RENDER_R126.ps1"
  Step "Deploy and warm current private Render before broker cutover"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $renderDeploy -ProjectId $ProjectId -Region $Region -Service $script:RenderService -NoPause
  if ($LASTEXITCODE -ne 0) { throw "Render deployment/warm proof failed. Revit add-in was not installed." }

  Step "Verify current Companion UI is live"
  Verify-LiveUi $SourceRoot

  Step "Install the exact same source revision into Revit"
  Install-AddinAtomically

  Write-Host ""
  Write-Host "PASS: REVEX is converged on one exact source revision." -ForegroundColor Green
  Write-Host "Source: $SourceSha"
  Write-Host "Energy: $($script:EnergyService) · actual VT preserved, missing VT = 0.45"
  Write-Host "Render: $($script:RenderService) · warm proof required before cutover"
  Write-Host "Revit add-in: $(Join-Path $InstalledRoot 'Liber.Revex.Revit.dll')"
  Write-Host ""
  Write-Host "Reopen Revit 2026 and run one fresh SYNC ENGINEERING. That new immutable revision is the acceptance run." -ForegroundColor Yellow
  $ExitCode = 0
}
catch {
  Write-Host ""
  Write-Host "REVEX finalization stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Persistent log: $LogPath" -ForegroundColor Yellow
  $ExitCode = 1
}
finally {
  Remove-Item Env:REVEX_FIREBASE_AUTH_VERIFIED -ErrorAction SilentlyContinue
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch { } }
  if (Test-Path -LiteralPath $LogPath) { try { Copy-Item -LiteralPath $LogPath -Destination $LatestLog -Force } catch { } }
  if (Test-Path -LiteralPath $WorkRoot) { try { Remove-Item -LiteralPath $WorkRoot -Recurse -Force } catch { } }
}

exit $ExitCode
