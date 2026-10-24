# Daily six-month Recall SMS

## Primary client: SMS Electron v1.0.3

The primary R5 client is `sms-reminder-electron`. Its Monitoring batch now runs appointment reminders and the exact-date six-month Recall feed. It uses the same clinic time zone setting (`America/Chicago`), Recall language templates, Bridge dispatch reservation, durable local ledger and log outbox. It requires Bridge c1f9c65 or later. Manual Recall/FD2 drafts keep their existing behavior.

Electron v1.0.3 validation: 37 service/model tests passed, syntax checks passed, the 10-tab Electron demo UI test passed (including the Monitoring Recall description), and Windows x64 packaging completed. The resulting PE/ASAR feature/version and ZIP integrity were verified. The public ZIP excludes workstation config, tokens and patient data. Existing Electron settings persist in the same app-data directory; retain any deployment config already beside the EXE when replacing files. Windows Phone Link delivery on R5 remains unverified.

The earlier Python clients also contain an implementation; they are not the deployment target for this request. Use the Electron package described above.

## Bridge contract and legacy client behavior

Both tracked Python SMS clients (standard and UIAutomation) append a Recall batch after the existing appointment reminders at the configured daily Monitoring time. Monitoring and the existing Windows scheduler must be running on R5, with Phone Link ready and dry-run disabled for real sending. Clinic date/time follows the Windows workstation clock, just like appointment reminders; configure R5 for Houston time. This is an application scheduler, not a Codex scheduled task.

The daily feed selects active patients whose latest completed D1110, D4341 or D4342 service date is exactly six calendar months before that day's clinic date. Example: 2026-10-23 selects 2026-04-23. D1120 and older overdue dates are not included. Month-end subtraction clamps to the last available day; duplicate reservations prevent another SMS if multiple run dates clamp to the same service date. Patients with a scheduled appointment on/after the run date are excluded, retaining the existing Recall candidate convention. Each patient receives at most one message for the service date, even when multiple quadrants/codes qualify.

Templates come from the existing Recall category, using the patient's OD Language: US/English (also blank/unrecognized language), ES/Spanish, VI/Vietnamese. Missing recognized-language templates fail the batch rather than substituting an appointment message or another language. Only Wireless phones are used. The manual Recall tab remains an overdue list with its existing filters; the automatic daily batch uses its own exact-date feed.

The client requires the new Bridge response contract and retrieves all pages with a patient-number cursor. The Bridge reserves `(PatNum, LastProcDate)` before a real Phone Link attempt, rechecks the active patient, unchanged Wireless phone, latest qualifying service and upcoming appointments, and prevents concurrent workers/restarts from repeating an attempt. Dry runs never reserve a real dispatch. Phone Link attempts remain `needs-review` until the operator confirms delivery. Pending/failed/uncertain reservations do not automatically replay: inspect Phone Link before any manual resend. Dispatch history is stored in `luk_sms_daily_recall_dispatch`; normal Recall logs remain in `luk_sms_recall_log`. A crash after reservation may require manual handling and will not blindly resend.

Deployment: update/restart Bridge on SERVER first, then replace the SMS EXE on R5 with the matching newly built standard/UIAutomation package. Preserve `sms_config.json` and the existing scheduler configuration. Source-only `git pull` does not update an old EXE. Start Monitoring as usual. FD2 draft mode is preserved and never submits a message.

Verification: 7 Node tests passed (calendar/month-end behavior, exact selection SQL, three requested codes, concurrent reservation and existing Bridge SMS behavior); standard Python 32 tests passed; UIAutomation Python 34 tests passed. New client tests cover language defaults, pagination/old-Bridge refusal, reserve-before-send, repeat suppression, dry-run isolation and Monitoring queue integration. These are local tests with fake Bridge/Phone Link senders; no clinic SMS was sent and no real clinic database query was run. Windows build and live Phone Link operation are separate evidence.
