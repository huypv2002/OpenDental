# LUK Dental Audit Trail Tool

Desktop tool for editing Open Dental `securitylog` audit trail rows through the bridge API.

The tool loads the lightweight patient search index once with no row limit. Audit entries are requested only after the user selects a patient.

## Run

Double-click:

```bat
run-audit-trail.bat
```

The BAT file pulls the latest bridge repository, creates a Python virtual environment, installs dependencies, creates `audit_config.json` if needed, and opens the app.

## Config

`audit_config.json` uses the same bridge pattern as the SMS Reminder tool:

```json
{
  "bridge_url": "http://127.0.0.1:3008",
  "api_token": "CHANGE_ME"
}
```

The bridge must be running, and writes must be enabled for add/update/delete:

```env
ENABLE_OPEN_DENTAL_WRITES=true
```
