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
      if ([int]$code -ne 0) { throw "Command failed with exit code $code: $Command $($Arguments -join ' ')" }
      return ($lines -join [Environment]::NewLine).Trim()
    } finally {
      if ($WorkingDirectory) { Pop-Location }
    }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Assert-RevitClosed {
  $running = @(Get-Process -Name "Revit" -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    throw "Revit 2026 is still running. Save/close Revit completely, then rerun this updater. No installed REVEX files were changed."
  }
}

function Assert-SourceContract([string]$Root) {
  $required = @(
    ".github\scripts\verify-revex-current-generation-r53.js",
    ".github\scripts\verify-revex-r72-nonblocking-viewer.js",
    ".github\scripts\verify-revex-r73-energy-topology-fallback.py",
    "docs\liber-apps\apps\revex\viewer-runtime-r72.js",
    "docs\liber-apps\apps\revex\material-modal-r72.js",
    "src\Liber.Revex.Revit\UI\RevexWebIntegrationBridge.cs",
    "src\Liber.Revex.Revit\Revit\RevitRequestHandler.cs",
    $ProjectPath
  )
  foreach ($relative in $required) {
    $path = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Current-main source contract is incomplete: missing $relative."
    }
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

  $requiredPayload = @(
    "Liber.Revex.Revit.dll",
    "Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py",
    "Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.dyn"
  )
  foreach ($relative in $requiredPayload) {
    if (-not (Test-Path -LiteralPath (Join-Path $StagePayload $relative) -PathType Leaf)) {
      throw "Built add-in payload is incomplete: missing $relative."
    }
  }

  $marker = [ordered]@{
    schema = "liber.revex.current-addin-source.v1"
    source = "github-main"
    repository = $Repository
    commit = $SourceSha
    builtAtUtc = [DateTime]::UtcNow.ToString("o")
    updater = "UPDATE_REVEX_ADDIN_CURRENT.ps1"
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

  Write-Host "REVEX current-main add-in updater" -ForegroundColor Cyan
  Write-Host "No Firebase, Cloud Run, renderer, Energy worker or stale r49 publisher is used."
  Write-Host "Persistent log: $LogPath"

  Write-Step "Verify Revit is closed before any installed-file change"
  Assert-RevitClosed

  if (-not (Test-Path -LiteralPath (Join-Path $RevitDir "RevitAPI.dll") -PathType Leaf)) {
    throw "Revit 2026 API was not found at $RevitDir."
  }

  $Git = Require-Command @("git.exe", "git") "Git"
  $Dotnet = Require-Command @("dotnet.exe", "dotnet") ".NET 8 SDK"
  $Node = Require-Command @("node.exe", "node") "Node.js"
  $Python = Require-Command @("py.exe", "python.exe", "py", "python") "Python 3"

  Write-Step "Clone exact current GitHub main into an isolated clean folder"
  $cloneUrl = "https://github.com/$Repository.git"
  Invoke-Checked "Clone current main" $Git @("clone", "--depth", "1", "--branch", "main", "--single-branch", $cloneUrl, $RepoRoot)
  $SourceSha = Invoke-Captured $Git @("rev-parse", "HEAD") $RepoRoot
  if ($SourceSha -notmatch "^[0-9a-fA-F]{40}$") { throw "Could not resolve the exact current-main source SHA." }
  Write-Host "Current source candidate: $SourceSha" -ForegroundColor Green

  Assert-SourceContract $RepoRoot
  Invoke-Checked "Reject stale REVEX generation" $Node @(".github\scripts\verify-revex-current-generation-r53.js") $RepoRoot
  Invoke-Checked "Verify r72 nonblocking viewer + owned material integration" $Node @(".github\scripts\verify-revex-r72-nonblocking-viewer.js") $RepoRoot
  Invoke-Checked "Verify r54 renderer/Energy/viewer integration remains preserved" $Node @(".github\scripts\verify-revex-r54-selfhost-render.js") $RepoRoot
  $pythonArgs = if ([IO.Path]::GetFileName($Python).StartsWith("py", [StringComparison]::OrdinalIgnoreCase)) {
    @("-3", ".github\scripts\verify-revex-r73-energy-topology-fallback.py")
  } else {
    @(".github\scripts\verify-revex-r73-energy-topology-fallback.py")
  }
  Invoke-Checked "Verify r73 Revit analytical-topology fallback" $Python $pythonArgs $RepoRoot

  $projectFullPath = Join-Path $RepoRoot $ProjectPath
  Invoke-Checked "Restore current add-in dependencies" $Dotnet @("restore", $projectFullPath, "-p:Platform=x64", "-p:RevitInstallDir=$RevitDir") $RepoRoot
  Invoke-Checked "Build current REVEX add-in for Revit 2026" $Dotnet @("build", $projectFullPath, "-c", "Release", "-p:Platform=x64", "-p:RevitInstallDir=$RevitDir", "--no-restore") $RepoRoot

  Write-Step "Stage complete current add-in payload"
  Copy-BuildPayload $RepoRoot

  Write-Step "Atomically replace only the local REVEX add-in payload"
  Install-Atomically

  Write-Host ""
  Write-Host "PASS: current REVEX add-in installed." -ForegroundColor Green
  Write-Host "Source: $SourceSha" -ForegroundColor Green
  Write-Host "Assembly: $(Join-Path $InstalledRoot 'Liber.Revex.Revit.dll')"
  if ($PreviousPayloadMoved) { Write-Host "Backup: $BackupRoot" }
  Write-Host "Reopen Revit 2026. No cloud-service redeployment is required." -ForegroundColor Green
  $ExitCode = 0
}
catch {
  Write-Host ""
  Write-Host "REVEX current add-in update stopped safely." -ForegroundColor Red
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
