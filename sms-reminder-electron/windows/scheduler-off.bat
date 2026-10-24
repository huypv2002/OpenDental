@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>nul
if errorlevel 1 (
  echo Right-click scheduler-off.bat and choose Run as administrator.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-scheduler-tasks.ps1" -AppDir "%~dp0." -Disable
set "RESULT=%errorlevel%"
pause
exit /b %RESULT%
