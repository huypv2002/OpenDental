# Unified Electron daily SMS — v1.0.6

The user now wants one schedule and only scheduler-on/off.bat. The primary Electron client starts/stops Appointment and 6-month Recall together at the Appointment send time. Per-batch completion/backoff and existing Bridge reservations/ledger are retained internally to prevent replay on failure.

The existing DB templates are named 6M RECALL - EN/ES/VI under appointment. Daily Recall chooses these by patient language, records Recall logs and uses recall-claim even though template storage category is appointment. Missing or duplicate language templates block Recall instead of substituting a generic template. Automatic appointment selection excludes the 6M keys.

Both on/off installers remove the obsolete v1.0.5 Daily Recall Windows task. Recall-only BAT/scripts are removed from the package. The common Windows restart/login/launch/lock schedule is unchanged. AppData progress is preserved; old Recall-only send time is ignored. Old CLI entrypoints now control the unified monitoring flow for compatibility.

Exact-date target and codes remain calendar-6-month-v2: any completed D1110/D4341/D4342 on the target date, one attempt per patient/service date, no extra exclusions for newer service or existing appointments. FD2 is manual only. Native R5 task execution and actual SMS delivery remain unverified locally.
