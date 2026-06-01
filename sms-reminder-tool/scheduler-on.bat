@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="run" goto :run
if /i "%~1"=="enable-login" goto :enable_login
if /i "%~1"=="lock" goto :lock

rem Run this file as Administrator.
rem Edit these times as needed. Use 24-hour HH:MM format.
set "ENABLE_LOGIN_TIME=08:59"
set "RESTART_TIME=09:00"
set "START_TOOL_TIME=10:55"
set "LOCK_TIME=11:05"

set "TASK_PREFIX=LUK Dental SMS"
set "THIS_FILE=%~f0"
set "AUTOLOGON_EXE=%~dp0Autologon64.exe"
set "SETUP_SCRIPT=%~dp0setup-scheduler-tasks.ps1"
set "START_REMINDER_FLAG=%~dp0scheduler-start-reminder.flag"
set "START_HOLIDAY_FLAG=%~dp0scheduler-start-holiday.flag"
set "START_TREATMENT_FLAG=%~dp0scheduler-start-treatment.flag"

echo Creating LUK Dental SMS scheduled tasks...
echo.
echo IMPORTANT:
echo - This setup needs Microsoft Sysinternals Autologon64.exe in this folder.
echo - Auto-login needs the real Windows PASSWORD, not the Windows Hello PIN.
echo - The password is NOT saved in this .bat file.
echo - Autologon stores it using Windows/Sysinternals secure storage.
echo - Daily flow: enable auto-login, restart, open Phone Link/tool, then disable auto-login and lock.
echo.

net session >nul 2>nul
if errorlevel 1 (
  echo This file must be run as Administrator.
  echo Right-click scheduler-on.bat and choose "Run as administrator".
  pause
  exit /b 1
)

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

if not exist "%SETUP_SCRIPT%" (
  echo Missing: %SETUP_SCRIPT%
  echo Please make sure setup-scheduler-tasks.ps1 is in this same folder.
  pause
  exit /b 1
)

set /p "AUTO_USER=Windows username for auto-login [press Enter for %USERNAME%]: "
if "%AUTO_USER%"=="" set "AUTO_USER=%USERNAME%"
set /p "AUTO_DOMAIN=Computer/domain name [press Enter for %COMPUTERNAME%]: "
if "%AUTO_DOMAIN%"=="" set "AUTO_DOMAIN=%COMPUTERNAME%"
set /p "START_REMINDER_CHOICE=Auto start Appointment Reminder monitoring when the tool opens? [Y/n]: "
if /i "%START_REMINDER_CHOICE%"=="n" (
  > "%START_REMINDER_FLAG%" echo 0
) else (
  > "%START_REMINDER_FLAG%" echo 1
)
set /p "START_HOLIDAY_CHOICE=Auto start Holiday/Birthday monitoring when the tool opens? [Y/n]: "
if /i "%START_HOLIDAY_CHOICE%"=="n" (
  > "%START_HOLIDAY_FLAG%" echo 0
) else (
  > "%START_HOLIDAY_FLAG%" echo 1
)
set /p "START_TREATMENT_CHOICE=Auto start Treatment monitoring when the tool opens? [Y/n]: "
if /i "%START_TREATMENT_CHOICE%"=="n" (
  > "%START_TREATMENT_FLAG%" echo 0
) else (
  > "%START_TREATMENT_FLAG%" echo 1
)

rem Remove old tasks before recreating them.
schtasks /Delete /TN "%TASK_PREFIX% - Screen Off" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Start Monitoring" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Lock Screen" /F >nul 2>nul

schtasks /Create /TN "%TASK_PREFIX% - Enable Auto Login" /SC DAILY /ST %ENABLE_LOGIN_TIME% /TR "\"%THIS_FILE%\" enable-login" /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Daily Restart" /SC DAILY /ST %RESTART_TIME% /TR "shutdown.exe /r /t 0" /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 goto :error

powershell -NoProfile -ExecutionPolicy Bypass -File "%SETUP_SCRIPT%" -AutoUser "%AUTO_USER%" -AutoDomain "%AUTO_DOMAIN%" -AutologonExe "%AUTOLOGON_EXE%" -TaskPrefix "%TASK_PREFIX%" -ThisFile "%THIS_FILE%" -StartToolTime "%START_TOOL_TIME%" -LockTime "%LOCK_TIME%"
if errorlevel 1 goto :error

