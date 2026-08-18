param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [switch]$SkipReport,
  [switch]$SkipRender,
  [switch]$ValidateOnly,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$RepoUrl = "https://github.com/nvberegovykh/LIBER-Creative.git"
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("REVEX-R126-CURRENT-DEPLOY-" + [guid]::NewGuid().ToString('N'))
$script:NativeExitCode = 0
$ExitCode = 1

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for the current r126 deployment." }
  return $cmd.Source
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
  }
  finally {
    if ($WorkingDirectory) { Pop-Location }
  }
}

function Invoke-NativeCapture([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $Command @Arguments 2>$null | ForEach-Object { [string]$_ })
    $script:NativeExitCode = $LASTEXITCODE
    if ($null -eq $script:NativeExitCode) { $script:NativeExitCode = 0 }
    return $output
  }
  finally { $ErrorActionPreference = $previous }
}

function Assert-PowerShellParse([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $Path), [ref]$tokens, [ref]$errors)
  if (@($errors).Count -gt 0) {
    $messages = @($errors | ForEach-Object { $_.Message }) -join '; '
    throw "PowerShell parser rejected ${Path}: $messages"
  }
}

function Assert-CurrentR126Source([string]$Root, [string]$Node) {
  $required = @(
    ".github\scripts\verify-revex-current-generation-r53.js",
    ".github\scripts\verify-revex-r99-webview-root-cache.js",
    ".github\scripts\verify-revex-r126-functional-convergence.js",
    "docs\liber-apps\apps\revex\ui-integrity.js",
    "docs\liber-apps\apps\revex\docs-convergence-r126.js",
    "docs\liber-apps\apps\revex\appearance-convergence-r126.js",
    "docs\liber-apps\apps\revex\issues-convergence-r126.js",
    "docs\liber-apps\apps\revex\history-daily-r126.js",
    "docs\liber-apps\apps\revex\blocks-palette-r126.js",
    "docs\liber-apps\apps\revex\render-convergence-r126.js",
    "server\revex-render-worker\DEPLOY_RENDER_R126.ps1",
    "server\revex-report-functions\DEPLOY_REPORT_R126.ps1",
    "src\Liber.Revex.Revit\Revit\RevexFamilyPlacementExternalHandler.cs",
    "src\Liber.Revex.Revit\Services\AffectedPlanExportService.cs",
    "UPDATE_REVEX_ADDIN_CURRENT.ps1"
  )
  foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) {
      throw "Exact current-main r126 contract is incomplete: missing $relative."
    }
  }

  Invoke-Checked "Reject stale REVEX generation" $Node @(
    (Join-Path $Root ".github\scripts\verify-revex-current-generation-r53.js")
  ) $Root
  Invoke-Checked "Verify root cache key matches the current UI BUILD" $Node @(
    (Join-Path $Root ".github\scripts\verify-revex-r99-webview-root-cache.js")
  ) $Root
  Invoke-Checked "Verify r126 functional convergence" $Node @(
    (Join-Path $Root ".github\scripts\verify-revex-r126-functional-convergence.js")
  ) $Root
}

try {
  Write-Host "REVEX current r126 managed-services bootstrap" -ForegroundColor Cyan
  Write-Host "Authority: exact current GitHub main only." -ForegroundColor Green
  Write-Host "Deployment scope: post-sync Report/Daily Report + warm persistent private Render." -ForegroundColor Green
  Write-Host "Protected scope: Energy worker/broker and existing Engineering revisions are never deployed or replaced here." -ForegroundColor Green

  if ($SkipReport -and $SkipRender -and -not $ValidateOnly) {
    throw "Both Report and Render were skipped; nothing was requested for deployment."
  }

  $Git = Require-Command "git"
  $Node = Require-Command "node"
  if (-not $ValidateOnly) {
    $GCloud = Require-Command "gcloud"
    $active = @(Invoke-NativeCapture $GCloud @("auth", "list", "--filter", "status:ACTIVE", "--format", "value(account)")) | Where-Object { $_ }
    if ($script:NativeExitCode -ne 0 -or @($active).Count -eq 0) {
      throw "Google Cloud administrator authentication is required. Nothing was deployed."
    }
  }

  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
  Invoke-Checked "Clone exact current LIBER-Creative main" $Git @(
    "clone", "--depth", "1", "--branch", "main", "--single-branch", $RepoUrl, $TempRoot
  )

  $SourceCandidate = ((Invoke-NativeCapture $Git @("-C", $TempRoot, "rev-parse", "HEAD")) -join "").Trim().ToLowerInvariant()
  if ($script:NativeExitCode -ne 0 -or $SourceCandidate -notmatch '^[0-9a-f]{40}$') {
    throw "Fresh current-main clone did not produce an exact commit SHA."
  }
  Write-Host "Current source candidate: $SourceCandidate" -ForegroundColor Green

  Assert-CurrentR126Source $TempRoot $Node

  $ReportDeploy = Join-Path $TempRoot "server\revex-report-functions\DEPLOY_REPORT_R126.ps1"
  $RenderDeploy = Join-Path $TempRoot "server\revex-render-worker\DEPLOY_RENDER_R126.ps1"
  Assert-PowerShellParse $ReportDeploy
  Assert-PowerShellParse $RenderDeploy

  if ($ValidateOnly) {
    Write-Host ""
    Write-Host "PASS: exact current-main r126 deployment chain validated." -ForegroundColor Green
    Write-Host "No cloud service or local Revit add-in was changed." -ForegroundColor Green
    $ExitCode = 0
  }
  else {
    if (-not $SkipReport) {
      Write-Host ""
      Write-Host "============================================================" -ForegroundColor DarkCyan
      Write-Host "1/2 REVEX r126 REPORT - post-sync revision documentation" -ForegroundColor DarkCyan
      Write-Host "============================================================" -ForegroundColor DarkCyan
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ReportDeploy -ProjectId $ProjectId -Region $Region -NoPause
      if ($LASTEXITCODE -ne 0) {
        throw "Current r126 Report deployment failed with exit code $LASTEXITCODE. Render was not changed."
      }
    }

    if (-not $SkipRender) {
      Write-Host ""
      Write-Host "============================================================" -ForegroundColor DarkCyan
      Write-Host "2/2 REVEX r126 RENDER - warm server proof before broker cutover" -ForegroundColor DarkCyan
      Write-Host "============================================================" -ForegroundColor DarkCyan
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RenderDeploy -ProjectId $ProjectId -Region $Region -NoPause
      if ($LASTEXITCODE -ne 0) {
        throw "Current r126 Render deployment failed with exit code $LASTEXITCODE. The prior Render authority remains because r126 cuts over only after warm proof."
      }
    }

    Write-Host ""
    Write-Host "PASS: current REVEX managed services deployed from exact main $SourceCandidate." -ForegroundColor Green
    Write-Host "Energy was not touched." -ForegroundColor Green
    Write-Host "Next local step: close Revit and run UPDATE_REVEX_ADDIN_CURRENT.cmd; it clones current main and atomically installs that exact add-in." -ForegroundColor Yellow
    $ExitCode = 0
  }
}
catch {
  Write-Host ""
  Write-Host "REVEX current r126 managed-services bootstrap stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  $ExitCode = 1
}
finally {
  if (Test-Path -LiteralPath $TempRoot) {
    try { Remove-Item -LiteralPath $TempRoot -Recurse -Force }
    catch { Write-Warning "Temporary current-main clone remains at $TempRoot" }
  }
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') {
    Write-Host ""
    Write-Host "Press Enter to close."
    [void](Read-Host)
  }
}

exit $ExitCode
