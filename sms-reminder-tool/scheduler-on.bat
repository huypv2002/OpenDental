@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="run" goto :run
if /i "%~1"=="screen-off" goto :screen_off

rem Run this file as Administrator.
rem Edit these times as needed. Use 24-hour HH:MM format.
set "START_TOOL_TIME=10:55"
set "SCREEN_OFF_TIME=11:05"

set "TASK_PREFIX=LUK Dental SMS"
set "THIS_FILE=%~f0"

echo Creating LUK Dental SMS scheduled tasks...
echo.
echo IMPORTANT:
echo - This version does NOT restart Windows.
echo - Keep the Windows user session logged in.
echo - DeskIn/TeamViewer can keep running in the background.
echo - At %START_TOOL_TIME%, it opens Phone Link and starts SMS monitoring.
echo - At %SCREEN_OFF_TIME%, it turns off the display only; it does not lock Windows.
echo.

net session >nul 2>nul
if errorlevel 1 (
  echo This file must be run as Administrator.
  echo Right-click scheduler-on.bat and choose "Run as administrator".
  pause
  exit /b 1
)

rem Make sure old restart/autologon tasks from previous versions are removed.
schtasks /Delete /TN "%TASK_PREFIX% - Enable Auto Login" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Daily Restart" /F >nul 2>nul
schtasks /Delete /TN "%TASK_PREFIX% - Lock Screen" /F >nul 2>nul
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f >nul 2>nul

schtasks /Create /TN "%TASK_PREFIX% - Start Monitoring" /SC DAILY /ST %START_TOOL_TIME% /TR "\"%THIS_FILE%\" run" /RL HIGHEST /F
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Screen Off" /SC DAILY /ST %SCREEN_OFF_TIME% /TR "\"%THIS_FILE%\" screen-off" /RL HIGHEST /F
if errorlevel 1 goto :error

echo.
echo Done. Tasks enabled:
schtasks /Query /TN "%TASK_PREFIX% - Start Monitoring"
schtasks /Query /TN "%TASK_PREFIX% - Screen Off"
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

:screen_off
rem Turn off display without locking Windows. Remote tools stay available.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DisplayPower { [DllImport(\"user32.dll\")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam); }'; [DisplayPower]::SendMessage([IntPtr]0xffff, 0x0112, [IntPtr]0xF170, [IntPtr]2) | Out-Null"
exit /b 0
