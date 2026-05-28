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

echo Creating LUK Dental SMS scheduled tasks...
echo.
echo IMPORTANT:
echo - This setup needs Microsoft Sysinternals Autologon64.exe in this folder.
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

set /p "AUTO_USER=Windows username for auto-login [press Enter for %USERNAME%]: "
if "%AUTO_USER%"=="" set "AUTO_USER=%USERNAME%"
set /p "AUTO_DOMAIN=Computer/domain name [press Enter for %COMPUTERNAME%]: "
if "%AUTO_DOMAIN%"=="" set "AUTO_DOMAIN=%COMPUTERNAME%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$password = Read-Host 'Windows password for auto-login' -AsSecureString; $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password); try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringUni($bstr); if ([string]::IsNullOrWhiteSpace('%AUTO_USER%')) { throw 'Windows username is required.' }; if ([string]::IsNullOrEmpty($plain)) { throw 'Windows password is required.' }; Start-Process -FilePath '%AUTOLOGON_EXE%' -ArgumentList @('%AUTO_USER%','%AUTO_DOMAIN%',$plain) -Wait } finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }"
if errorlevel 1 goto :error

rem Keep the credential stored by Autologon, but require login outside the morning automation window.
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f >nul
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Enable Auto Login" /SC DAILY /ST %ENABLE_LOGIN_TIME% /TR "\"%THIS_FILE%\" enable-login" /RL HIGHEST /F
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Daily Restart" /SC DAILY /ST %RESTART_TIME% /TR "shutdown.exe /r /t 0" /RL HIGHEST /F
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Start Monitoring" /SC DAILY /ST %START_TOOL_TIME% /TR "\"%THIS_FILE%\" run" /RL HIGHEST /F
if errorlevel 1 goto :error

schtasks /Create /TN "%TASK_PREFIX% - Lock Screen" /SC DAILY /ST %LOCK_TIME% /TR "\"%THIS_FILE%\" lock" /RL HIGHEST /F
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

:enable_login
rem Enable auto-login shortly before the daily restart.
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 1 /f >nul
exit /b %errorlevel%

:lock
rem Disable auto-login after the SMS window, then lock the desktop.
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f >nul
rundll32.exe user32.dll,LockWorkStation
exit /b 0
