@echo off
cd /d "%~dp0"
echo ===================================================
echo   KHOI DONG LAI OPEN DENTAL BRIDGE API (PORT 3008)
echo ===================================================
echo.
echo [1/3] Dong bo ma nguon moi nhat...
git pull origin main
echo.
echo [2/3] Don dep lock va kiem tra cau hinh he thong...
node scripts/revert-claim-1307.mjs
echo.
echo [3/3] Dang tat tien trinh cu tren port 3008 va khoi dong lai...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":3008" ^| find "LISTENING"') do taskkill /f /pid %%a 2>nul
timeout /t 1 /nobreak >nul
start "Open Dental Bridge API" cmd /k "npm start"
timeout /t 3 /nobreak >nul
echo.
echo ===================================================
echo   BRIDGE DA KHOI DONG LAI THANH CONG!
echo   Ban co the sang tab R5 va an "Luu khoan thanh toan"!
echo ===================================================

