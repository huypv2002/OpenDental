@echo off
setlocal
cd /d "%~dp0"

rem Keep one SMS tool instance only. This avoids duplicate monitoring batches.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*sms_reminder_app.py*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }" >nul 2>nul

if not exist ".venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  python -m venv .venv
)

call ".venv\Scripts\activate.bat"
python -m pip install -r requirements.txt

if not exist "sms_config.json" (
  copy "config.example.json" "sms_config.json" >nul
)

python sms_reminder_app.py --start-monitoring
