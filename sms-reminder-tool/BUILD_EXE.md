# Build Windows EXE

Use the GitHub Actions workflow `Build SMS Reminder EXE`.

1. Push this repository to GitHub.
2. Open Actions.
3. Run `Build SMS Reminder EXE`.
4. Download the artifact named `LUK-Dental-SMS-Reminder-windows`.
5. Extract `LUK-Dental-SMS-Reminder-windows.zip`.

The artifact contains:

- `LUK Dental SMS Reminder Tool.exe`
- `run-sms-reminder.bat`
- `scheduler-on.bat`
- `scheduler-off.bat`
- `setup-scheduler-tasks.ps1`
- `config.example.json`
- `tooth.ico`
- `assets/flags/*`

Put all files from the artifact in one folder on the Windows clinic machine.
Double-click `LUK Dental SMS Reminder Tool.exe` or `run-sms-reminder.bat`.

On first run, the app creates `sms_config.json` beside the EXE if it does not already exist.
Edit the Bridge URL and API token in the app Settings screen.

For scheduler setup, run `scheduler-on.bat` as Administrator. If auto-login is needed, place Microsoft Sysinternals `Autologon64.exe` in the same folder before running `scheduler-on.bat`.
