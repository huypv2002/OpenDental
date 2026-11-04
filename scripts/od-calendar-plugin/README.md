# LUK Calendar Navigation — OD 24.3

Adds a `-6` button in the vacant space left of Clear under the appointment calendar.
It uses `GetDateSelected().AddMonths(-6)` and the native `ModuleSelected(DateTime)`
to refresh the schedule. Month-end dates clamp normally (August 31 → February 28/29).
Repeated clicks move back another six months. Today and existing buttons stay unchanged.
No SQL, Bridge endpoint, appointment edit, or hash-agent changes.

## Install on Windows

1. Close OD on the workstation. Copy this source folder and the adjacent installer
   into `C:\open-dental-bridge\scripts` (or pull the commit when available).
2. Run PowerShell as administrator:

   ```powershell
   cd C:\open-dental-bridge
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-od-calendar-plugin.ps1
   # Custom install location:
   # powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-od-calendar-plugin.ps1 -InstallDir 'D:\Open Dental'
   ```

3. The DLL must be present in the OD installation on **every client** before
   enabling the shared Program Link; installing on SERVER alone does not install
   it on R5/FD2. Restart any client already running after distributing the DLL.
4. In OD, Setup → Program Links → Add: description `LUK Calendar Navigation`,
   plug-in DLL name `LukCalendarNavigation.dll`, Enabled checked. Save and reopen OD.
   Do not change the existing MetLife hash plugin entry.
5. Open Appointments. Look for `-6` to the left of Clear. Example: selected
   November 4, 2026 → May 4, 2026. Click again → November 4, 2025.

Check Day/Week views, month-end/leap dates, Today, resizing and Windows display
scaling on the real client. Ensure only one new button appears after switching
modules. If the expected vacant space is unavailable the button hides rather than
covering other controls. Disable this Program Link and restart OD to remove it;
no database repair is required.

## Evidence and limits

Source/API inspection targets public OD commit
`d804c19546233593d8a66af0591ed118a9e2c794` (24.3.63), adjacent to the previously
observed clinic client 24.3.61. Installer compiles against the installed business
DLL; both installer and runtime restrict use to 24.3. Exact installed-client
hooks/layout must still be checked on Windows. This is not live deployment proof.
The C# source passed a .NET Framework 4.8 reference build using the public
`PluginBase.cs` and C# 5 syntax, with zero warnings/errors. That check does not
replace compilation against the clinic DLL or real Windows UI verification.

Public source:
- https://github.com/OpenDental/opendental/blob/d804c19546233593d8a66af0591ed118a9e2c794/OpenDental/Main%20Modules/ControlAppt.cs
- https://github.com/OpenDental/opendental/blob/d804c19546233593d8a66af0591ed118a9e2c794/OpenDental/Main%20Modules/ControlAppt.Designer.cs
- https://github.com/OpenDental/opendental/blob/d804c19546233593d8a66af0591ed118a9e2c794/OpenDentBusiness/Plugins/PluginBase.cs
