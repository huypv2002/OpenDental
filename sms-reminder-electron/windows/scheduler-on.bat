@echo off
setlocal
cd /d "%~dp0"
if /i "%~1"=="run" goto run
if /i "%~1"=="enable-login" goto enable_login
if /i "%~1"=="lock" goto lock
set "ENABLE_LOGIN_TIME=08:59"
set "RESTART_TIME=09:00"
set "START_TOOL_TIME=10:55"
set "LOCK_TIME=12:05"
net session >nul 2>nul
if errorlevel 1 (
  echo Right-click scheduler-on.bat and choose Run as administrator.
  pause
  exit /b 1
)
if not exist "Autologon64.exe" (
  echo Place Microsoft Sysinternals Autologon64.exe in this folder.
  pause
  exit /b 1
)
echo Stop the old Python scheduler before enabling Electron tasks.
echo Use the real Windows password, not the Windows Hello PIN.
set /p "AUTO_USER=Windows username for auto-login [Enter for %USERNAME%]: "
if "%AUTO_USER%"=="" set "AUTO_USER=%USERNAME%"
set /p "AUTO_DOMAIN=Computer/domain name [Enter for %COMPUTERNAME%]: "
if "%AUTO_DOMAIN%"=="" set "AUTO_DOMAIN=%COMPUTERNAME%"
set /p "REMINDER_CHOICE=Auto start Appointment + 6M Recall monitoring? [Y/n]: "
set "MONITOR_OPTION="
if /i "%REMINDER_CHOICE%"=="n" set "MONITOR_OPTION=-NoMonitoring"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-scheduler-tasks.ps1" -AppDir "%~dp0." -EnableLogin "%ENABLE_LOGIN_TIME%" -Restart "%RESTART_TIME%" -StartTool "%START_TOOL_TIME%" -Lock "%LOCK_TIME%" -AutoUser "%AUTO_USER%" -AutoDomain "%AUTO_DOMAIN%" %MONITOR_OPTION%
set "RESULT=%errorlevel%"
pause
exit /b %RESULT%
:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\windows\scheduler-runtime.ps1" -Mode run -ConfigPath "%~dp0scheduler-runtime.json"
exit /b %errorlevel%
:enable_login
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\windows\scheduler-runtime.ps1" -Mode enable-login -ConfigPath "%~dp0scheduler-runtime.json"
exit /b %errorlevel%
:lock
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\windows\scheduler-runtime.ps1" -Mode lock -ConfigPath "%~dp0scheduler-runtime.json"
exit /b %errorlevel%
