@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORK=%TEMP%\REVEX-Observer-Access-%RANDOM%-%RANDOM%"
set "REPO=https://github.com/nvberegovykh/LIBER-Creative.git"
set "CODE=1"

echo REVEX Observer AI public-transport repair
echo This does NOT rebuild functions or touch Energy, Render, Revit, rules, or project content.
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

echo Current main: !SHA!
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WORK%\server\firebase-functions\REPAIR_OBSERVER_AGENT_PUBLIC_ACCESS.ps1" -NoPause
set "CODE=!ERRORLEVEL!"

:cleanup
rmdir /s /q "%WORK%" >nul 2>&1

:finish
echo.
if "%CODE%"=="0" (
  echo PASS: REVEX Observer AI public transport and smoke test completed.
  echo Counter: https://liberpict.com/ai/
) else (
  echo REVEX Observer AI public-transport repair exited with code %CODE%.
)
echo.
echo Press any key to close.
pause >nul
exit /b %CODE%
