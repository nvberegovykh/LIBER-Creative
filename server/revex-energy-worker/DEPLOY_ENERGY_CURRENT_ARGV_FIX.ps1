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
  $pattern = '& \$GCloud @\(([^\r\n\)]*)\)'
  $matches = [regex]::Matches($text, $pattern)
  if ($matches.Count -lt 5) {
    throw "Expected at least five direct gcloud array-expression calls; found $($matches.Count). Refusing an incomplete argv patch."
  }

  $fixed = [regex]::Replace($text, $pattern, '& $GCloud $1')
  if ($fixed -match '& \$GCloud @\(') {
    throw "Direct gcloud array-expression invocation remains after argv repair."
  }

  [System.IO.File]::WriteAllText($Runtime, $fixed, (New-Object System.Text.UTF8Encoding($false)))
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Runtime, [ref]$tokens, [ref]$errors)
  if (@($errors).Count -gt 0) {
    throw "Runtime-fixed Energy deployer did not parse: $($errors[0].Message)"
  }

  Write-Host "REVEX Energy argv repair: PASS" -ForegroundColor Green
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
