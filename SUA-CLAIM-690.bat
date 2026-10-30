@echo off
setlocal
cd /d "%~dp0"
echo CLAIM 690 - REPAIR EXISTING PAYMENT 1202
echo Close the OD Payment edit window without saving any manual changes first.
echo Preview only:
node scripts\repair-claim-690.mjs
if errorlevel 1 goto failed
echo.
echo Adding D0210 increases the patient's charge and balance by $74 when missing.
echo D0120 and the $77.20 payment stay unchanged; only the $39.20 split is moved.
choice /c NY /n /m "Apply this specific repair? [N=No / Y=Yes]: "
if errorlevel 3 goto failed
if errorlevel 2 goto apply
echo Cancelled. Nothing changed.
goto done
:apply
node scripts\repair-claim-690.mjs --apply
if errorlevel 1 goto failed
goto done
:failed
echo STOPPED. Keep the output and any repair backup. Do not delete the journal or retry blindly.
:done
pause
endlocal
