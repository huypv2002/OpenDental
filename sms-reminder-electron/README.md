# LUK Dental SMS Electron

Independent Electron port of `../sms-reminder-tool`. **R5 (Windows) is the first rollout target.** FD2 is also Windows; its manual workflow is implemented in source but requires its own workstation acceptance pass later. This is the primary SMS client. Daily Recall uses the Bridge daily Recall endpoints introduced in c1f9c65; update SERVER before using this version.

## Run on R5

1. Extract the **entire** `LUK-Dental-SMS-Electron-R5-v1.0.3-win-x64.zip` folder to a permanent location, for example `C:\LUK\SMS-Electron`. Keep `resources`, DLLs and other files beside the EXE.
2. Open `LUK Dental SMS Electron.exe`.
3. Open **Settings → Import Python config** and select R5's existing `sms_config.json`. This explicitly copies known workstation settings and the token into Electron's own settings directory. It does not overwrite the Python file. Templates and review settings come from the same Bridge database.
4. Verify the Bridge URL points to **SERVER**, not R5's loopback address. Click **Test bridge connection**.
5. Choose **R5 — automated reminders**, clinic time zone `America/Chicago`, and the existing daily send time (normally `11:00`). Save settings.
6. Keep Phone Link paired, logged in, and the desktop unlocked. Select a test patient and use **Test selected (no send)**. Verify the recipient and full template in Phone Link before any real sending.
7. Use **Send selected** or **Start Monitoring** only after the no-send check passes. Appointment send attempts remain `needs-review`, matching the Python reminder behavior. Inspect Phone Link, then **Mark sent**.

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

Settings and ledger live in `%APPDATA%\LUK Dental SMS Electron\workstation`; the app shows the exact path. The API token is workstation-local; protect the Windows user account and configuration folder. Do not share this folder. The application archive contains no patient data or credentials. The private R5 deployment ZIP intentionally includes the supplied Bridge token in a sidecar sms_config.json beside the EXE; do not share that ZIP publicly.

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

## v1.0.3 — automatic six-month Recall

Start Monitoring on R5 now runs appointment reminders followed by Recall for patients whose latest completed D1110, D4341 or D4342 was exactly six calendar months before the Houston clinic date. For example, October 23 selects April 23. Existing filters exclude inactive patients, newer qualifying treatment and scheduled appointments on/after the run date. The automatic list is distinct from the manual overdue Recall tab.

Recall messages use the existing Recall templates in English, Spanish or Vietnamese according to OD Language; missing language templates stop the Recall batch. Blank/other languages use English. Only Wireless phones are used. A server reservation plus the Electron ledger prevents repeated attempts across restarts/workstations; uncertain attempts remain needs-review, and Sync pending logs sends logs only. No appointment date/time is required for Recall. FD2 remains manual draft-only.

Update Bridge on SERVER, close the old Electron app and extract the whole v1.0.3 Windows folder. Keep the existing settings in %APPDATA%/LUK Dental SMS Electron/workstation. If replacing a deployed folder, retain its existing sms_config.json. The release ZIP contains no patient records or configured API token. Reopen Electron and use Start Monitoring at the existing configured time; no additional scheduler is needed.

Validation: 37 service/model tests, JavaScript syntax checks and the Electron demo UI test passed. Windows x64 packaging completed on macOS; the PE executable, ASAR version/feature, archive integrity and absence of a configured token were checked separately. This does not prove live Phone Link delivery on R5.
