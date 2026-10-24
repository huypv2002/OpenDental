@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\windows\recall-scheduler.ps1" -AppDir "%~dp0." -Mode off
set "RESULT=%errorlevel%"
pause
exit /b %RESULT%
