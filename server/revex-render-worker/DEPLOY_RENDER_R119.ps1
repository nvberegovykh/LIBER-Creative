param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Service = "revex-render-worker",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$BaseDeploy = Join-Path $PSScriptRoot "DEPLOY_RENDER_SERVER.ps1"
$MountPath = "/mnt/revex-hf-cache"
$ModelCache = "$MountPath/models/Qwen-Image-Edit-2511-6f3ccc0"

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { throw "$Name is required for REVEX Render deployment." }
  return $cmd.Source
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments) {
  Write-Host ">> $Label" -ForegroundColor DarkCyan
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    if ([int]$code -ne 0) { throw "$Label failed with exit code $code." }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Resolve-FirebaseBucket([string]$GCloud) {
  $rows = @(& $GCloud storage buckets list --project $ProjectId --format "value(name)" 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "Could not enumerate Firebase/Cloud Storage buckets." }
  $prefix = [Regex]::Escape($ProjectId)
  $names = @($rows | ForEach-Object { ([string]$_).Trim().TrimEnd('/') -replace '^gs://','' } | Where-Object { $_ })
  $matches = @($names | Where-Object { $_ -match "^$prefix\.(?:appspot\.com|firebasestorage\.app)$" })
  if ($matches.Count -ne 1) { throw "Expected exactly one Firebase Storage bucket for $ProjectId; found $($matches -join ', ')." }
  return [string]$matches[0]
}

$ExitCode = 1
try {
  Write-Host "REVEX r119 Render recovery - persistent Qwen cache" -ForegroundColor Cyan
  Write-Host "Scope: Render worker + Render broker only. Energy, Revit, BIM, UI and Docs are untouched."
  Write-Host "Model: Qwen/Qwen-Image-Edit-2511 @ 6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"

  if (-not (Test-Path -LiteralPath $BaseDeploy -PathType Leaf)) { throw "Missing base Render deployer: $BaseDeploy" }
  $GCloud = Require-Command "gcloud"

  # Build/deploy the current r119 image and authenticated broker first.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BaseDeploy -ProjectId $ProjectId -Region $Region -NoPause
  if ($LASTEXITCODE -ne 0) { throw "Base Render deployment failed with exit code $LASTEXITCODE." }

  $Bucket = Resolve-FirebaseBucket $GCloud
  Write-Host "Persistent model cache bucket: $Bucket" -ForegroundColor Green

  # The prior /tmp HF cache is memory-backed and disappears with the Cloud Run instance.
  # Mount the existing private Firebase Storage bucket so the 57.7 GB exact snapshot
  # downloads once, survives cold-instance replacement, and resumes after transport loss.
  Invoke-Checked "Reset Render worker volume contract" $GCloud @(
    "run","services","update",$Service,
    "--project=$ProjectId","--region=$Region","--clear-volumes","--quiet"
  )
  Invoke-Checked "Mount persistent Qwen cache and long Hub timeouts" $GCloud @(
    "run","services","update",$Service,
    "--project=$ProjectId","--region=$Region",
    "--add-volume","mount-path=$MountPath,type=cloud-storage,bucket=$Bucket,readonly=false",
    "--update-env-vars","HF_HOME=$MountPath/huggingface,REVEX_MODEL_CACHE_DIR=$ModelCache,HF_HUB_ETAG_TIMEOUT=120,HF_HUB_DOWNLOAD_TIMEOUT=900,HF_HUB_DISABLE_TELEMETRY=1,HF_XET_HIGH_PERFORMANCE=1,HF_ENABLE_PARALLEL_LOADING=YES",
    "--quiet"
  )

  $state = (& $GCloud run services describe $Service --project $ProjectId --region $Region --format json) | ConvertFrom-Json
  $ready = @($state.status.conditions | Where-Object { $_.type -eq 'Ready' } | Select-Object -First 1)
  if ($ready.Count -eq 0 -or [string]$ready[0].status -ne 'True') { throw "Render worker is not Ready after r119 cache mount." }

  Write-Host ""
  Write-Host "PASS: r119 Render worker is live with persistent resumable Qwen cache." -ForegroundColor Green
  Write-Host "First cold render may spend time filling the 57.7 GB cache; subsequent cold instances reuse it." -ForegroundColor Yellow
  $ExitCode = 0
} catch {
  Write-Host ""
  Write-Host "REVEX r119 Render deployment stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode = 1
} finally {
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') {
    Write-Host ""
    Write-Host "Press Enter to close."
    [void](Read-Host)
  }
}

exit $ExitCode
