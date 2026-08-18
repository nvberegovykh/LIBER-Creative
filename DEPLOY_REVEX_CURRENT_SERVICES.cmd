@echo off
setlocal EnableExtensions
set "REVEX_DEPLOY_PS1=%TEMP%\REVEX-CURRENT-SERVICES-%RANDOM%-%RANDOM%.ps1"
set "CODE=1"

echo REVEX current r126 managed-services deployment
echo Refreshing the deployment controller itself from GitHub main...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/DEPLOY_REVEX_CURRENT_SERVICES.ps1' -OutFile '%REVEX_DEPLOY_PS1%'"
if errorlevel 1 (
  echo.
  echo REVEX could not download the current managed-services controller.
  echo No cloud service was changed by this launcher.
  set "CODE=1"
  goto :finish
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REVEX_DEPLOY_PS1%"
set "CODE=%ERRORLEVEL%"

:finish
del /q "%REVEX_DEPLOY_PS1%" >nul 2>&1
echo.
if "%CODE%"=="0" (
  echo PASS: REVEX current r126 Report/Render deployment completed.
  echo Energy was not changed by the current finalization path.
) else (
  echo REVEX current managed-services deployment exited with code %CODE%.
  echo See DEPLOY_REVEX_CURRENT_SERVICES.latest.log beside the current controller when available.
)
echo.
echo Press any key to close this window.
pause >nul
exit /b %CODE%
