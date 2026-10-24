@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\windows\r5-check.ps1" -AppDir "%~dp0."
pause
