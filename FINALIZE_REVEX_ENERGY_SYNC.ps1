param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Repo = "https://github.com/nvberegovykh/LIBER-Creative.git"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Work = Join-Path $env:TEMP ("REVEX-FINAL-ENERGY-SYNC-" + $Stamp + "-" + [guid]::NewGuid().ToString("N"))
$Source = Join-Path $Work "source"
$Payload = Join-Path $Work "payload"
$RevexRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX"
$InstalledRoot = Join-Path $RevexRoot "App"
$BackupRoot = Join-Path $RevexRoot ("App.before-final-energy-sync." + $Stamp)
$LogRoot = Join-Path $RevexRoot "Logs"
$LogPath = Join-Path $LogRoot ("FINALIZE_REVEX_ENERGY_SYNC." + $Stamp + ".log")
$LatestLog = Join-Path $LogRoot "FINALIZE_REVEX_ENERGY_SYNC.latest.log"
$AddinPath = Join-Path $env:APPDATA "Autodesk\Revit\Addins\2026\LIBER.REVEX.addin"
$ManifestBackup = Join-Path $Work "LIBER.REVEX.addin.before-final-energy-sync"
$RevitDir = "C:\Program Files\Autodesk\Revit 2026"
$ProjectPath = "src\Liber.Revex.Revit\Liber.Revex.Revit.csproj"
$TranscriptStarted = $false
$ExitCode = 1
$SourceSha = ""
$PreviousPayloadMoved = $false
$PayloadInstalled = $false
$HadManifest = $false

New-Item -ItemType Directory -Force -Path $Work,$LogRoot | Out-Null

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required." }
  return $cmd.Source
}

function Invoke-Native([string]$Label,[string]$Command,[string[]]$Arguments,[string]$WorkingDirectory="") {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
      & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      if ([int]$code -ne 0) { throw "$Label failed with exit code $code." }
    } finally { if ($WorkingDirectory) { Pop-Location } }
  } finally { $ErrorActionPreference = $previous }
}

function Capture-Native([string]$Command,[string[]]$Arguments,[string]$WorkingDirectory="") {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
      $lines = @(& $Command @Arguments 2>$null | ForEach-Object { [string]$_ })
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      if ([int]$code -ne 0) { throw "Command failed with exit code $code: $Command $($Arguments -join ' ')" }
      return ($lines -join "`n").Trim()
    } finally { if ($WorkingDirectory) { Pop-Location } }
  } finally { $ErrorActionPreference = $previous }
}

function Wait-RevitClosed {
  $announced = $false
  while (@(Get-Process -Name Revit -ErrorAction SilentlyContinue).Count -gt 0) {
    if (-not $announced) {
      Write-Host ""
      Write-Host "Energy is deployed and the exact add-in is built." -ForegroundColor Green
      Write-Host "Save and close Revit now. This SAME controller will continue automatically; do not rerun anything." -ForegroundColor Yellow
      $announced = $true
    }
    Start-Sleep -Milliseconds 750
  }
}

