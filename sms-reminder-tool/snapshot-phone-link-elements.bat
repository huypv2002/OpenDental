@echo off
setlocal
cd /d "%~dp0"

echo.
echo Phone Link element snapshot
echo ---------------------------
echo 1. Open Phone Link and leave it on the conversation/message screen you want to inspect.
echo 2. If you want, paste a short unique text to search for in the snapshot.
echo.
set /p SNAPSHOT_SEARCH=Search text, phone, or template snippet (optional): 

if not exist ".venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  python -m venv .venv
)

call ".venv\Scripts\activate.bat"
python -m pip install -r requirements.txt

python phone_link_snapshot.py --search "%SNAPSHOT_SEARCH%"
echo.
pause
