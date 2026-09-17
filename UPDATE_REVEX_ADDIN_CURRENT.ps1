param(
  [string]$Repository = "nvberegovykh/LIBER-Creative"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$RevexRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX"
$InstalledRoot = Join-Path $RevexRoot "App"
$BackupRoot = Join-Path $RevexRoot ("App.before-current." + $Stamp)
$WorkRoot = Join-Path $env:LOCALAPPDATA ("LIBER\REVEX-Current-Update\" + $Stamp + "-" + [guid]::NewGuid().ToString("N"))
$RepoRoot = Join-Path $WorkRoot "LIBER-Creative"
$StagePayload = Join-Path $WorkRoot "payload"
$LogRoot = Join-Path $RevexRoot "Logs"
$LogPath = Join-Path $LogRoot ("UPDATE_REVEX_ADDIN_CURRENT." + $Stamp + ".log")
$LatestLogPath = Join-Path $LogRoot "UPDATE_REVEX_ADDIN_CURRENT.latest.log"
$AddinPath = Join-Path $env:APPDATA "Autodesk\Revit\Addins\2026\LIBER.REVEX.addin"
$ManifestBackup = Join-Path $WorkRoot "LIBER.REVEX.addin.before-update"
$RevitDir = "C:\Program Files\Autodesk\Revit 2026"
$ProjectPath = "src\Liber.Revex.Revit\Liber.Revex.Revit.csproj"
$ExitCode = 1
$TranscriptStarted = $false
$PayloadInstalled = $false
$PreviousPayloadMoved = $false
$HadManifest = $false
$SourceSha = ""

New-Item -ItemType Directory -Path $LogRoot, $WorkRoot -Force | Out-Null

function Write-Step([string]$Message) {
  Write-Host ">> $Message" -ForegroundColor Cyan
}

function Require-Command([string[]]$Names, [string]$Purpose) {
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  throw "$Purpose is required for the current REVEX add-in update. Missing: $($Names -join ', ')."
}

function Invoke-NativeExitCode([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
      & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      return [int]$code
    } finally {
      if ($WorkingDirectory) { Pop-Location }
    }
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    return 1
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Invoke-Checked([string]$Step, [string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  Write-Step $Step
  $code = Invoke-NativeExitCode $Command $Arguments $WorkingDirectory
  if ($code -ne 0) { throw "$Step failed with exit code $code." }
}

function Invoke-Captured([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
      $lines = @(& $Command @Arguments 2>&1 | ForEach-Object { [string]$_ })
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 0 }
      if ([int]$code -ne 0) { throw "Command failed with exit code ${code}: $Command $($Arguments -join ' ')" }
      return ($lines -join [Environment]::NewLine).Trim()
    } finally {
      if ($WorkingDirectory) { Pop-Location }
    }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Get-RevitProcessSnapshot {
  $running = @(Get-Process -Name "Revit" -ErrorAction SilentlyContinue)
  $interactive = @()
  foreach ($process in $running) {
    $hasWindow = $false
    try {
      $hasWindow = ($process.MainWindowHandle -ne [IntPtr]::Zero) -or
                   (-not [string]::IsNullOrWhiteSpace([string]$process.MainWindowTitle))
    } catch { }
    if ($hasWindow) { $interactive += $process }
  }
  return [pscustomobject]@{ Running=$running; Interactive=$interactive }
}

function Test-RevexPayloadUnlocked {
  $assembly = Join-Path $InstalledRoot "Liber.Revex.Revit.dll"
  if (-not (Test-Path -LiteralPath $assembly -PathType Leaf)) { return $true }

  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $assembly,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None)
    return $true
  }
  catch [System.IO.IOException] { return $false }
  catch [System.UnauthorizedAccessException] { return $false }
  finally {
    if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
  }
}

function Wait-RevitClosed([int]$PollMilliseconds = 750) {
  $announced = $false
  $headlessSafeSince = $null
  $headlessSafeSeconds = 4.0

  while ($true) {
    $snapshot = Get-RevitProcessSnapshot
    $running = @($snapshot.Running)
    $interactive = @($snapshot.Interactive)

    if ($running.Count -eq 0) {
      if ($announced) {
        Write-Host "Revit is closed. Continuing this same update automatically." -ForegroundColor Green
      }
      return
    }

    $payloadUnlocked = Test-RevexPayloadUnlocked
    if ($interactive.Count -eq 0 -and $payloadUnlocked) {
      if ($null -eq $headlessSafeSince) {
        $headlessSafeSince = Get-Date
        $ids = ($running | ForEach-Object { $_.Id }) -join ", "
        Write-Host "Detected only headless Revit process(es) (PID $ids), but the installed REVEX DLL is not loaded or locked. Verifying the safe state briefly..." -ForegroundColor DarkYellow
      }
      if (((Get-Date) - $headlessSafeSince).TotalSeconds -ge $headlessSafeSeconds) {
        $ids = ($running | ForEach-Object { $_.Id }) -join ", "
        Write-Host "PASS: no interactive Revit window and the installed REVEX payload is unlocked. Ignoring stale/headless Revit PID(s) $ids and continuing." -ForegroundColor Green
        return
      }
    }
    else {
      $headlessSafeSince = $null
      if (-not $announced) {
        $ids = ($running | ForEach-Object { $_.Id }) -join ", "
        if ($interactive.Count -gt 0) {
          Write-Host "Revit 2026 has an interactive window open (PID $ids)." -ForegroundColor Yellow
        } else {
          Write-Host "A headless Revit process is still holding the installed REVEX DLL (PID $ids)." -ForegroundColor Yellow
        }
        Write-Host "Save and close Revit completely. This updater will wait here and continue automatically; do not rerun it." -ForegroundColor Yellow
        $announced = $true
      }
    }

    Start-Sleep -Milliseconds $PollMilliseconds
  }
}

function Assert-RevitClosed {
  $snapshot = Get-RevitProcessSnapshot
  $running = @($snapshot.Running)
  if ($running.Count -eq 0) { return }

  $interactive = @($snapshot.Interactive)
  if ($interactive.Count -gt 0) {
    throw "Revit restarted before the atomic install. Close Revit and run the updater again; no installed REVEX files were changed by this install step."
  }
  if (-not (Test-RevexPayloadUnlocked)) {
    throw "A headless Revit process still has the installed REVEX DLL locked. Wait for that process to release the add-in, then run the updater again; no installed REVEX files were changed."
  }

  $ids = ($running | ForEach-Object { $_.Id }) -join ", "
  Write-Host "PASS: atomic install safety check found only headless Revit PID(s) $ids and the REVEX DLL is unlocked." -ForegroundColor Green
}

function Assert-SourceContract([string]$Root) {
  $required = @(
    ".github\scripts\verify-revex-current-generation-r53.js",
    ".github\scripts\verify-revex-r99-webview-root-cache.js",
    ".github\scripts\verify-revex-r126-functional-convergence.js",
    "docs\liber-apps\apps\revex\ui-integrity.js",
    "docs\liber-apps\apps\revex\docs-convergence-r126.js",
    "docs\liber-apps\apps\revex\appearance-convergence-r126.js",
    "docs\liber-apps\apps\revex\issues-convergence-r126.js",
    "docs\liber-apps\apps\revex\issues-inspector-r126.js",
    "docs\liber-apps\apps\revex\history-daily-r126.js",
    "docs\liber-apps\apps\revex\blocks-palette-r126.js",
    "docs\liber-apps\apps\revex\render-convergence-r126.js",
    "src\Liber.Revex.Revit\Revit\RevexFamilyPlacementExternalHandler.cs",
    "src\Liber.Revex.Revit\Services\AffectedPlanExportService.cs",
    "src\Liber.Revex.Revit\Services\FamilyPlacementService.cs",
    "src\Liber.Revex.Revit\Services\EngineeringCompanionWebBridge.cs",
    "src\Liber.Revex.Revit\Services\EngineeringScheduleEvidenceService.cs",
    "src\Liber.Revex.Revit\Services\EngineeringSyncService.cs",
    "src\Liber.Revex.Revit\Services\RevexSpaceFailureShield.cs",
    "src\Liber.Revex.Revit\Revit\RevitRequestHandler.cs",
    $ProjectPath
  )
  foreach ($relative in $required) {
    $path = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Current-main r126 source contract is incomplete: missing $relative."
    }
  }

  $handler = Get-Content -LiteralPath (Join-Path $Root "src\Liber.Revex.Revit\Revit\RevitRequestHandler.cs") -Raw
  $scheduleService = Get-Content -LiteralPath (Join-Path $Root "src\Liber.Revex.Revit\Services\EngineeringScheduleEvidenceService.cs") -Raw
  $webBridge = Get-Content -LiteralPath (Join-Path $Root "src\Liber.Revex.Revit\UI\RevexWebIntegrationBridge.cs") -Raw
  $app = Get-Content -LiteralPath (Join-Path $Root "src\Liber.Revex.Revit\App.cs") -Raw
  if (-not $handler.Contains('new EngineeringScheduleEvidenceService().Export')) {
    throw "Current add-in source does not wire native Revit schedules into Engineering Sync."
  }
  if (-not $scheduleService.Contains('REVIT-SCHEDULE-EVIDENCE.json') -or -not $scheduleService.Contains('ScheduleSheetInstance')) {
    throw "Current add-in source does not preserve structured native Revit schedule evidence and sheet placement."
  }
  if (-not $webBridge.Contains('RevexFamilyPlacementExternalHandler')) {
    throw "Current add-in source does not include the r126 Blocks family-placement ExternalEvent bridge."
  }
  if (-not $app.Contains('RevexSpaceFailureShield.OnFailuresProcessing')) {
    throw "Current add-in source lost the REVEX zero-height Space failure shield subscription."
  }
}

function Copy-BuildPayload([string]$Root) {
  $projectFullPath = Join-Path $Root $ProjectPath
  $projectDir = Split-Path -Parent $projectFullPath
  $dll = Get-ChildItem -LiteralPath (Join-Path $projectDir "bin") -Filter "Liber.Revex.Revit.dll" -File -Recurse -ErrorAction Stop |
    Where-Object { $_.FullName -match "Release" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (-not $dll) { throw "Release build produced no Liber.Revex.Revit.dll." }

  $outputDir = $dll.Directory.FullName
  if (Test-Path -LiteralPath $StagePayload) { Remove-Item -LiteralPath $StagePayload -Recurse -Force }
  Copy-Item -LiteralPath $outputDir -Destination $StagePayload -Recurse -Force

  foreach ($relative in @(
    "Liber.Revex.Revit.dll",
    "Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py",
    "Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $StagePayload $relative) -PathType Leaf)) {
      throw "Built add-in payload is incomplete: missing $relative."
    }
  }

  $marker = [ordered]@{
    schema = "liber.revex.current-addin-source.v2"
    source = "github-main"
    repository = $Repository
    commit = $SourceSha
    builtAtUtc = [DateTime]::UtcNow.ToString("o")
    updater = "UPDATE_REVEX_ADDIN_CURRENT.ps1"
    currentGenerationValidated = $true
    currentUiRootCacheValidated = $true
    r126FunctionalConvergenceValidated = $true
    staleR49CanonicalSourceUsed = $false
    cloudServicesChanged = $false
  } | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Join-Path $StagePayload "REVEX-CURRENT-SOURCE.json"), $marker, [Text.UTF8Encoding]::new($false))
}

