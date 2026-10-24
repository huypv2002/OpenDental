# LUK Dental SMS Electron

Independent Electron port of `../sms-reminder-tool`. **R5 (Windows) is the first rollout target.** FD2 is also Windows; its manual workflow is implemented in source but requires its own workstation acceptance pass later. This is the primary SMS client. Daily Recall uses the Bridge daily Recall calendar-6-month-v2 contract from 82bc316; update SERVER before using this version.

## Run on R5

1. Extract the **entire** `LUK-Dental-SMS-Electron-v1.0.5-win-x64.zip` folder to a permanent location, for example `C:\LUK\SMS-Electron`. Keep `resources`, DLLs and other files beside the EXE.
2. Open `LUK Dental SMS Electron.exe`.
3. Open **Settings → Import Python config** and select R5's existing `sms_config.json`. This explicitly copies known workstation settings and the token into Electron's own settings directory. It does not overwrite the Python file. Templates and review settings come from the same Bridge database.
4. Verify the Bridge URL points to **SERVER**, not R5's loopback address. Click **Test bridge connection**.
5. Choose **R5 — automated reminders**, clinic time zone `America/Chicago`, and the existing daily send time (normally `11:00`). Save settings.
6. Keep Phone Link paired, logged in, and the desktop unlocked. Select a test patient and use **Test selected (no send)**. Verify the recipient and full template in Phone Link before any real sending.
7. Use **Send selected** or **Start Appointment** or **Start Recall** only after the no-send check passes. Appointment send attempts remain `needs-review`, matching the Python reminder behavior. Inspect Phone Link, then **Mark sent**.

The package needs no Python or Node installation. Phone Link/Open Dental integrations use Windows PowerShell 5.1, built-in .NET UI Automation and the Windows clipboard. It is an unsigned local build; no signing certificate is configured.

## Scheduler on R5

The Monitoring tab exposes four times: enable auto-login (`08:59`), restart (`09:00`), open tool (`10:55`) and lock (`12:05`). These Windows task times use **the Windows time zone**. The app's reminder time uses the configured **clinic time zone**. Set R5 to Houston/Central time so the two agree.

Disable the existing Python scheduler on R5 before enabling Electron tasks. From the packaged app choose **Set up Windows scheduler**, select the official Microsoft Sysinternals `Autologon64.exe`, and follow the Administrator/password prompt. Use the real Windows password, not the Hello PIN. Electron does not store the Windows password in its JSON configuration.

New task prefix: `LUK Dental SMS Electron`. Existing Python tasks are not deleted. Startup argument: `--start-reminder-monitoring`. Only one Electron instance is allowed per workstation. Password changes require rerunning scheduler setup, as with the Python tool.

Scheduler task diagnostics persist to `scheduler-run.log` beside the EXE. App activity diagnostics persist to a separate `scheduler-run.log` in the settings folder (Settings → Open settings folder). The deployment also includes scheduler-on.bat, scheduler-off.bat and setup-scheduler-tasks.ps1 entrypoints.

## Functionality ported

| Python tab/function | Electron implementation                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard           | Appointment date, counts, search, per-row templates, multiselection, preview, no-send test, real test SMS, send selected/all, mark sent, reset, clear dry-run, Open Dental View |
| Patient             | Debounced paged search, exact `#PatNum`, templates, preview, no-send test, sequential manual drafts, per-patient combined SMS history                                           |
| Monitoring          | Explicit Start/Stop, configured offset plus 8 days, 30-minute send window, persisted daily marker, Windows scheduler, activity stream                                           |
| Recall              | Months/codes filters, counts/history, templates, manual drafts, two-or-more reminder warning                                                                                    |
| Treatment           | Days/codes/procedure status filters, shared templates, manual drafts, Open Dental View                                                                                          |
| Review Google       | Shared review link, patient search, template preview/fill only; no automatic send or log                                                                                        |
| Holiday & Birthday  | Campaign/date/filter, birthday candidates, holiday event CRUD, custom recipient add/edit/remove, manual drafts for selected/all                                                 |
| Templates           | Shared Bridge CRUD for all five categories, language/country, initialization, preview placeholders                                                                              |
| Settings            | Connection/token import, clinic data, statuses, schedule, time zone, workstation mode, data folder, UI snapshot                                                                 |
| Logs                | Bridge reminder logs, filter, pending log synchronization; combined history available per patient                                                                               |

Tables virtualize rows and preserve per-patient selection/template choices while scrolling. Column resizing persists by tab. Network and native automation run outside the renderer; no synchronous Bridge call blocks table interactions.

## Reliability differences

