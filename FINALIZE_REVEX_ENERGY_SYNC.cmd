@echo off
setlocal EnableExtensions
set "REVEX_FINAL_PS1=%TEMP%\REVEX-FINAL-ENERGY-SYNC-%RANDOM%-%RANDOM%.ps1"
set "CODE=1"

echo REVEX FINAL ENERGY + SYNC
echo One controller. Same source for Energy and Revit. Missing VT = 0.45.
echo Refreshing controller from GitHub main...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/FINALIZE_REVEX_ENERGY_SYNC.ps1' -OutFile '%REVEX_FINAL_PS1%'"
if errorlevel 1 (
  echo.
  echo Could not download the current final controller. Nothing was changed.
  goto :finish
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REVEX_FINAL_PS1%"
set "CODE=%ERRORLEVEL%"

:finish
del /q "%REVEX_FINAL_PS1%" >nul 2>&1
echo.
if "%CODE%"=="0" (
  echo PASS: Energy and Revit Sync are aligned. Reopen Revit and run SYNC ENGINEERING once.
) else (
  echo REVEX final Energy + Sync controller exited with code %CODE%.
  echo See %%LOCALAPPDATA%%\LIBER\REVEX\Logs\FINALIZE_REVEX_ENERGY_SYNC.latest.log
)
echo.
echo Press any key to close this window.
pause >nul
exit /b %CODE%
