@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m pip install --user -r requirements.txt
  py -3 OpenStudio_Energy_Model_Geometry_Compiler.py --gui
) else (
  python -m pip install --user -r requirements.txt
  python OpenStudio_Energy_Model_Geometry_Compiler.py --gui
)
if errorlevel 1 pause
