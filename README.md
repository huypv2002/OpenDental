# Open Dental Bridge

Small Node.js API for reading available appointment slots from the `opendental_test` clone database. WordPress should call this API instead of connecting directly to MySQL.

## Endpoints

- `GET /health` checks app and database connectivity.
- `GET /api/reference` returns providers, operatories, and appointment types.
- `GET /api/slots?date=2026-05-22` returns calculated open slots.

Protected endpoints require:

```http
Authorization: Bearer your-token
```

## Install On The Open Dental Server

```bat
cd C:\open-dental-bridge
npm install
copy .env.example .env
notepad .env
npm start
```

Suggested POC `.env` values:

```env
PORT=3008
API_TOKEN=replace-with-a-long-random-token
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=opendental_test
DB_USER=luk2468
DB_PASSWORD=luk2468
DEFAULT_PROVIDER_NUM=1
DEFAULT_OPERATORY_NUM=1
DEFAULT_APPOINTMENT_TYPE_NUM=1
OPEN_TIME=09:00
CLOSE_TIME=18:00
SLOT_INTERVAL_MINUTES=30
FALLBACK_DURATION_MINUTES=30
BUSY_APT_STATUSES=1
CORS_ORIGINS=https://lukdental.us
```

## Local Test

```bat
curl http://127.0.0.1:3008/health
curl -H "Authorization: Bearer replace-with-a-long-random-token" "http://127.0.0.1:3008/api/reference"
curl -H "Authorization: Bearer replace-with-a-long-random-token" "http://127.0.0.1:3008/api/slots?date=2026-05-22"
```

## Production Notes

- Keep MySQL closed to the public internet.
- Expose this API via HTTPS only.
- Prefer Cloudflare Tunnel or a reverse proxy with TLS.
- Use a strong token, not the example token.
- Start with `opendental_test`; only switch to production DB with a read-only user after the POC is verified.
