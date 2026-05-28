@echo off
setlocal

rem Run this file as Administrator.
set "TASK_PREFIX=LUK Dental SMS"
set "AUTOLOGON_EXE=%~dp0Autologon64.exe"

echo Removing LUK Dental SMS scheduled tasks...
schtasks /Delete /TN "%TASK_PREFIX% - Enable Auto Login" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Daily Restart" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Start Monitoring" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Lock Screen" /F >nul 2>nul

echo Disabling Windows auto-login...
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f >nul 2>nul

echo Done. The scheduler tasks are now off.
pause
