@echo off
setlocal
cd /d "%~dp0"

set "APP_EXE=%~dp0LUK Dental SMS Reminder Tool.exe"
if exist "%APP_EXE%" (
  if not exist "sms_config.json" (
    if exist "config.example.json" copy "config.example.json" "sms_config.json" >nul
  )
  "%APP_EXE%"
  exit /b %errorlevel%
)

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

if not exist "sms_config.json" (
  copy "config.example.json" "sms_config.json" >nul
)

python sms_reminder_app.py
