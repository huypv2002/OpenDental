@echo off
setlocal

set "TASK_PREFIX=LUK Dental SMS"

echo Removing LUK Dental SMS scheduled tasks...
schtasks /Delete /TN "%TASK_PREFIX% - Enable Auto Login" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Daily Restart" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Start Monitoring" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Lock Screen" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Screen Off" /F >nul 2>nul

echo Disabling Windows auto-login from older scheduler versions...
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f >nul 2>nul

echo Done. The scheduler tasks are now off.
pause
