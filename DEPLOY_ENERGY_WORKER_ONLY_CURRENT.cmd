@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORK=%TEMP%\REVEX-Energy-Current-%RANDOM%-%RANDOM%"
set "REPO=https://github.com/nvberegovykh/LIBER-Creative.git"
set "CODE=1"

echo REVEX current Energy-only deployment
echo Scope: exact GitHub main Energy worker + authenticated Energy broker binding only.
echo Revit add-in, Companion UI, Render, Report, access rules and project evidence are not deployed here.
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git is required.
  goto :finish
)

echo ^>^> Clone exact current GitHub main
git clone --depth 1 --branch main --single-branch "%REPO%" "%WORK%"
if errorlevel 1 goto :cleanup

for /f "usebackq delims=" %%S in (`git -C "%WORK%" rev-parse HEAD`) do set "SHA=%%S"
if not defined SHA (
  echo ERROR: Could not resolve current main SHA.
  goto :cleanup
)

echo Exact Energy source candidate: !SHA!
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WORK%\server\revex-energy-worker\deploy-current.ps1" -SourceCandidate "!SHA!" -NoPause
set "CODE=!ERRORLEVEL!"

:cleanup
rmdir /s /q "%WORK%" >nul 2>&1

:finish
echo.
if "%CODE%"=="0" (
  echo PASS: current Energy worker and broker binding deployed.
  echo The preserved immutable Engineering revision can now be retried; no new Revit extraction is required.
) else (
  echo REVEX current Energy deployment exited with code %CODE%.
)
echo.
exit /b %CODE%
