@echo off
setlocal EnableExtensions

echo REVEX current Energy worker-only deployment
echo This updates only revex-energy-worker from exact GitHub main.
echo Existing broker, renderer, Revit add-in and project evidence are preserved.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DEPLOY_REVEX_CURRENT_SERVICES.ps1" -EnergyWorkerOnly
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
  echo PASS: REVEX Energy worker-only deployment completed.
) else (
  echo REVEX Energy worker-only deployment exited with code %CODE%.
  echo See DEPLOY_REVEX_CURRENT_SERVICES.latest.log in this folder.
)
echo.
echo Press any key to close.
pause >nul
exit /b %CODE%
