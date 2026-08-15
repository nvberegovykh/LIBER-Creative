param(
  [string]$GitHubRepository = "nvberegovykh/LIBER-Creative",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$HotfixBranch = "backup/revex-r49-review-hotfix-20260815"
$HotfixCommit = "8007dc24b9c1b8cfb947470341cf19d6c866af77"
$EnergyBackupBranch = "backup/revex-energy-r49-known-good-20260815"
$EnergyBackupCommit = "dfb32ab6a0fbdeaa0942ce5f5817fba0c9c76bce"
$StageRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX-R49-ReviewHotfix\$RunId"
$RepoRoot = Join-Path $StageRoot "LIBER-Creative"
$Payload = Join-Path $StageRoot "addin-payload"
$InstalledRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\App"
$BackupRoot = Join-Path $env:LOCALAPPDATA "LIBER\REVEX\App.before-review-hotfix.$RunId"
$AddinPath = Join-Path $env:APPDATA "Autodesk\Revit\Addins\2026\LIBER.REVEX.addin"
$RevitDir = "C:\Program Files\Autodesk\Revit 2026"
$LogPath = Join-Path $StageRoot "FINALIZE_REVEX_R49_REVIEW_HOTFIX.log"

New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
[IO.File]::WriteAllText($LogPath, "", [Text.UTF8Encoding]::new($false))

function Write-Log([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::Gray) {
  Add-Content -LiteralPath $LogPath -Value $Message -Encoding UTF8
  Write-Host $Message -ForegroundColor $Color
}

function Resolve-Executable([string[]]$Names) {
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  return $null
}

function Invoke-Native {
  param(
    [Parameter(Mandatory=$true)][string]$Step,
    [Parameter(Mandatory=$true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = ""
  )
  Write-Log ">> $Step" DarkCyan
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command @Arguments 2>&1 | ForEach-Object { Write-Log ([string]$_) }
    $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $old
    if ($WorkingDirectory) { Pop-Location }
  }
  if ($code -ne 0) { throw "$Step failed with exit code $code." }
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory=$true)][string]$Step,
    [Parameter(Mandatory=$true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = ""
  )
  Write-Log ">> $Step" DarkCyan
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $lines = @()
  try {
    & $Command @Arguments 2>&1 | ForEach-Object { $lines += [string]$_; Write-Log ([string]$_) }
    $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $old
    if ($WorkingDirectory) { Pop-Location }
  }
  if ($code -ne 0) { throw "$Step failed with exit code $code." }
  return ($lines -join [Environment]::NewLine).Trim()
}

try {
  Write-Log "REVEX 0.8.19 r49 review/native-binding finalizer" Green
  Write-Log "Hotfix snapshot: $HotfixCommit"
  Write-Log "Energy recovery snapshot: $EnergyBackupCommit"

  if (Get-Process Revit -ErrorAction SilentlyContinue) {
    throw "Revit is running. The final atomic add-in replacement is intentionally blocked to avoid a partially loaded DLL. Close Revit and rerun PUBLISH_REVEX_R49.cmd."
  }

  $Git = Resolve-Executable @("git.exe", "git")
  $Gh = Resolve-Executable @("gh.exe", "gh")
  $Dotnet = Resolve-Executable @("dotnet.exe", "dotnet")
  if (-not $Git -or -not $Gh -or -not $Dotnet) {
    throw "Git, GitHub CLI and dotnet are required. The canonical publisher normally installs/verifies them before this finalizer runs."
  }

  Invoke-Native "Verify GitHub authentication" $Gh @("auth", "status", "--hostname", "github.com")
  Invoke-Native "Configure GitHub authentication for Git" $Gh @("auth", "setup-git")
  Invoke-Native "Clone REVEX repository for immutable hotfix rebuild" $Gh @("repo", "clone", $GitHubRepository, $RepoRoot, "--", "--filter=blob:none", "--no-checkout")

  Invoke-Native "Fetch immutable review hotfix backup ref" $Git @("fetch", "origin", $HotfixBranch, "--depth", "1") -WorkingDirectory $RepoRoot
  $actualHotfix = Invoke-Captured "Verify review hotfix commit" $Git @("rev-parse", "FETCH_HEAD") -WorkingDirectory $RepoRoot
  if ($actualHotfix -ne $HotfixCommit) { throw "Review hotfix backup ref moved. Expected $HotfixCommit; actual $actualHotfix." }
  Invoke-Native "Checkout immutable review hotfix" $Git @("checkout", "--detach", $HotfixCommit) -WorkingDirectory $RepoRoot

  Invoke-Native "Fetch immutable Energy recovery ref" $Git @("fetch", "origin", $EnergyBackupBranch, "--depth", "1") -WorkingDirectory $RepoRoot
  $actualEnergyBackup = Invoke-Captured "Verify Energy recovery commit" $Git @("rev-parse", "FETCH_HEAD") -WorkingDirectory $RepoRoot
  if ($actualEnergyBackup -ne $EnergyBackupCommit) { throw "Energy backup ref moved. Expected $EnergyBackupCommit; actual $actualEnergyBackup." }

  $energyCriticalPaths = @(
    "src/Liber.Revex.Revit/Engineering/Energy",
    "src/Liber.Revex.Revit/Engineering/Gbxml",
    "src/Liber.Revex.Revit/Engineering/Companion/native-managed-energy-bridge.js",
    "server/revex-energy-worker",
    "server/firebase-functions"
  )
  $driftArgs = @("diff", "--name-only", $EnergyBackupCommit, $HotfixCommit, "--") + $energyCriticalPaths
  $energyDrift = Invoke-Captured "Prove review hotfix does not alter the backed-up Energy chain" $Git $driftArgs -WorkingDirectory $RepoRoot
  if ($energyDrift) {
    throw "Review hotfix unexpectedly changes Energy-core files and was refused:`n$energyDrift"
  }
  Write-Log "Energy-core byte history is unchanged by the review hotfix." Green

  $companionBridge = Join-Path $RepoRoot "src\Liber.Revex.Revit\Services\CompanionWebBridge.cs"
  $settingsService = Join-Path $RepoRoot "src\Liber.Revex.Revit\Services\SettingsService.cs"
  if (-not (Select-String -LiteralPath $companionBridge -SimpleMatch "output.ViewerMeshManifest" -Quiet) -or
      -not (Select-String -LiteralPath $companionBridge -SimpleMatch "output.ViewerMeshPages" -Quiet)) {
    throw "Immutable hotfix is missing paged exact-Revit geometry attachment wiring."
  }
  if (-not (Select-String -LiteralPath $settingsService -SimpleMatch "DocumentProjectBindings" -Quiet) -or
      -not (Select-String -LiteralPath $settingsService -SimpleMatch "BoundAtUtc" -Quiet)) {
    throw "Immutable hotfix is missing durable active-document binding preservation."
  }

  $projectFile = Join-Path $RepoRoot "src\Liber.Revex.Revit\Liber.Revex.Revit.csproj"
  Invoke-Native "Restore REVEX add-in dependencies" $Dotnet @("restore", $projectFile)
  Invoke-Native "Compile immutable r49 review hotfix against Revit 2026" $Dotnet @("build", $projectFile, "-c", "Release", "--no-restore", "-nologo", "-p:RevitInstallDir=$RevitDir", "-o", $Payload)

  $required = @(
    "Liber.Revex.Revit.dll",
    "Microsoft.Web.WebView2.Core.dll",
    "Engineering\Energy\revex_energy_pipeline.py",
    "Engineering\Energy\verify_revex_r49_energy.py",
    "Engineering\Gbxml\LIBER_gbXML_Preflight_and_Export.py",
    "Engineering\Companion\native-managed-energy-bridge.js"
  )
  foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Payload $relative) -PathType Leaf)) {
      throw "Review-hotfix build payload is incomplete: $relative"
    }
  }

  $dll = Join-Path $Payload "Liber.Revex.Revit.dll"
  $productVersion = (Get-Item -LiteralPath $dll).VersionInfo.ProductVersion
  if ([string]$productVersion -notmatch "0\.8\.19-r49") { throw "Compiled review hotfix is not REVEX r49 (ProductVersion=$productVersion)." }
  $dllHash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()

  $oldMoved = $false
  try {
    if (Test-Path -LiteralPath $InstalledRoot) {
      Move-Item -LiteralPath $InstalledRoot -Destination $BackupRoot
      $oldMoved = $true
    }
    Move-Item -LiteralPath $Payload -Destination $InstalledRoot
    $assemblyPath = Join-Path $InstalledRoot "Liber.Revex.Revit.dll"
    if (-not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)) { throw "Final installed r49 DLL is missing." }

    $marker = [ordered]@{
      schema = "liber.revex.r49-review-hotfix.v1"
      installedAtUtc = [DateTime]::UtcNow.ToString("o")
      hotfixCommit = $HotfixCommit
      energyBackupCommit = $EnergyBackupCommit
      energyCoreChanged = $false
      productVersion = [string]$productVersion
      dllSha256 = $dllHash
      priorInstallBackup = if ($oldMoved) { $BackupRoot } else { $null }
    } | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText((Join-Path $InstalledRoot "REVEX_R49_REVIEW_HOTFIX.json"), $marker, [Text.UTF8Encoding]::new($false))

    if (-not (Test-Path -LiteralPath $AddinPath -PathType Leaf) -or
        -not (Select-String -LiteralPath $AddinPath -SimpleMatch $assemblyPath -Quiet)) {
      $manifest = @"
<?xml version="1.0" encoding="utf-8" standalone="no"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>LIBER REVEX</Name>
    <Assembly>$assemblyPath</Assembly>
    <AddInId>DECFCABB-63FD-4E1B-9A98-2B646874D487</AddInId>
    <FullClassName>Liber.Revex.Revit.App</FullClassName>
    <VendorId>LIBR</VendorId>
    <VendorDescription>LIBER Creative LLC</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
      New-Item -ItemType Directory -Path (Split-Path -Parent $AddinPath) -Force | Out-Null
      Set-Content -LiteralPath $AddinPath -Value $manifest -Encoding utf8
    }
  } catch {
    if (Test-Path -LiteralPath $InstalledRoot) {
      Move-Item -LiteralPath $InstalledRoot -Destination ($InstalledRoot + ".failed-review-hotfix.$RunId") -ErrorAction SilentlyContinue
    }
    if ($oldMoved -and (Test-Path -LiteralPath $BackupRoot)) {
      Move-Item -LiteralPath $BackupRoot -Destination $InstalledRoot
    }
    throw
  }

  Write-Log "REVEX r49 review/native-binding hotfix finalized atomically." Green
  Write-Log "Installed DLL SHA-256: $dllHash" Green
  Write-Log "Energy chain remained identical to backup snapshot $EnergyBackupCommit." Green
  if ($oldMoved) { Write-Log "Recoverable prior add-in: $BackupRoot" }
  Write-Log "Finalizer log: $LogPath"
  if (-not $NoPause) { }
} catch {
  Write-Log "REVEX r49 review hotfix finalization stopped safely." Red
  Write-Log ([string]$_.Exception.Message) Red
  Write-Log "The prior installed add-in is preserved/restored when atomic replacement fails." Yellow
  Write-Log "Finalizer log: $LogPath"
  exit 1
}
