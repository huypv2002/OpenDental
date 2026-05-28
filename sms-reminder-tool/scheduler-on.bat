@echo off
setlocal

rem Run this file as Administrator.
rem Edit these times as needed. Use 24-hour HH:MM format.
set "RESTART_TIME=09:00"
set "START_TOOL_TIME=10:55"
set "LOCK_TIME=11:05"

set "TASK_PREFIX=LUK Dental SMS"
set "TOOL_DIR=%~dp0"
set "MONITOR_BAT=%TOOL_DIR%run-sms-reminder-monitoring.bat"

echo Creating LUK Dental SMS scheduled tasks...
echo.
echo IMPORTANT:
echo - Auto-login is not stored in this script for security.
echo - Configure Windows auto-login separately if the machine must restart unattended.
echo - Phone Link SMS automation needs an unlocked desktop session.
echo.

schtasks /Create /TN "%TASK_PREFIX% - Daily Restart" /SC DAILY /ST %RESTART_TIME% /TR "shutdown.exe /r /t 0" /RL HIGHEST /F
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Start Monitoring" /SC DAILY /ST %START_TOOL_TIME% /TR "\"%MONITOR_BAT%\"" /RL HIGHEST /F
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
