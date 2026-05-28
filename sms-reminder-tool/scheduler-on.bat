@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="run" goto :run

rem Run this file as Administrator.
rem Edit these times as needed. Use 24-hour HH:MM format.
set "RESTART_TIME=09:00"
set "START_TOOL_TIME=10:55"
set "LOCK_TIME=11:05"

set "TASK_PREFIX=LUK Dental SMS"
set "THIS_FILE=%~f0"

echo Creating LUK Dental SMS scheduled tasks...
echo.
echo IMPORTANT:
echo - Auto-login is not stored in this script for security.
echo - Configure Windows auto-login separately if the machine must restart unattended.
echo - Phone Link SMS automation needs an unlocked desktop session after restart.
echo.

schtasks /Create /TN "%TASK_PREFIX% - Daily Restart" /SC DAILY /ST %RESTART_TIME% /TR "shutdown.exe /r /t 0" /RL HIGHEST /F
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Start Monitoring" /SC DAILY /ST %START_TOOL_TIME% /TR "\"%THIS_FILE%\" run" /RL HIGHEST /F
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Lock Screen" /SC DAILY /ST %LOCK_TIME% /TR "rundll32.exe user32.dll,LockWorkStation" /RL HIGHEST /F
if errorlevel 1 goto :error

echo.
echo Done. Tasks enabled:
schtasks /Query /TN "%TASK_PREFIX% - Daily Restart"
schtasks /Query /TN "%TASK_PREFIX% - Start Monitoring"
schtasks /Query /TN "%TASK_PREFIX% - Lock Screen"
echo.
pause
exit /b 0

:error
echo.
echo Failed to create one or more tasks. Please run this file as Administrator.
pause
exit /b 1

:run
rem Scheduler entrypoint: open Phone Link, then open tool and auto Start Monitoring.
rem Keep one SMS tool instance only. This avoids duplicate monitoring batches.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*sms_reminder_app.py*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }" >nul 2>nul

start "" explorer.exe shell:AppsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App
timeout /t 15 /nobreak >nul

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
exit /b %errorlevel%
