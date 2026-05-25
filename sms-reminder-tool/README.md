# LUK Dental SMS Reminder Tool

PySide6 desktop tool for sending one-day appointment reminders from the Open Dental bridge API through Windows Phone Link.

## Features

- Load Open Dental appointments by reminder date through the bridge API.
- Show patient name, appointment time, phone, email, appointment number, and reminder status.
- Send selected reminders or all pending reminders.
- Daily scheduler based on the configured send time.
- SMS template with placeholders.
- Bridge-managed reminder log to prevent duplicate sends.
- Dry-run mode for safe testing before real SMS.
- Phone Link automation through `pywinauto` on Windows.

## Install

Run on a Windows 10/11 workstation where Phone Link is already signed in. The Open Dental bridge stays on the server.

```bat
cd open-dental-bridge\sms-reminder-tool
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy config.example.json sms_config.json
python sms_reminder_app.py
```

## Database Permission

The desktop app does not connect directly to MySQL. It calls the bridge API:

- `GET /api/sms-reminders/appointments`
- `POST /api/sms-reminders/log`
- `GET /api/sms-reminders/logs`

The bridge server handles Open Dental database access and creates/updates the `luk_sms_reminder_log` table.

## First Test

1. Keep `dry_run` enabled.
2. Open the app.
3. Set the bridge URL and API token in `Settings`.
4. Click `Test bridge connection`.
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
