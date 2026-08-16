@echo off
setlocal EnableExtensions
set "REVEX_UPDATE_PS1=%TEMP%\REVEX-CURRENT-ADDIN-%RANDOM%-%RANDOM%.ps1"

echo REVEX current-main add-in updater
echo Refreshing the updater itself from GitHub main...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/UPDATE_REVEX_ADDIN_CURRENT.ps1' -OutFile '%REVEX_UPDATE_PS1%'"
if errorlevel 1 (
  echo.
  echo REVEX could not download the current add-in updater. No installed files were changed.
  set "CODE=1"
  goto :finish
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REVEX_UPDATE_PS1%"
set "CODE=%ERRORLEVEL%"

:finish
del /q "%REVEX_UPDATE_PS1%" >nul 2>&1
echo.
if "%CODE%"=="0" (
  echo PASS: REVEX current add-in update completed. Reopen Revit 2026.
) else (
  echo REVEX current add-in update exited with code %CODE%.
  echo See %%LOCALAPPDATA%%\LIBER\REVEX\Logs\UPDATE_REVEX_ADDIN_CURRENT.latest.log
)
echo.
echo Press any key to close this window.
pause >nul
exit /b %CODE%
