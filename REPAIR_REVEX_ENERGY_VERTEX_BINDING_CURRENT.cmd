@echo off
setlocal EnableExtensions
set "TMPPS=%TEMP%\REVEX-VERTEX-BINDING-%RANDOM%-%RANDOM%.ps1"
set "URL=https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/REPAIR_REVEX_ENERGY_VERTEX_BINDING_CURRENT.ps1"

echo REVEX Energy Vertex binding repair
echo No worker image rebuild. No broker deployment. No Revit export. No renderer.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%TMPPS%'; if(-not(Test-Path -LiteralPath '%TMPPS%')){exit 2}"
if errorlevel 1 (
  echo ERROR: Could not fetch the current repair script.
  del /q "%TMPPS%" >nul 2>&1
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TMPPS%"
set "CODE=%ERRORLEVEL%"
del /q "%TMPPS%" >nul 2>&1

echo.
if "%CODE%"=="0" (
  echo PASS: Vertex project binding repaired without rebuilding the Energy worker.
) else (
  echo FAIL: Vertex project binding repair exited with code %CODE%.
)
echo.
pause
exit /b %CODE%
