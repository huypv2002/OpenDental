@echo off
setlocal
title LUK Dental SMS Electron - Update and Start

pushd "%~dp0" || goto folder_error

where git >nul 2>&1
if errorlevel 1 goto missing_git
where node >nul 2>&1
if errorlevel 1 goto missing_node
where npm >nul 2>&1
if errorlevel 1 goto missing_node
if not exist "package.json" goto missing_source
if not exist "package-lock.json" goto missing_source
git rev-parse --show-toplevel >nul 2>&1
if errorlevel 1 goto missing_repo

echo [1/3] Updating source from Git...
git pull --ff-only
if errorlevel 1 goto pull_error

echo.
echo [2/3] Installing dependencies...
call npm ci
if errorlevel 1 goto install_error

echo.
echo [3/3] Starting LUK Dental SMS Electron...
call npm start
if errorlevel 1 goto start_error
popd
endlocal
exit /b 0

:missing_git
echo ERROR: Git was not found. Install Git for Windows and reopen this file.
goto failed
:missing_node
echo ERROR: Node.js or npm was not found. Install Node.js and reopen this file.
goto failed
:missing_source
echo ERROR: Keep this BAT inside the sms-reminder-electron source folder.
goto failed
:missing_repo
echo ERROR: This folder is not a Git checkout. Use the source cloned from Git.
goto failed
:pull_error
echo ERROR: Git pull failed. Check the message above. Dependencies and app were not started.
goto failed
:install_error
echo ERROR: npm ci failed. Check the message above. The app was not started.
goto failed
:start_error
echo ERROR: npm start failed. Check the message above.
goto failed
:folder_error
echo ERROR: Cannot open the folder containing this BAT.
pause
endlocal
exit /b 1
:failed
echo.
pause
popd
endlocal
exit /b 1
