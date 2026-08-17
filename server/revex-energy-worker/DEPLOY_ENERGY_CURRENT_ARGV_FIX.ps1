param(
  [string]$ProjectId = "liber-apps-cca20",
  [string]$Region = "us-central1",
  [string]$Repository = "revex",
  [string]$Service = "revex-energy-worker",
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceCandidate,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$Original = Join-Path $PSScriptRoot "DEPLOY_ENERGY_CURRENT.ps1"
$Runtime = Join-Path $PSScriptRoot "DEPLOY_ENERGY_CURRENT.runtime-fixed.ps1"
$ExitCode = 1

try {
  if (-not (Test-Path -LiteralPath $Original -PathType Leaf)) {
    throw "Current Energy deployer is missing: $Original"
  }

  $text = Get-Content -Raw -LiteralPath $Original
  $replacements = @(
    @(
      '$active = @(& $GCloud @("auth","list","--filter=status:ACTIVE","--format=value(account)")) | Where-Object { $_ }',
      '$active = @(& $GCloud "auth" "list" "--filter=status:ACTIVE" "--format=value(account)") | Where-Object { $_ }'
    ),
    @(
      '$CloudBuildSa = (& $GCloud @("builds","get-default-service-account","--project=$ProjectId","--format=value(serviceAccountEmail)")).Trim()',
      '$CloudBuildSa = (& $GCloud "builds" "get-default-service-account" "--project=$ProjectId" "--format=value(serviceAccountEmail)").Trim()'
    ),
    @(
      '$WorkerUrl = (& $GCloud @("run","services","describe",$Service,"--project=$ProjectId","--region=$Region","--format=value(status.url)")).Trim()',
      '$WorkerUrl = (& $GCloud "run" "services" "describe" $Service "--project=$ProjectId" "--region=$Region" "--format=value(status.url)").Trim()'
    ),
    @(
      '$FunctionState = (& $GCloud @("functions","describe","runRevexEnergy","--gen2","--project=$ProjectId","--region=$Region","--format=json")) | ConvertFrom-Json',
      '$FunctionState = (& $GCloud "functions" "describe" "runRevexEnergy" "--gen2" "--project=$ProjectId" "--region=$Region" "--format=json") | ConvertFrom-Json'
    ),
    @(
      '$RunState = (& $GCloud @("run","services","describe",$Service,"--project=$ProjectId","--region=$Region","--format=json")) | ConvertFrom-Json',
      '$RunState = (& $GCloud "run" "services" "describe" $Service "--project=$ProjectId" "--region=$Region" "--format=json") | ConvertFrom-Json'
    )
  )

  $fixed = $text
  foreach ($pair in $replacements) {
    $old = [string]$pair[0]
    $new = [string]$pair[1]
    if (-not $fixed.Contains($old)) {
      throw "Expected direct gcloud invocation was not found; refusing partial argv repair: $old"
    }
    $fixed = $fixed.Replace($old, $new)
  }

  foreach ($pair in $replacements) {
    if ($fixed.Contains([string]$pair[0])) {
      throw "A direct gcloud array-expression invocation remains after argv repair."
    }
  }

  [System.IO.File]::WriteAllText($Runtime, $fixed, (New-Object System.Text.UTF8Encoding($false)))
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Runtime, [ref]$tokens, [ref]$errors)
  if (@($errors).Count -gt 0) {
    throw "Runtime-fixed Energy deployer did not parse: $($errors[0].Message)"
  }

  Write-Host "REVEX Energy argv repair: PASS (5 exact calls)" -ForegroundColor Green
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Runtime `
    -ProjectId $ProjectId `
    -Region $Region `
    -Repository $Repository `
    -Service $Service `
    -SourceCandidate $SourceCandidate `
    -NoPause
  $ExitCode = $LASTEXITCODE
  if ($null -eq $ExitCode) { $ExitCode = 0 }
}
catch {
  Write-Host "REVEX Energy argv repair stopped safely: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode = 1
}
finally {
  Remove-Item -LiteralPath $Runtime -Force -ErrorAction SilentlyContinue
  if (-not $NoPause -and $Host.Name -match 'ConsoleHost') {
    Write-Host "Press Enter to close."
    [void](Read-Host)
  }
}

exit [int]$ExitCode
