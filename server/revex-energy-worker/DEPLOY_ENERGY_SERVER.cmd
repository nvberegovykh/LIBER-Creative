@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0DEPLOY_ENERGY_SERVER.ps1" %*
exit /b %errorlevel%
