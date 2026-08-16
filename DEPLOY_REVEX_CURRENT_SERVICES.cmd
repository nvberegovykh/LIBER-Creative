@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DEPLOY_REVEX_CURRENT_SERVICES.ps1"
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo REVEX current managed-services deployment exited with code %CODE%.
  echo The window will stay open so the failure can be read.
  pause
)
exit /b %CODE%
