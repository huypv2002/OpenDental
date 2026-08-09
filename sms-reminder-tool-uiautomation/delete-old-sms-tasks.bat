@echo off
setlocal

echo Deleting old LUK Dental SMS UIAutomation scheduled tasks...
echo.

schtasks /Delete /TN "LUK Dental SMS UIAutomation - Start Monitoring" /F
schtasks /Delete /TN "LUK Dental SMS UIAutomation - Screen Off" /F

echo.
echo Done.
pause