rem Keep the credential stored by Autologon, but require login outside the morning automation window.
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f >nul
if errorlevel 1 goto :error

echo.
echo Done. Tasks enabled:
schtasks /Query /TN "%TASK_PREFIX% - Enable Auto Login"
schtasks /Query /TN "%TASK_PREFIX% - Daily Restart"
schtasks /Query /TN "%TASK_PREFIX% - Start Monitoring"
schtasks /Query /TN "%TASK_PREFIX% - Lock Screen"
echo.
pause
exit /b 0

:error
echo.
echo Failed to create one or more tasks. Please run this file as Administrator and use the real Windows password, not PIN.
pause
exit /b 1

:run
rem Scheduler entrypoint: open Phone Link, then open tool and auto Start Monitoring.
rem Keep one SMS tool instance only. This avoids duplicate monitoring batches.
set "RUN_LOG=%~dp0scheduler-run.log"
echo [%date% %time%] Start Monitoring task started. >> "%RUN_LOG%"
whoami >> "%RUN_LOG%" 2>&1
echo Working folder: %CD% >> "%RUN_LOG%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*sms_reminder_app.py*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }" >nul 2>nul

echo [%date% %time%] Opening Phone Link. >> "%RUN_LOG%"
start "" explorer.exe shell:AppsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App
timeout /t 15 /nobreak >nul

if not exist ".venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  python -m venv .venv
)

call ".venv\Scripts\activate.bat"
python -m pip install -r requirements.txt >> "%RUN_LOG%" 2>&1

if not exist "sms_config.json" (
  copy "config.example.json" "sms_config.json" >nul
)

echo [%date% %time%] Starting SMS reminder app. >> "%RUN_LOG%"
set "MONITORING_ARGS="
set "AUTO_START_REMINDER=1"
set "AUTO_START_HOLIDAY=1"
set "AUTO_START_TREATMENT=1"
if exist "%START_REMINDER_FLAG%" (
  set /p "AUTO_START_REMINDER="<"%START_REMINDER_FLAG%"
)
if exist "%START_HOLIDAY_FLAG%" (
  set /p "AUTO_START_HOLIDAY="<"%START_HOLIDAY_FLAG%"
)
if exist "%START_TREATMENT_FLAG%" (
  set /p "AUTO_START_TREATMENT="<"%START_TREATMENT_FLAG%"
)
if not "%AUTO_START_REMINDER%"=="0" (
  set "MONITORING_ARGS=%MONITORING_ARGS% --start-reminder-monitoring"
)
if not "%AUTO_START_HOLIDAY%"=="0" (
  set "MONITORING_ARGS=%MONITORING_ARGS% --start-holiday-monitoring"
)
if not "%AUTO_START_TREATMENT%"=="0" (
  set "MONITORING_ARGS=%MONITORING_ARGS% --start-treatment-monitoring"
)
echo [%date% %time%] Monitoring args:%MONITORING_ARGS% >> "%RUN_LOG%"
python sms_reminder_app.py %MONITORING_ARGS% >> "%RUN_LOG%" 2>&1
echo [%date% %time%] SMS reminder app exited with code %errorlevel%. >> "%RUN_LOG%"
exit /b %errorlevel%

:enable_login
rem Enable auto-login shortly before the daily restart.
set "RUN_LOG=%~dp0scheduler-run.log"
echo [%date% %time%] Enable Auto Login task started. >> "%RUN_LOG%"
whoami >> "%RUN_LOG%" 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 1 /f >nul
echo [%date% %time%] Enable Auto Login exited with code %errorlevel%. >> "%RUN_LOG%"
exit /b %errorlevel%

:lock
rem Disable auto-login after the SMS window, then lock the desktop.
set "RUN_LOG=%~dp0scheduler-run.log"
echo [%date% %time%] Lock Screen task started. >> "%RUN_LOG%"
whoami >> "%RUN_LOG%" 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f >nul
rundll32.exe user32.dll,LockWorkStation
echo [%date% %time%] Lock Screen command sent. >> "%RUN_LOG%"
exit /b 0