function Assert-SourceContract([string]$Root,[string]$Node,[string]$Python) {
  $critical = @(
    "src\Liber.Revex.Revit\Engineering\Energy\revex_final_touchups_r125.py",
    "src\Liber.Revex.Revit\Engineering\Energy\verify_revex_r125_touchups.py",
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py",
    "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn",
    "server\revex-energy-worker\revex_energy_pipeline_guard_r118.py",
    "server\revex-energy-worker\DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1",
    "server\revex-energy-worker\DEPLOY_ENERGY_CURRENT.ps1",
    ".github\scripts\verify-revex-current-generation-r53.js",
    $ProjectPath
  )
  foreach ($relative in $critical) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) { throw "Final source contract missing $relative" }
  }
  $touch = Get-Content -Raw -LiteralPath (Join-Path $Root "src\Liber.Revex.Revit\Engineering\Energy\revex_final_touchups_r125.py")
  foreach ($marker in @('FIXED_MISSING_VT = 0.45','FIXED_MISSING_VT_0_45','COMCHECK_VT_R125')) {
    if (-not $touch.Contains($marker)) { throw "Fixed VT=0.45 contract missing: $marker" }
  }
  $gbxml = Get-Content -Raw -LiteralPath (Join-Path $Root "src\Liber.Revex.Revit\Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py")
  foreach ($marker in @('REVEX_R125_GEOMETRY_TOUCHUPS_BEGIN','bbox-whole-door-r125','CURTAIN_PANEL_GEOMETRY_HOST_PROOF_R125','TOP_COVER_SEARCH_MAX_FT = float("inf")')) {
    if (-not $gbxml.Contains($marker)) { throw "r125 geometry correction missing: $marker" }
  }
  Invoke-Native "Current-generation regression guard" $Node @(".github\scripts\verify-revex-current-generation-r53.js") $Root
  Invoke-Native "Targeted r125 Energy/VT verification" $Python @("src\Liber.Revex.Revit\Engineering\Energy\verify_revex_r125_touchups.py") $Root
}

function Stage-Addin([string]$Root,[string]$Dotnet) {
  $project = Join-Path $Root $ProjectPath
  Invoke-Native "Restore exact Revit add-in" $Dotnet @("restore",$project,"-p:Platform=x64","-p:RevitInstallDir=$RevitDir") $Root
  Invoke-Native "Build exact Revit 2026 add-in" $Dotnet @("build",$project,"-c","Release","-p:Platform=x64","-p:RevitInstallDir=$RevitDir","--no-restore") $Root
  $projectDir = Split-Path -Parent $project
  $dll = Get-ChildItem -LiteralPath (Join-Path $projectDir "bin") -Filter "Liber.Revex.Revit.dll" -File -Recurse |
    Where-Object { $_.FullName -match "Release" } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $dll) { throw "Release build produced no REVEX DLL." }
  Copy-Item -LiteralPath $dll.Directory.FullName -Destination $Payload -Recurse -Force
  foreach ($relative in @("Liber.Revex.Revit.dll","Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py","Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn")) {
    if (-not (Test-Path -LiteralPath (Join-Path $Payload $relative) -PathType Leaf)) { throw "Staged add-in missing $relative" }
  }
  $marker = [ordered]@{
    schema="liber.revex.final-energy-sync.v1"; source=$SourceSha; fixedMissingVt=0.45;
    geometry="r125-whole-door+curtain-panel+physical-cover"; energyWorkerSameSource=$true
  } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $Payload "REVEX-FINAL-ENERGY-SYNC.json"),$marker,[Text.UTF8Encoding]::new($false))
}

function Write-Manifest([string]$AssemblyPath) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AddinPath) | Out-Null
  $manifest = @"
<?xml version="1.0" encoding="utf-8" standalone="no"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>LIBER REVEX</Name>
    <Assembly>$AssemblyPath</Assembly>
    <AddInId>DECFCABB-63FD-4E1B-9A98-2B646874D487</AddInId>
    <FullClassName>Liber.Revex.Revit.App</FullClassName>
    <VendorId>LIBR</VendorId>
    <VendorDescription>LIBER Creative LLC</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
  [IO.File]::WriteAllText($AddinPath,$manifest,[Text.UTF8Encoding]::new($false))
}

function Install-AddinAtomically {
  if (@(Get-Process -Name Revit -ErrorAction SilentlyContinue).Count -gt 0) { throw "Revit reopened before install; no installed file was changed." }
  $script:HadManifest = Test-Path -LiteralPath $AddinPath -PathType Leaf
  if ($script:HadManifest) { Copy-Item -LiteralPath $AddinPath -Destination $ManifestBackup -Force }
  try {
    if (Test-Path -LiteralPath $InstalledRoot -PathType Container) {
      Move-Item -LiteralPath $InstalledRoot -Destination $BackupRoot
      $script:PreviousPayloadMoved = $true
    }
    Move-Item -LiteralPath $Payload -Destination $InstalledRoot
    $script:PayloadInstalled = $true
    Write-Manifest (Join-Path $InstalledRoot "Liber.Revex.Revit.dll")
  } catch {
    try { if ($script:PayloadInstalled -and (Test-Path $InstalledRoot)) { Remove-Item $InstalledRoot -Recurse -Force } } catch {}
    try { if ($script:PreviousPayloadMoved -and (Test-Path $BackupRoot)) { Move-Item $BackupRoot $InstalledRoot } } catch {}
    try {
      if ($script:HadManifest -and (Test-Path $ManifestBackup)) { Copy-Item $ManifestBackup $AddinPath -Force }
      elseif (-not $script:HadManifest -and (Test-Path $AddinPath)) { Remove-Item $AddinPath -Force }
    } catch {}
    throw
  }
}

