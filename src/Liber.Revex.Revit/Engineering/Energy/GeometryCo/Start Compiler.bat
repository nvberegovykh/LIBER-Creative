@echo off
setlocal
cd /d "%~dp0"
title OpenStudio Energy Model Geometry Compiler

where py >nul 2>nul
if not errorlevel 1 (
  set "PY=py -3"
  set "PYW=pyw -3"
) else (
  where python >nul 2>nul
  if errorlevel 1 goto :nopython
  set "PY=python"
  set "PYW=pythonw"
)

%PY% -c "import shapely,numpy,onnxruntime; v=tuple(int(x) for x in shapely.__version__.split('.')[:2]); assert v >= (2,1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo First run: installing the geometry and local-AI runtimes...
  echo Windows uses DirectML GPU acceleration when supported, with CPU fallback.
  %PY% -m pip install --user -r "%~dp0requirements.txt"
  if errorlevel 1 goto :installfailed
)

start "" %PYW% "%~dp0OpenStudio_Energy_Model_Geometry_Compiler.py" --gui
exit /b 0

:nopython
powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Python 3 was not found. Install Python 3 from python.org, then run Start Compiler.bat again.','OpenStudio Compiler')" >nul 2>nul
exit /b 2

:installfailed
echo.
echo Dependency installation failed. Check internet access, then run:
echo   %PY% -m pip install --user -r "%~dp0requirements.txt"
pause
exit /b 2
