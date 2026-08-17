@echo off
setlocal EnableExtensions

set "HOSTSHA=627d82bda09120e2f48032d69cfbac698d2cf1e7"
set "PS1=%TEMP%\RUN_REVEX_R118_ENERGY_FIX_NOW_%RANDOM%_%RANDOM%.ps1"
set "URL=https://raw.githubusercontent.com/nvberegovykh/LIBER-Creative/%HOSTSHA%/RUN_REVEX_R118_ENERGY_FIX_NOW.ps1"

echo REVEX r118 Energy recovery launcher
echo PowerShell host: %HOSTSHA%
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%PS1%'; if((Get-Item -LiteralPath '%PS1%').Length -lt 1000){throw 'Downloaded REVEX recovery host is incomplete.'}"
if errorlevel 1 (
  echo.
  echo ERROR: Could not download the r118 recovery host.
  echo Nothing was changed.
  echo Press Enter to close.
  pause >nul
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "CODE=%ERRORLEVEL%"
del /q "%PS1%" >nul 2>&1

echo.
if "%CODE%"=="0" (
  echo PASS: r118 recovery host completed.
) else (
  echo REVEX r118 recovery host exited with code %CODE%.
)
echo Press Enter to close.
pause >nul
exit /b %CODE%
