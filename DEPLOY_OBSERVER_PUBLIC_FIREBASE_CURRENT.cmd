@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "MODE=%~1"
if /I "%MODE%"=="APPLY" goto run
if /I "%MODE%"=="AUDIT" goto run
if "%MODE%"=="" set "MODE=AUDIT"
if /I not "%MODE%"=="AUDIT" if /I not "%MODE%"=="APPLY" (
  echo Usage: %~nx0 [AUDIT^|APPLY]
  exit /b 2
)

:run
echo === LIBER Observer public Firebase Hosting patch ===
echo Mode: %MODE%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DEPLOY_OBSERVER_PUBLIC_FIREBASE_CURRENT.ps1" -Mode "%MODE%"
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo FAILED with exit code %CODE%.
if "%CODE%"=="0" echo COMPLETED.
exit /b %CODE%
