@echo off
setlocal
cd /d "%~dp0"
rem Serialize updates so a double-click cannot start two Bridge processes.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$m = New-Object Threading.Mutex($false, 'Local\LUKOpenDentalBridgeUpdate'); if (-not $m.WaitOne(0)) { Write-Host 'Bridge update already running.'; exit 1 }; try { & '%~dp0scripts\update-bridge.ps1'; exit $LASTEXITCODE } finally { $m.ReleaseMutex(); $m.Dispose() }"
if errorlevel 1 pause
endlocal
