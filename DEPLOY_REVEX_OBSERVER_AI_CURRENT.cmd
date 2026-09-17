@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORK=%TEMP%\REVEX-Observer-AI-%RANDOM%-%RANDOM%"
set "REPO=https://github.com/nvberegovykh/LIBER-Creative.git"
set "CODE=1"

echo REVEX Observer AI live deployment
echo.
echo Scope:
echo   - deploy public AI counter / claim / MCP / Pair AI broker functions
echo   - preserve Energy worker, renderer, Revit model and project data
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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WORK%\server\firebase-functions\DEPLOY_OBSERVER_AGENT_CURRENT.ps1" -SourceCandidate "!SHA!" -NoPause
set "CODE=!ERRORLEVEL!"

:cleanup
rmdir /s /q "%WORK%" >nul 2>&1

:finish
echo.
if "%CODE%"=="0" (
  echo PASS: REVEX Observer AI live deployment completed.
  echo Public counter: https://liberpict.com/ai/
  echo Authorized project access: REVEX ^> select project ^> Pair AI.
) else (
  echo REVEX Observer AI deployment exited with code %CODE%.
)
echo.
echo Press any key to close.
pause >nul
exit /b %CODE%
