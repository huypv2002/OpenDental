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
set "AUTOLOGON_EXE=%~dp0Autologon64.exe"

echo Creating LUK Dental SMS scheduled tasks...
echo.
echo IMPORTANT:
echo - This setup needs Microsoft Sysinternals Autologon64.exe in this folder.
echo - The password is NOT saved in this .bat file.
echo - Autologon stores it using Windows/Sysinternals secure storage.
echo - Phone Link SMS automation needs an unlocked desktop session after restart.
echo.

if not exist "%AUTOLOGON_EXE%" (
  echo Missing: %AUTOLOGON_EXE%
  echo.
  echo Download Microsoft Sysinternals Autologon:
  echo https://learn.microsoft.com/sysinternals/downloads/autologon
  echo.
  echo Extract Autologon64.exe into this same sms-reminder-tool folder, then run scheduler-on.bat again as Administrator.
  pause
  exit /b 1
)

set /p "AUTO_USER=Windows username for auto-login: "
set /p "AUTO_DOMAIN=Computer/domain name [press Enter for %COMPUTERNAME%]: "
if "%AUTO_DOMAIN%"=="" set "AUTO_DOMAIN=%COMPUTERNAME%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$password = Read-Host 'Windows password for auto-login' -AsSecureString; $plain = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)); Start-Process -FilePath '%AUTOLOGON_EXE%' -ArgumentList @('%AUTO_USER%','%AUTO_DOMAIN%',$plain) -Wait; $plain = $null"
if errorlevel 1 goto :error

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
