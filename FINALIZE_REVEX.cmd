@echo off
setlocal EnableExtensions
set "REVEX_FINALIZER=%TEMP%\REVEX-FINALIZE-%RANDOM%-%RANDOM%.ps1"
set "CODE=1"

echo REVEX one-command current release finalizer
echo Refreshing the controller from GitHub main...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/FINALIZE_REVEX.ps1' -OutFile '%REVEX_FINALIZER%'"
if errorlevel 1 (
  echo.
  echo REVEX could not download the current finalizer. Nothing was changed.
  goto :finish
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REVEX_FINALIZER%"
set "CODE=%ERRORLEVEL%"

:finish
del /q "%REVEX_FINALIZER%" >nul 2>&1
echo.
if "%CODE%"=="0" (
  echo PASS: REVEX current release finalized from one exact source revision.
) else (
  echo REVEX finalization exited with code %CODE%.
  echo Review the persistent log shown above before retrying.
)
echo.
echo Press any key to close this window.
pause >nul
exit /b %CODE%
