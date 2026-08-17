param(
    [string]$ProjectId = "liber-apps-cca20",
    [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$SourceCandidate = "32c2ffd5994d385fb6e7c45414b0b5a0c1188ef5"
$Repo = "https://github.com/nvberegovykh/LIBER-Creative.git"
$Work = Join-Path $env:TEMP ("REVEX-RENDER-" + [guid]::NewGuid().ToString("N"))
$Source = Join-Path $Work "source"
$ExitCode = 1

function Require-Command([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { throw "$Name is required." }
    return $cmd.Source
}

function Invoke-Native([string]$Command, [string[]]$Arguments, [switch]$Quiet) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        if ($Quiet) {
            & $Command @Arguments *> $null
        } else {
            & $Command @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
        }
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        return [int]$code
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Capture-Native([string]$Command, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $lines = @(& $Command @Arguments 2>$null | ForEach-Object { [string]$_ })
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        return [pscustomobject]@{ Code = [int]$code; Text = ($lines -join "`n").Trim() }
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

try {
    Write-Host "REVEX Render-only recovery" -ForegroundColor Cyan
    Write-Host "Source: $SourceCandidate"
    Write-Host "Scope: Render worker + Render broker only. Energy/Revit/BIM/UI/Docs untouched." -ForegroundColor Green

    $Git = Require-Command "git"
    $GCloud = Require-Command "gcloud"
    $null = Require-Command "npm"
    $null = Require-Command "node"

    $auth = Capture-Native $GCloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
    if ($auth.Code -ne 0 -or -not $auth.Text) {
        Write-Host "Google Cloud sign-in required once..." -ForegroundColor Yellow
        if ((Invoke-Native $GCloud @("auth", "login")) -ne 0) {
            throw "Google Cloud authentication failed."
        }
        $auth = Capture-Native $GCloud @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
        if ($auth.Code -ne 0 -or -not $auth.Text) {
            throw "Google Cloud authentication did not complete."
        }
    }

    New-Item -ItemType Directory -Path $Work -Force | Out-Null
    if ((Invoke-Native $Git @("init", $Source) -Quiet) -ne 0) { throw "git init failed." }
    if ((Invoke-Native $Git @("-C", $Source, "remote", "add", "origin", $Repo) -Quiet) -ne 0) { throw "git remote failed." }
    if ((Invoke-Native $Git @("-C", $Source, "fetch", "--depth", "1", "origin", $SourceCandidate)) -ne 0) { throw "Exact Render source fetch failed." }
    if ((Invoke-Native $Git @("-C", $Source, "checkout", "--detach", "FETCH_HEAD") -Quiet) -ne 0) { throw "Exact Render checkout failed." }

    $checked = Capture-Native $Git @("-C", $Source, "rev-parse", "HEAD")
    if ($checked.Text.ToLowerInvariant() -ne $SourceCandidate) {
        throw "Exact-source checkout mismatch: $($checked.Text)"
    }

    $deploy = Join-Path $Source "server\revex-render-worker\DEPLOY_RENDER_R119.ps1"
    if (-not (Test-Path -LiteralPath $deploy -PathType Leaf)) {
        throw "r119 Render deployer missing."
    }

    $code = Invoke-Native "powershell.exe" @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $deploy,
        "-ProjectId", $ProjectId,
        "-Region", $Region,
        "-NoPause"
    )
    if ($code -ne 0) {
        throw "r119 Render deployment failed with exit code $code."
    }

    Write-Host "PASS: Render worker + broker deployed with persistent Qwen cache." -ForegroundColor Green
    Start-Process "https://liberpict.com/liber-apps/apps/revex/index.html?view=bim"
    $ExitCode = 0
}
catch {
    Write-Host "REVEX Render recovery stopped safely: $($_.Exception.Message)" -ForegroundColor Red
    $ExitCode = 1
}
finally {
    if (Test-Path -LiteralPath $Work) {
        try { Remove-Item -LiteralPath $Work -Recurse -Force } catch {}
    }
    Write-Host "Press Enter to close."
    [void](Read-Host)
}

exit $ExitCode
