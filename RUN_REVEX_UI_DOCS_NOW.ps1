$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$ExitCode = 1
$Base = "https://liberpict.com/liber-apps/apps/revex"

try {
    Write-Host "REVEX UI + Docs refresh" -ForegroundColor Cyan
    Write-Host "Scope: Companion UI + Docs only. Energy, Render worker, Revit and project revisions are untouched." -ForegroundColor Green

    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $targets = @(
        @{
            Url = "$Base/ui-integrity.js?cb=$stamp"
            Markers = @(
                "docs-pages-r115.js?v=20260817r115-docs1",
                "ui-polish-r109.js?v=20260817r110-responsive1",
                "bim-properties-r117.js?v=20260817r117-bim-properties1"
            )
        },
        @{
            Url = "$Base/docs-pages-r115.js?cb=$stamp"
            Markers = @(
                "derivedFromFullSet:true",
                "printing-pages-derived",
                "PDF_LIB_URL='https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'"
            )
        }
    )

    foreach ($target in $targets) {
        $ok = $false
        for ($attempt = 1; $attempt -le 18; $attempt++) {
            try {
                $text = (Invoke-WebRequest -UseBasicParsing -Uri $target.Url -TimeoutSec 30).Content
                $missing = @($target.Markers | Where-Object { -not $text.Contains($_) })
                if ($missing.Count -eq 0) {
                    $ok = $true
                    break
                }
            } catch {
                # Pages can briefly return a stale edge while deployment propagates.
            }
            Write-Host "Waiting for current GitHub Pages UI/Docs build ($attempt/18)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 10
        }
        if (-not $ok) {
            throw "Current UI/Docs build did not reach the public Companion yet."
        }
    }

    Write-Host "PASS: current UI + Docs fixes are live." -ForegroundColor Green
    Start-Process "$Base/index.html?revexUiDocs=$stamp"
    $ExitCode = 0
}
catch {
    Write-Host "REVEX UI + Docs refresh stopped: $($_.Exception.Message)" -ForegroundColor Red
    $ExitCode = 1
}
finally {
    Write-Host "Press Enter to close."
    [void](Read-Host)
}

exit $ExitCode
