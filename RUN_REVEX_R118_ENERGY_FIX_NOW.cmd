@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SHA=811d1e8039db26a4221112041df7b8d8eb58d9c1"
set "REPO=https://github.com/nvberegovykh/LIBER-Creative.git"
set "WORK=%TEMP%\REVEX-R118-%RANDOM%-%RANDOM%"
set "CODE=1"

echo REVEX r118 Energy fix - approved same-envelope reference
echo Exact source: %SHA%
echo Target revision after deployment: eng_20260817T032812010Z
echo.
echo This updates ONLY the managed Energy worker + authenticated broker.
echo It does NOT Sync Engineering, rerun Revit/Dynamo, update the add-in,
echo change BIM/Docs/Render, or use a prior 250 Midwood CXL as thermal authority.
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git is required.
  goto :finish
)
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: Windows PowerShell is required.
  goto :finish
)

echo ^>^> Fetch exact r118 source
git init "%WORK%" >nul 2>&1
if errorlevel 1 goto :cleanup
git -C "%WORK%" remote add origin "%REPO%" >nul 2>&1
if errorlevel 1 goto :cleanup
git -C "%WORK%" fetch --depth 1 origin %SHA%
if errorlevel 1 goto :cleanup
git -C "%WORK%" checkout --detach FETCH_HEAD >nul 2>&1
if errorlevel 1 goto :cleanup
for /f "usebackq delims=" %%S in (`git -C "%WORK%" rev-parse HEAD`) do set "CHECKED=%%S"
if /I not "!CHECKED!"=="%SHA%" (
  echo ERROR: exact-source checkout mismatch.
  goto :cleanup
)

echo ^>^> Deploy r118 worker + broker from exact source
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WORK%\server\revex-energy-worker\DEPLOY_ENERGY_CURRENT.ps1" -SourceCandidate "%SHA%" -NoPause
set "CODE=!ERRORLEVEL!"
if not "!CODE!"=="0" goto :cleanup

echo.
echo PASS: r118 managed Energy edge is deployed from %SHA%.
echo No new Engineering Sync is required.
echo Keep/retry EXACT revision eng_20260817T032812010Z.
echo The accidental eng_20260817T162427560Z revision remains evidence-only.
echo.
echo Opening the existing 250 Midwood Energy workspace...
start "" "https://liberpict.com/liber-apps/apps/revex/index.html?projectId=revex_mspgzb7h_729b2936bfaa&specProjectId=spec_revex_mspgzb7h_729b2936bfaa&view=energy"

:cleanup
rmdir /s /q "%WORK%" >nul 2>&1

:finish
echo.
if "%CODE%"=="0" (
  echo NEXT: on the already displayed eng_20260817T032812010Z card, click Authorize this revision once.
  echo r116/r118 will replay that immutable revision downstream without Revit.
) else (
  echo REVEX r118 Energy deployment stopped with code %CODE%.
  echo Nothing in Revit or the immutable Engineering revision was replaced.
)
echo.
echo Press any key to close.
pause >nul
exit /b %CODE%