function Write-Manifest([string]$AssemblyPath) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $AddinPath) -Force | Out-Null
  $temp = $AddinPath + ".current.tmp"
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
  [IO.File]::WriteAllText($temp, $manifest, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $AddinPath -Force
}

function Install-Atomically {
  Assert-RevitClosed
  $script:HadManifest = Test-Path -LiteralPath $AddinPath -PathType Leaf
  if ($script:HadManifest) { Copy-Item -LiteralPath $AddinPath -Destination $ManifestBackup -Force }

  try {
    if (Test-Path -LiteralPath $InstalledRoot -PathType Container) {
      Move-Item -LiteralPath $InstalledRoot -Destination $BackupRoot
      $script:PreviousPayloadMoved = $true
    }

    Move-Item -LiteralPath $StagePayload -Destination $InstalledRoot
    $script:PayloadInstalled = $true
    $assembly = Join-Path $InstalledRoot "Liber.Revex.Revit.dll"
    if (-not (Test-Path -LiteralPath $assembly -PathType Leaf)) { throw "Installed payload lost its assembly during atomic move." }
    Write-Manifest $assembly
  }
  catch {
    Write-Host "Atomic install failed; restoring the prior add-in payload." -ForegroundColor Yellow
    try {
      if ($script:PayloadInstalled -and (Test-Path -LiteralPath $InstalledRoot -PathType Container)) {
        Remove-Item -LiteralPath $InstalledRoot -Recurse -Force
      }
    } catch { }
    try {
      if ($script:PreviousPayloadMoved -and (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
        Move-Item -LiteralPath $BackupRoot -Destination $InstalledRoot
      }
    } catch { }
    try {
      if ($script:HadManifest -and (Test-Path -LiteralPath $ManifestBackup -PathType Leaf)) {
        Copy-Item -LiteralPath $ManifestBackup -Destination $AddinPath -Force
      } elseif (-not $script:HadManifest -and (Test-Path -LiteralPath $AddinPath -PathType Leaf)) {
        Remove-Item -LiteralPath $AddinPath -Force
      }
    } catch { }
    throw
  }
}

try {
  try {
    Start-Transcript -LiteralPath $LogPath -Force | Out-Null
    $TranscriptStarted = $true
  } catch { }

  Write-Host "REVEX current-main r126 add-in updater" -ForegroundColor Cyan
  Write-Host "Only the local Revit add-in is changed. No Firebase, Cloud Run, Render, Energy worker/broker, or stale publisher is invoked."
  Write-Host "Persistent log: $LogPath"

  Write-Step "Wait until Revit is safe for local add-in replacement"
  Wait-RevitClosed

  if (-not (Test-Path -LiteralPath (Join-Path $RevitDir "RevitAPI.dll") -PathType Leaf)) {
    throw "Revit 2026 API was not found at $RevitDir."
  }

  $Git = Require-Command @("git.exe", "git") "Git"
  $Dotnet = Require-Command @("dotnet.exe", "dotnet") ".NET 8 SDK"
  $Node = Require-Command @("node.exe", "node") "Node.js"

  Write-Step "Clone exact current GitHub main into an isolated clean folder"
  $cloneUrl = "https://github.com/$Repository.git"
  Invoke-Checked "Clone current main" $Git @("clone", "--depth", "1", "--branch", "main", "--single-branch", $cloneUrl, $RepoRoot)
  $SourceSha = Invoke-Captured $Git @("rev-parse", "HEAD") $RepoRoot
  if ($SourceSha -notmatch "^[0-9a-fA-F]{40}$") { throw "Could not resolve the exact current-main source SHA." }
  Write-Host "Current source candidate: $SourceSha" -ForegroundColor Green

  Assert-SourceContract $RepoRoot
  Invoke-Checked "Reject stale REVEX generation" $Node @(".github\scripts\verify-revex-current-generation-r53.js") $RepoRoot
  Invoke-Checked "Verify root cache key matches the current UI BUILD" $Node @(".github\scripts\verify-revex-r99-webview-root-cache.js") $RepoRoot
  Invoke-Checked "Verify current r126 functional convergence" $Node @(".github\scripts\verify-revex-r126-functional-convergence.js") $RepoRoot

  $projectFullPath = Join-Path $RepoRoot $ProjectPath
  Invoke-Checked "Restore current add-in dependencies" $Dotnet @("restore", $projectFullPath, "-p:Platform=x64", "-p:RevitInstallDir=$RevitDir") $RepoRoot
  Invoke-Checked "Build current REVEX add-in for Revit 2026" $Dotnet @("build", $projectFullPath, "-c", "Release", "-p:Platform=x64", "-p:RevitInstallDir=$RevitDir", "--no-restore") $RepoRoot

  Write-Step "Stage complete current add-in payload"
  Copy-BuildPayload $RepoRoot

  Write-Step "Atomically replace only the local REVEX add-in payload"
  Install-Atomically

  Write-Host ""
  Write-Host "PASS: current r126 REVEX add-in installed." -ForegroundColor Green
  Write-Host "Source: $SourceSha" -ForegroundColor Green
  Write-Host "Assembly: $(Join-Path $InstalledRoot 'Liber.Revex.Revit.dll')"
  if ($PreviousPayloadMoved) { Write-Host "Backup: $BackupRoot" }
  Write-Host "Reopen Revit 2026. This updater did not redeploy or downgrade any cloud service." -ForegroundColor Green
  $ExitCode = 0
}
catch {
  Write-Host ""
  Write-Host "REVEX current r126 add-in update stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Installed files were either untouched or rolled back." -ForegroundColor Yellow
  $ExitCode = 1
}
finally {
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch { } }
  try { Copy-Item -LiteralPath $LogPath -Destination $LatestLogPath -Force } catch { }
  try { if (Test-Path -LiteralPath $WorkRoot -PathType Container) { Remove-Item -LiteralPath $WorkRoot -Recurse -Force } } catch { }
}

exit $ExitCode