try {
  try { Start-Transcript -LiteralPath $LogPath -Force | Out-Null; $TranscriptStarted=$true } catch {}
  Write-Host "REVEX FINAL ENERGY + SYNC controller" -ForegroundColor Cyan
  Write-Host "One source -> one Energy worker/broker -> one Revit add-in." -ForegroundColor Green
  Write-Host "Missing VT is fixed at 0.45. r125 geometry corrections are required and preserved." -ForegroundColor Green
  Write-Host "No Report/Render deployment. Existing immutable Engineering revisions are not rewritten." -ForegroundColor Green
  Write-Host "Log: $LogPath"

  $Git=Require-Command "git"; $Dotnet=Require-Command "dotnet"; $Node=Require-Command "node"; $Python=Require-Command "python"; $null=Require-Command "gcloud"; $null=Require-Command "firebase"; $null=Require-Command "npm"
  if (-not (Test-Path -LiteralPath (Join-Path $RevitDir "RevitAPI.dll"))) { throw "Revit 2026 API not found at $RevitDir" }

  Invoke-Native "Clone exact current main" $Git @("clone","--depth","1","--branch","main","--single-branch",$Repo,$Source)
  $SourceSha=Capture-Native $Git @("rev-parse","HEAD") $Source
  if ($SourceSha -notmatch '^[0-9a-fA-F]{40}$') { throw "Could not resolve exact source SHA." }
  Write-Host "Exact source: $SourceSha" -ForegroundColor Green

  Assert-SourceContract $Source $Node $Python
  Stage-Addin $Source $Dotnet

  $deploy=Join-Path $Source "server\revex-energy-worker\DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1"
  Invoke-Native "Deploy Energy worker + authenticated broker from SAME exact source" "powershell.exe" @("-NoProfile","-ExecutionPolicy","Bypass","-File",$deploy,"-ProjectId",$ProjectId,"-Region",$Region,"-SourceCandidate",$SourceSha,"-NoPause") $Source

  Wait-RevitClosed
  Write-Host ">> Atomically install SAME exact source into Revit" -ForegroundColor DarkCyan
  Install-AddinAtomically

  Write-Host ""
  Write-Host "PASS: REVEX Energy + corrected Sync path are aligned on $SourceSha" -ForegroundColor Green
  Write-Host "VT fallback: fixed 0.45" -ForegroundColor Green
  Write-Host "Geometry: whole doors + curtain panels + physical upper covers/levels" -ForegroundColor Green
  Write-Host "Next: reopen Revit, open the real model, click SYNC ENGINEERING once, then let the automatic Energy run finish." -ForegroundColor Yellow
  $ExitCode=0
} catch {
  Write-Host ""
  Write-Host "REVEX FINAL ENERGY + SYNC stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  if (-not $PayloadInstalled) { Write-Host "Installed Revit payload was not replaced by the failed install stage." -ForegroundColor Yellow }
  Write-Host "Rerunning this same controller is the only recovery action." -ForegroundColor Yellow
  $ExitCode=1
} finally {
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
  try { if (Test-Path $LogPath) { Copy-Item $LogPath $LatestLog -Force } } catch {}
  try { if (Test-Path $Work) { Remove-Item $Work -Recurse -Force } } catch {}
}
exit $ExitCode