- **Stop** allows the current native SMS operation to finish, then starts no further patient.
- Failed/uncertain native attempts stay **needs-review** and are not automatically retried. Inspect Phone Link before resetting them.
- A durable local appointment ledger is written before native automation. A crash or Bridge outage cannot silently make that appointment eligible again.
- Failed Bridge log writes remain in a local **outbox**. Use **Sync pending logs**; this resends log writes, never SMS.
- Staff must confirm **Sent - save log** after a manual draft. Choosing **Not sent** writes no sent log. Open draft state survives restarts.
- Native automation requires verifying the recipient input and the complete compose message. If Phone Link's UIA tree does not expose those fields, it stops rather than declaring an unverified paste successful. Use Settings → Phone Link UI snapshot when adapting a new Phone Link build.
- FD2 blocks automated reminder sending/Monitoring. Manual categories remain available.

Settings and ledger live in `%APPDATA%\LUK Dental SMS Electron\workstation`; the app shows the exact path. The API token is workstation-local; protect the Windows user account and configuration folder. Do not share this folder. The application archive contains no patient data or credentials. The generic v1.0.5 ZIP contains no workstation credentials; retain or import your existing settings.

## Development and validation

```sh
cd sms-reminder-electron
npm ci
npm run demo       # synthetic data, separate config folder, no real Bridge/SMS
npm run check
npm test
npm run test:ui
npm run test:parity # execute original Python pure helpers; development only
npm run pack:win   # Windows x64 folder without code-sign/edit dependency
npm run dist:win   # Windows NSIS + portable EXE; preferably build on Windows
```

Demo mode uses synthetic `example.com` patients and a separate data store. It cannot change the real Bridge or send through Phone Link.

Local validation covers JavaScript syntax, domain/service tests and the running Electron UI in demo mode. A Windows package build is **not** proof of live Phone Link delivery. Before replacing Python on R5, verify its actual Phone Link layout, no-send test, one approved test send, Bridge log sync, daily scheduler startup and locking. FD2 remains a later acceptance target.

## Files

- `main.cjs` / `preload.cjs`: Electron lifecycle, restricted IPC, settings import, scheduler entrypoint.
- `renderer/`: ten-tab interface and virtual tables.
- `shared/model.mjs`: Python-equivalent dates, templates, phone targets and log payloads.
- `lib/service.cjs`: sequential SMS, manual confirmation, local ledger/outbox, monitoring.
- `windows/automation.ps1`: Phone Link/Open Dental native UIA worker.
- `windows/scheduler.ps1`: R5 Windows task setup/removal.

Electron renderer isolation follows the [official IPC/context-isolation guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation). The renderer has no Node integration, cannot make network requests, and receives only the app's explicit IPC methods.

Detailed source comparison and pending R5 acceptance: [DOI-CHIEU-PYTHON.md](DOI-CHIEU-PYTHON.md).

## Independent daily schedules — v1.0.5

Appointment and six-month Recall are separate. Starting Appointment never enables Recall. Each has its own Start/Stop buttons, send time, retry state and daily completion marker. Stopping one leaves the other enabled. When both are due, Phone Link operations run sequentially.

- `scheduler-on.bat` / `scheduler-off.bat`: existing Appointment schedule only. These also manage the existing R5 auto-login/restart/lock tasks.
- `recall-scheduler-on.bat` / `recall-scheduler-off.bat`: separate Windows task `LUK Dental SMS Electron - Daily Recall`. These do not change Appointment tasks, auto-login, restart or locking. Run as Administrator under the intended R5 Windows account. The off file also stops Recall monitoring in the running Electron instance.
- Both task launch times default to 10:55 Windows time. Change `RECALL_START_TOOL_TIME` in the Recall on BAT if needed. Set Recall send time separately in Electron Settings (default 11:00 clinic time). Open the app before that send time. Ensure Windows and the configured clinic time zone agree when choosing task times.
- On BAT files register future daily launches; use Start Appointment / Start Recall in the UI to enable a stream immediately. Each stream sends only within its own 30-minute daily window.

Recall selects active patients with any completed D1110, D4341 or D4342 on the exact date six calendar months earlier (October 23 selects April 23). Existing appointments and newer treatment do not exclude them. Multiple qualifying codes yield one SMS per patient/service date. Recall language templates follow OD Language; missing Spanish/Vietnamese templates block the Recall batch instead of substituting English. Wireless phone only. Bridge dispatch reservations and the local ledger prevent retrying uncertain attempts.

Upgrade: close the old app, extract the entire v1.0.5 package and rerun the Appointment BAT from the new folder to replace the old EXE path. Enable Recall using its separate BAT only when wanted. Existing workstation settings/logs are preserved. Bridge must support `calendar-6-month-v2` (82bc316 or later).

Recall requires an already signed-in, unlocked R5 with Phone Link ready. If Appointment off disables the existing auto-login/restart infrastructure, arrange Windows availability separately for Recall. Recall never wakes, unlocks or signs into Windows by itself. FD2 remains manual draft only. Package/unit/demo UI validation does not prove actual Windows task execution or SMS delivery.
