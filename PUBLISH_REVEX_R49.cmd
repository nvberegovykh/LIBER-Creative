@echo off
setlocal
title REVEX 0.8.19 r49 production publisher
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0PUBLISH_REVEX_R49.ps1"
set "REVEX_EXIT=%ERRORLEVEL%"
endlocal & exit /b %REVEX_EXIT%
