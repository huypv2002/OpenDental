@echo off
cd /d "%~dp0"
echo ===================================================
echo   KHOI DONG LAI OPEN DENTAL BRIDGE API (PORT 3008)
echo ===================================================
echo.
git pull origin main
echo.
echo Dang tat tien trinh cu tren port 3008...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":3008" ^| find "LISTENING"') do taskkill /f /pid %%a 2>nul
timeout /t 1 /nobreak >nul
echo.
echo Dang khoi dong lai Bridge voi code moi...
start "Open Dental Bridge API" cmd /k "npm start"
timeout /t 3 /nobreak >nul
echo.
echo ===================================================
echo   BRIDGE DA KHOI DONG LAI THANH CONG!
echo   Ban co the quay lai app MetLife va an Luu!
echo ===================================================
