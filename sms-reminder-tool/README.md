# LUK Dental SMS Reminder Tool

PySide6 desktop tool for sending one-day appointment reminders from the Open Dental bridge API through Windows Phone Link.

## Features

- Load Open Dental appointments by reminder date through the bridge API.
- Show patient name, appointment time, phone, email, appointment number, and reminder status.
- Send selected reminders or all pending reminders.
- Auto-load appointments when the reminder date changes on the dashboard.
- Monitoring tab with explicit Start/Stop controls for daily automatic sending.
- Daily scheduler runs only after `Start Monitoring` is clicked.
- Dedicated template management tab with country/language templates.
- Per-appointment template selection, defaulting to the configured template.
- Bridge-managed reminder log to prevent duplicate sends.
- Dry-run mode for safe testing before real SMS.
- Phone Link automation through `pywinauto` on Windows.

Default reminder schedule: after staff clicks `Start Monitoring`, send at `11:00 AM` for appointments one day ahead.

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

1. Keep Phone Link open and paired.
2. Open the app.
3. Set the bridge URL and API token in `Settings`.
4. Click `Test bridge connection`.
5. Open `Monitoring` and click `Start Monitoring`.
6. The app loads the reminder target date automatically.
7. Review or change the `Template` column for each patient if needed.
8. Click `Send all not sent`, or leave monitoring running for the configured send time.
9. Confirm the bridge logs show `sent` for successfully sent messages.

## Sending Behavior

Phone Link is controlled through Windows UI automation, so this app sends reminders one by one in order. It does not send multiple SMS messages in parallel. This keeps the Phone Link window stable and records each appointment result in the bridge log before moving to the next patient.

## Template Management

Use the `Templates` tab to add, edit, and delete appointment templates. Recall and Google review templates are managed from their own tabs. Templates are stored in the bridge database table `luk_sms_templates`, so multiple workstations share the same template list. The local `sms_config.json` keeps only workstation settings such as bridge URL, token, schedule time, and reminder statuses. The Google review link is stored in the bridge database as an SMS setting, not in local JSON.

The dashboard also has a `Template` column so a staff member can choose the correct language/country template for each appointment before sending.

The `Review Google` tab searches patients and fills Phone Link with a review request message. It does not auto-send SMS and does not run under monitoring.

## SMS Template Placeholders

Available placeholders:

- `{clinic_name}`
- `{clinic_phone}`
- `{review_link}`
- `{first_name}`
- `{last_name}`
- `{patient_name}`
- `{date}`
- `{date_full}`
- `{date_short}`
- `{weekday}`
- `{weekday_vi}`
- `{time}`
- `{time_lower}`
- `{phone}`
- `{apt_num}`
- `{pat_num}`

Example:

```text
Good morning {first_name}, I'm Nhan Nguyen from Luk Dental. I just remind you of your appointment tomorrow, {weekday}, {date_full} at {time_lower}. Thank you and have a great day.
```

## Phone Link Note

Phone Link does not provide a stable official SMS API. This tool uses Windows UI automation, so keep the Phone Link app logged in and avoid changing its language/layout during sending. If Microsoft changes the Phone Link UI, the `PhoneLinkSender` section in `sms_reminder_app.py` may need small adjustments.
