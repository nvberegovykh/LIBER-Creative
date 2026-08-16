@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORK=%TEMP%\REVEX-Energy-Broker-%RANDOM%-%RANDOM%"
set "REPO=https://github.com/nvberegovykh/LIBER-Creative.git"

echo REVEX Energy broker-only resume
echo This does NOT rerun Revit, rebuild the Energy worker, or touch the renderer.
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git is required.
  set "CODE=1"
  goto :finish
)

echo ^>^> Clone exact current GitHub main
git clone --depth 1 --branch main --single-branch "%REPO%" "%WORK%"
if errorlevel 1 (
  set "CODE=1"
  goto :cleanup
)

for /f "usebackq delims=" %%S in (`git -C "%WORK%" rev-parse HEAD`) do set "SHA=%%S"
if not defined SHA (
  echo ERROR: Could not resolve current main SHA.
  set "CODE=1"
  goto :cleanup
)

echo Current source candidate: !SHA!
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WORK%\server\revex-energy-worker\DEPLOY_ENERGY_BROKER_ONLY_R77.ps1" -SourceCandidate "!SHA!" -NoPause
set "CODE=!ERRORLEVEL!"

:cleanup
rmdir /s /q "%WORK%" >nul 2>&1

:finish
echo.
if "%CODE%"=="0" (
  echo PASS: runRevexEnergy broker-only resume deployment completed.
  echo Return to REVEX Companion and authorize/resume the preserved Engineering revision.
) else (
  echo REVEX Energy broker-only resume exited with code %CODE%.
)
echo.
echo Press any key to close.
pause >nul
exit /b %CODE%
