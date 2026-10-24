@echo off
setlocal
cd /d "%~dp0"
set "RECALL_START_TOOL_TIME=10:55"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\windows\recall-scheduler.ps1" -AppDir "%~dp0." -Mode on -StartTool "%RECALL_START_TOOL_TIME%"
set "RESULT=%errorlevel%"
pause
exit /b %RESULT%
