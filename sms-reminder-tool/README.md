# LUK Dental SMS Reminder Tool

PySide6 desktop tool for sending one-day appointment reminders from the Open Dental MySQL database through Windows Phone Link.

## Features

- Load Open Dental appointments by reminder date.
- Show patient name, appointment time, phone, email, appointment number, and reminder status.
- Send selected reminders or all pending reminders.
- Daily scheduler based on the configured send time.
- SMS template with placeholders.
- MySQL log table to prevent duplicate sends.
- Dry-run mode for safe testing before real SMS.
- Phone Link automation through `pywinauto` on Windows.

## Install

Run on the Windows server where Phone Link is already signed in.

```bat
cd open-dental-bridge\sms-reminder-tool
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy config.example.json sms_config.json
python sms_reminder_app.py
```

## Database Permission

The app reads Open Dental appointments and creates a small log table:

```sql
CREATE TABLE luk_sms_reminder_log (...);
```

Use a database account with permission to:

- `SELECT` Open Dental appointment and patient data
- `CREATE` the `luk_sms_reminder_log` table once
- `INSERT` and `UPDATE` reminder log rows

## First Test

1. Keep `dry_run` enabled.
2. Open the app.
3. Set DB credentials in `Settings`.
4. Click `Test DB connection`.
5. Load tomorrow's appointments.
6. Click `Send all not sent`.
7. Confirm the logs show `dry-run`.
8. Turn off dry run only after confirming Phone Link is ready.

## SMS Template Placeholders

Available placeholders:

- `{clinic_name}`
- `{clinic_phone}`
- `{first_name}`
- `{last_name}`
- `{patient_name}`
- `{date}`
- `{time}`
- `{phone}`
- `{apt_num}`
- `{pat_num}`

Example:

```text
Hi {first_name}, this is {clinic_name} reminding you of your appointment on {date} at {time}. Please call {clinic_phone} if you need to change anything.
```

## Phone Link Note

Phone Link does not provide a stable official SMS API. This tool uses Windows UI automation, so keep the Phone Link app logged in and avoid changing its language/layout during sending. If Microsoft changes the Phone Link UI, the `PhoneLinkSender` section in `sms_reminder_app.py` may need small adjustments.
