@echo off
setlocal
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found. Skipping update and opening the app.
) else (
  echo Updating OpenDental repository...
  git -C "%~dp0.." pull --ff-only
  if errorlevel 1 (
    echo.
    echo WARNING: git pull failed. Opening the app with the current local version.
    echo.
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  python -m venv .venv
)

call ".venv\Scripts\activate.bat"
python -m pip install -r requirements.txt

if not exist "audit_config.json" (
  copy "config.example.json" "audit_config.json" >nul
)

python audit_trail_app.py
