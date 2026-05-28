@echo off
setlocal

echo Deleting old LUK Dental SMS scheduled tasks...
echo.

schtasks /Delete /TN "LUK Dental SMS - Start Monitoring" /F
schtasks /Delete /TN "LUK Dental SMS - Screen Off" /F

echo.
echo Done.
pause
