@echo off
setlocal

set "APP_DIR=%~dp0"
set "TUNNEL_NAME=od-bridge"

echo Starting Open Dental bridge and Cloudflare tunnel...
echo App directory: %APP_DIR%
echo Tunnel: %TUNNEL_NAME%

start "Open Dental Bridge API" /D "%APP_DIR%" cmd /k npm start
timeout /t 2 /nobreak >nul
start "Cloudflare Tunnel - od-bridge.lukdental.us" /D "%APP_DIR%" cmd /k cloudflared tunnel run %TUNNEL_NAME%

endlocal
