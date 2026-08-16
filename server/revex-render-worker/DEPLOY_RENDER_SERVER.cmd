@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0DEPLOY_RENDER_SERVER.ps1"
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo REVEX render deployment exited with code %CODE%.
)
exit /b %CODE%
