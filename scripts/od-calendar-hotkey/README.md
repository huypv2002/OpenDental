# OD Calendar Hotkey (standalone Windows utility)

Alt+6 navigates the currently selected OD Appointments date back six calendar
months. No plugin, SQL, DLL injection, elevated privileges or OD credentials.
The previous calendar plugin should remain disabled in Program Links.

On R5, open Appointments, then in PowerShell:

```powershell
cd C:\OpenDental
git pull --ff-only
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-od-calendar-hotkey.ps1 -Inspect
# If READY, launch the tray app:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-od-calendar-hotkey.ps1
```

Select the OD main Appointments window, wait one second, press/release Alt+6.
The utility opens the month/year date picker, reads the selected date using the
Windows short-date format, computes AddMonths(-6), sets that date, and invokes
only the date picker's OK button. It checks the entered date before submission
and that Appointments is available afterward. It opens the picker only once;
there is no second dialog to reread the selected date. Success is logged as
`NAVIGATED` (submitted and returned to calendar), not independent date readback.
August 31 correctly clamps to February
28/29; it does not approximate by repeatedly clicking the previous-month button.
A repeated hotkey starts from the newly selected date.

The utility runs silently: no startup, success, error or duplicate-instance
popup notifications. Results/errors are saved to:
`%LOCALAPPDATA%\LUKDental\ODCalendarHotkey\last-result.txt`.
Quit via the tray icon's Exit menu. There is no automatic startup registration.
To opt into startup without a shortcut, run the installer with `-Startup -Restart`.
It compiles first, stops only this profile's installed utility in the current
session, replaces it, registers its quoted executable path as
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LUKOdCalendarHotkey`,
verifies the registry value and starts the utility immediately. It starts at
login for this Windows account, not before login. Repeating the command updates
the same entry. Unrelated Run entries are untouched; an existing differing value
for this app's entry is backed up under the app installation directory.

One PowerShell command to pull, update, enable startup, and launch:

```powershell
& { Set-Location 'C:\OpenDental'; git pull --ff-only; if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }; powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-od-calendar-hotkey.ps1 -Startup -Restart; if ($LASTEXITCODE -ne 0) { throw 'Hotkey setup failed' } }
```

Disable startup only:
`Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name LUKOdCalendarHotkey -ErrorAction SilentlyContinue`.

The script builds locally using the Windows .NET Framework compiler, verifies
the repository's UIA3 library checksums, and installs under the current profile.
Exit the running tray app before rebuilding/updating it.

Guards: foreground process must be OpenDental's main window, Appointments and
calendar controls must be exposed, no existing modal, and a unique date field
and OK button must be found. Focus changes, covered calendar, unsupported date
format, nonunique controls or verification failures stop the attempt. It does
not press generic Enter or move appointments. If a newly opened picker cannot
be identified safely, it may be left open; close it manually and report the error.
The first attempt should be made when nobody else is using the R5 mouse/keyboard.

Evidence: C# 5/.NET Framework 4.8 build passes with zero warnings/errors, using
the same UIA3 COM wrapper as the existing OD tooling. Date/culture/launcher
checks pass offline. Source assumptions were checked against public OD 24.3
commit d804c19546233593d8a66af0591ed118a9e2c794 (MonthCalendarOD/FrmDatePicker).
This is not a live R5 test. Current remote CUA access to RustDesk timed out;
actual UI Automation IDs and date navigation must be verified on Windows.

Offline tests: `powershell -NoProfile -File .\scripts\od-calendar-hotkey\test-date-policy.ps1`.
