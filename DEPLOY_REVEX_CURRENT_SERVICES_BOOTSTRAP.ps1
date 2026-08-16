param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [switch]$SkipEnergy,
  [switch]$SkipRender,
  [switch]$ValidateOnly,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$RepoUrl = "https://github.com/nvberegovykh/LIBER-Creative.git"
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("REVEX-CURRENT-DEPLOY-" + [guid]::NewGuid().ToString('N'))
$script:NativeExitCode = 0

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for the one-time managed deployment." }
  return $cmd.Source
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
}

function Invoke-NativeCapture([string]$Command, [string[]]$Arguments) {
  $output = @(& $Command @Arguments)
  $script:NativeExitCode = $LASTEXITCODE
  return $output
}

function Assert-PowerShellParse([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $Path), [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) {
    $messages = @($errors | ForEach-Object { $_.Message }) -join '; '
    throw "PowerShell parser rejected ${Path}: $messages"
  }
}

function Patch-DirectGCloudArrayInvocations([string]$Path) {
  $text = Get-Content -Raw -LiteralPath $Path
  if ($text.Contains('& $GCloud @(')) {
    $helper = @'
function Invoke-GCloudCapture([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
}
'@
    $text = $text.Replace('& $GCloud @(', 'Invoke-GCloudCapture $GCloud @(')
    $mainTry = [regex]::new('(?m)^try \{')
    if (-not $mainTry.IsMatch($text)) {
      throw "Could not locate the main deployment try block in $Path."
    }
    $text = $mainTry.Replace($text, ($helper + "`r`ntry {"), 1)
    Set-Content -LiteralPath $Path -Value $text -Encoding UTF8
  }
  Assert-PowerShellParse $Path
  $verified = Get-Content -Raw -LiteralPath $Path
  if ($verified.Contains('& $GCloud @(')) {
    throw "Unsafe direct gcloud array invocation remains in $Path."
  }
}

function Prepare-ManagedScripts([string]$Root) {
  $energy = Join-Path $Root "server\revex-energy-worker\DEPLOY_ENERGY_CURRENT.ps1"
  $render = Join-Path $Root "server\revex-render-worker\DEPLOY_RENDER_SERVER.ps1"
  foreach ($path in @($energy, $render)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Current REVEX source is missing managed deployment script: $path"
    }
    Patch-DirectGCloudArrayInvocations $path
  }
  return @{ Energy = $energy; Render = $render }
}

try {
  Write-Host "REVEX current managed-services bootstrap" -ForegroundColor Cyan
  Write-Host "Windows-safe native argv handling; stale r49 Drive source restoration is never used."

  if ($ValidateOnly) {
    $validationRoot = Join-Path $TempRoot "validation"
    New-Item -ItemType Directory -Path $validationRoot -Force | Out-Null
    $energySource = Join-Path $PSScriptRoot "server\revex-energy-worker\DEPLOY_ENERGY_CURRENT.ps1"
    $renderSource = Join-Path $PSScriptRoot "server\revex-render-worker\DEPLOY_RENDER_SERVER.ps1"
    New-Item -ItemType Directory -Path (Join-Path $validationRoot "server\revex-energy-worker") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $validationRoot "server\revex-render-worker") -Force | Out-Null
    Copy-Item -LiteralPath $energySource -Destination (Join-Path $validationRoot "server\revex-energy-worker\DEPLOY_ENERGY_CURRENT.ps1") -Force
    Copy-Item -LiteralPath $renderSource -Destination (Join-Path $validationRoot "server\revex-render-worker\DEPLOY_RENDER_SERVER.ps1") -Force
    $null = Prepare-ManagedScripts $validationRoot
    Assert-PowerShellParse $PSCommandPath
    Write-Host "PASS: bootstrap and patched nested deployment scripts parse safely." -ForegroundColor Green
    exit 0
  }

  $Git = Require-Command "git"
  $GCloud = Require-Command "gcloud"
  $Firebase = Require-Command "firebase"
  $Npm = Require-Command "npm"
  $Node = Require-Command "node"

  $authArgs = @("auth", "list", "--filter", "status:ACTIVE", "--format", "value(account)")
  $active = @(Invoke-NativeCapture $GCloud $authArgs) | Where-Object { $_ }
  if ($script:NativeExitCode -ne 0 -or $active.Count -eq 0) {
    throw "Google Cloud administrator authentication is required once. Run 'gcloud auth login', then rerun this file. Nothing was deployed."
  }

  $firebaseArgs = @("projects:list", "--json")
  $null = Invoke-NativeCapture $Firebase $firebaseArgs
  if ($script:NativeExitCode -ne 0) {
    throw "Firebase administrator authentication is required once. Run 'firebase login', then rerun this file. Nothing was deployed."
  }

  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
  Invoke-Checked "Clone exact current LIBER-Creative main" $Git @(
    "clone", "--depth", "1", "--branch", "main", "--single-branch", $RepoUrl, $TempRoot
  )
  $shaArgs = @("-C", $TempRoot, "rev-parse", "HEAD")
  $SourceCandidate = ((Invoke-NativeCapture $Git $shaArgs) -join "").Trim().ToLowerInvariant()
  if ($script:NativeExitCode -ne 0 -or $SourceCandidate -notmatch '^[0-9a-f]{40}$') {
    throw "Fresh current-main clone did not produce an exact commit SHA."
  }
  Write-Host "Current source candidate: $SourceCandidate" -ForegroundColor Green

  Invoke-Checked "Reject stale REVEX generation before cloud changes" $Node @(
    (Join-Path $TempRoot ".github\scripts\verify-revex-current-generation-r53.js")
  ) $TempRoot
  $R54Guard = Join-Path $TempRoot ".github\scripts\verify-revex-r54-selfhost-render.js"
  if (Test-Path -LiteralPath $R54Guard -PathType Leaf) {
    Invoke-Checked "Verify renderer + Energy + BIM viewer integration" $Node @($R54Guard) $TempRoot
  }

  $scripts = Prepare-ManagedScripts $TempRoot

  if (-not $SkipEnergy) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scripts.Energy `
      -ProjectId $ProjectId -Region $Region -SourceCandidate $SourceCandidate -NoPause
    if ($LASTEXITCODE -ne 0) {
      throw "Current managed Energy deployment failed with exit code $LASTEXITCODE."
    }
  }

  if (-not $SkipRender) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scripts.Render `
      -ProjectId $ProjectId -Region $Region -NoPause
    if ($LASTEXITCODE -ne 0) {
      throw "Energy may already be current, but the private GPU renderer deployment failed with exit code $LASTEXITCODE. Read the immediately preceding GPU/quota error."
    }
  }

  Write-Host ""
  Write-Host "PASS: current REVEX managed services deployed from exact main $SourceCandidate." -ForegroundColor Green
  Write-Host "End users keep the normal LIBER sign-in; the public Qwen model requires no Hugging Face login/token."
} catch {
  Write-Host ""
  Write-Host "REVEX current managed-services bootstrap stopped safely." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  if (Test-Path -LiteralPath $TempRoot) {
    try { Remove-Item -LiteralPath $TempRoot -Recurse -Force } catch { Write-Warning "Temporary clean clone remains at $TempRoot" }
  }
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') { Write-Host "" }
}
