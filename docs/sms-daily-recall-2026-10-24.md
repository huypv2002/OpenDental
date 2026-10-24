# Independent Electron daily SMS schedules — v1.0.5

The primary client is sms-reminder-electron. Appointment and Recall now have separate enable flags, controls, send times, completion markers and error backoff. The shared Phone Link worker only serializes native operations. A failure or stop in one stream leaves the other enabled.

Appointment keeps the existing 1-/8-day feed and scheduler-on/off.bat Windows infrastructure. Recall has a separate Daily Recall task and recall-scheduler-on/off.bat. Recall BAT files never register or remove Appointment, restart, auto-login or lock tasks. Existing Appointment off removes its system infrastructure; Recall needs a signed-in/unlocked R5 independently.

Recall uses the calendar-6-month-v2 Bridge feed from 82bc316: completed D1110/D4341/D4342 on the target date, one message per patient/service date, patient-language Recall templates. Newer services and existing appointments are not extra exclusion rules. FD2 remains manual.

Existing AppData configuration, appointment completion state, Recall completion state and dispatch deduplication are preserved during upgrade. Recall does not auto-enable through Appointment entrypoints. Windows native task registration and real SMS delivery still require R5 verification.
