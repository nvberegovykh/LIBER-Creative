@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "MODE=%~1"
if "%MODE%"=="" set "MODE=APPLY"
if /I not "%MODE%"=="AUDIT" if /I not "%MODE%"=="APPLY" (
  echo Usage: %~nx0 [AUDIT^|APPLY]
  exit /b 2
)

set "WORK=%TEMP%\LIBER-Observer-Public-%RANDOM%-%RANDOM%"
echo === REVEX Observer public Firebase launcher ===
echo Mode: %MODE%
echo.

where git >nul 2>&1 || (
  echo ERROR: git is not installed or not on PATH.
  exit /b 1
)

echo ^>^> Clone exact current GitHub main
git clone --filter=blob:none --depth 1 https://github.com/nvberegovykh/LIBER-Creative.git "%WORK%"
if errorlevel 1 goto fail

for /f %%H in ('git -C "%WORK%" rev-parse HEAD') do set "SHA=%%H"
echo Current main: !SHA!
echo.

call "%WORK%\DEPLOY_OBSERVER_PUBLIC_FIREBASE_CURRENT.cmd" "%MODE%"
set "CODE=!ERRORLEVEL!"
goto cleanup

:fail
set "CODE=1"

:cleanup
if exist "%WORK%" rmdir /s /q "%WORK%" >nul 2>&1
echo.
if not "%CODE%"=="0" echo Observer public Firebase launcher exited with code %CODE%.
if "%CODE%"=="0" echo Observer public Firebase launcher completed.
exit /b %CODE%
