@echo off
setlocal
title REVEX 0.8.19 r49 production publisher
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0PUBLISH_REVEX_R49.ps1"
set "REVEX_EXIT=%ERRORLEVEL%"
if not "%REVEX_EXIT%"=="0" goto :done
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0FINALIZE_REVEX_R49_REVIEW_HOTFIX.ps1" -NoPause
set "REVEX_EXIT=%ERRORLEVEL%"
:done
endlocal & exit /b %REVEX_EXIT%
