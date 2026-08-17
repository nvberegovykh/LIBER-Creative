@echo off
setlocal EnableExtensions
set "REVEX_RECOVERY_PS1=%TEMP%\REVEX-ENERGY-RECOVERY-%RANDOM%-%RANDOM%.ps1"

echo REVEX Energy single-shot recovery
echo Refreshing the recovery controller from GitHub main...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/RECOVER_REVEX_ENERGY_CURRENT.ps1' -OutFile '%REVEX_RECOVERY_PS1%'"
if errorlevel 1 (
  echo.
  echo REVEX could not download the current Energy recovery controller. Nothing was changed.
  set "CODE=1"
  goto :finish
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REVEX_RECOVERY_PS1%"
set "CODE=%ERRORLEVEL%"

:finish
del /q "%REVEX_RECOVERY_PS1%" >nul 2>&1
echo.
if "%CODE%"=="0" (
  echo PASS: REVEX Energy recovery and add-in update completed.
  echo Follow the revision-aware Retry vs SYNC ENGINEERING instruction printed above.
) else (
  echo REVEX Energy recovery exited with code %CODE%.
)
echo.
echo Press any key to close this window.
pause >nul
exit /b %CODE%
