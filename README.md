# Open Dental Bridge

Small Node.js API for reading available appointment slots and creating website bookings in Open Dental. WordPress should call this API instead of connecting directly to MySQL.

## Liberty EOB: PDF and images

The insurance scanner accepts `.pdf`, `.jpg`, `.jpeg`, and `.png` in the existing `LIBERTY` folder alongside the configured MetLife incoming folder. PDFs with embedded text retain their existing extraction path. Image-only PDFs (up to 10 pages) and images use local English OCR with language files installed through npm; document contents are not sent to an OCR service. Maximum source size: 30 MB; maximum image/page size: 25 million pixels. Clear, upright images with the complete payment table are required.

After updating the server source, run `npm ci` before restarting `npm start`. No OCR API key or separate Tesseract installation is needed. The first OCR run can take longer than a normal PDF read.

Before processing an OCR document, the scanner checks service dates/codes, row sequence, all claim column totals, the overall net payment, and every patient's completed procedures. Missing or ambiguous information moves the source to `REVIEW`, shown as “Chờ đối chiếu”; these files are not automatically retried. Resolve the mismatch against the original document and OD before moving a reviewed source back to the incoming folder. Tiny Group text is retained as unverified raw OCR, not used as a confirmed identifier. OCR descriptions may still contain spelling errors; consult the original for exact wording.

The original image is preserved in `PROCESSED` after successful processing. A PDF copy is imported into each matched patient's Finished Claims using the existing claim number, payment date and amount naming. The history viewer can also display the archived image as a PDF.

To inspect extraction without connecting to OD or changing data:

```powershell
node scripts/inspect-liberty-eob.mjs 'C:\path\EOB.jpg' --json liberty-check.json --text liberty-text.txt
```

Output files contain patient information; store them privately. Existing output files are not overwritten. Inspecting does not submit a payment. For an optional local image regression, set `LIBERTY_TEST_IMAGE` to a fixture path before running `npm run test:metlife`; no patient image is bundled with the source.

## Daily insurance Excel report

After each automatic scan, successfully saved MetLife and Liberty claims are appended to a daily workbook. With the standard `D:\SHARE\INSURANCE CLAIM\METLIFE` incoming path, the output is `D:\SHARE\EXCEL\YYYY-MM-DD.xlsx`, dated by the SERVER's local calendar. `INSURANCE_EXCEL_DIR` can override the output directory. A day with no successful records does not create an empty workbook.

`PAYMENTS` follows the supplied 15-column layout, with one row per EOB service and grouped patient/payment totals. `DATE` is the service date; `INSUR PAID DAY` is the EOB payment date (MetLife Processed date / Liberty Check Date). `CHARGE` is the matching completed procedure's actual fee in OD at first export. `INSUR BILL` is the submitted EOB fee, and `INSUR PAY` is the insurance benefit per service. `CREDIT` is the saved claim payment. `TOTAL` sums the group's charges; `BALANCE` is that group's total minus credit, not the patient's entire account balance. Unknown procedure fees and dependent totals stay blank rather than becoming zero. `PAYMENT` is `CREDIT`; `STATUS` is `Đã lưu`.

`TONG HOP` counts unique source files, saved claims, and their total payment. A multi-patient EOB counts as one file and multiple claims. Persisted payment, claim and source identities prevent re-scans or renamed copies from adding duplicate groups; a hidden internal sheet stores those identities. Existing exported groups and staff cell edits are preserved when new groups are appended. Keep the daily workbook's main header and internal sheet intact.

Legacy successful history entries can lack the payment date or EOB service details. Those entries appear separately in `CAN DOI CHIEU`, with the known patient/claim/payment information and the missing-data reason. Valid entries still export to `PAYMENTS`. `TONG HOP` distinguishes exported records/totals from the count awaiting review. Pending dates remain eligible for report-only recovery; correcting the history data lets the next scan append a recovered record once and clear its review entry. This does not recreate the OD payment or invent missing service data.

The exporter accepts history details returned as TEXT, Buffer or mysql2 JSON objects. For legacy entries missing dates/services, it can recover from the existing payment and linked paysplits only after matching the patient, total payment, procedure dates and split sum. The original submitted EOB fee remains blank when it cannot be recovered, and the carrier is marked unknown when no carrier information is available. Duplicate history for the same source/claim does not add more groups. Every successful export logs the absolute filename and confirms a nonempty file on disk, including reports containing only review entries.

To create/retry a report explicitly in a known folder without scanning PDFs or creating any payment:

```powershell
node scripts/export-insurance-excel.mjs 2026-10-21 --dir 'D:\SHARE\EXCEL'
```

Use the processing date shown in the server log. This command reads the configured DB and writes Excel files only; the printed path is the actual output location.

Excel export reads successful history and procedure data without creating or repeating payments. If Excel is open or the share is unavailable, the previous workbook is retained and export retries on the next scan. Pending days are remembered in `EXCEL\.pending`, including across restarts and midnight. The scanner writes a temporary workbook and replaces the daily file only after it is complete; concurrent tool instances use a report lock. Close the workbook in Excel to allow a pending update to finish. Console messages starting `[Excel]` report export results separately from payment results.

## Endpoints

- `GET /health` checks app and database connectivity.
- `GET /api/reference` returns providers, operatories, and appointment types.
- `GET /api/slots?date=2026-05-22` returns calculated open slots.
- `POST /api/bookings` creates a patient and appointment when write mode is enabled.
- `POST /api/bookings/:aptNum/files` stores booking uploads on the clinic server.

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
DB_USER=change-this-db-user
DB_PASSWORD=change-this-db-password
DEFAULT_PROVIDER_NUM=1
DEFAULT_OPERATORY_NUM=1
DEFAULT_APPOINTMENT_TYPE_NUM=1
OPEN_TIME=09:00
CLOSE_TIME=18:00
SLOT_INTERVAL_MINUTES=30
FALLBACK_DURATION_MINUTES=30
BUSY_APT_STATUSES=1
CORS_ORIGINS=https://lukdental.us
PATIENT_FILE_STORAGE_ENABLED=true
PATIENT_FILE_STORAGE_DIR=G:\Online Patient Information
MAX_BOOKING_FILES=5
MAX_BOOKING_FILE_MB=10
```

Optional SMTP email settings:

```env
SEND_EMAILS=true
SMTP_HOST=smtp.your-host.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=booking@lukdental.us
SMTP_PASSWORD=your-smtp-password
EMAIL_FROM="Luk Dental <booking@lukdental.us>"
EMAIL_REPLY_TO=booking@lukdental.us
ADMIN_EMAILS=booking@lukdental.us
SEND_CUSTOMER_EMAIL=true
CLINIC_NAME=Luk Dental
```

Email is sent only after the Open Dental booking is created. If SMTP fails, the booking remains created and the API response includes the email error for troubleshooting.

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
- Start with `opendental_test`; only switch to production DB after the POC is verified.
- Use the narrowest DB grants possible. Slot lookup needs `SELECT`; booking creation needs `SELECT`, `INSERT`, and `UPDATE`.
- Keep `PATIENT_FILE_STORAGE_DIR` outside any public web directory. The current production target is `G:\Online Patient Information`.


## MetLife API — integrated in the same Bridge

MetLife is mounted by `src/server.js` at `/api/metlife` and uses `src/db.js`'s existing MySQL pool. It has no separate backend, port, database credentials, or startup process. `npm start` serves the booking/SMS/admin routes and MetLife routes together through the existing Bridge address/tunnel.

- `GET /api/metlife/health`
- `GET /api/metlife/patients?q=...&kind=all|name|patientId|subscriberId|groupNumber&page=0`
- `GET /api/metlife/patients/:patNum/documents`
- `GET /api/metlife/patients/:patNum/documents/:docNum/pdf`
- `GET /api/metlife/patients/:patNum/context`
- `GET /api/metlife/patients/:patNum/pending`
- `POST /api/metlife/operations` — validate plan and lock one operation
- `POST /api/metlife/operations/:id/recheck` — fresh validation before Save
- `POST /api/metlife/operations/:id/verify` — read back Payment/Splits
- `POST /api/metlife/operations/:id/abort` — release only when financial data is unchanged

For the existing Windows Git installation, run `od-bridge.bat` (also available as `start-bridge-and-tunnel.bat`). It pulls `origin/main` with `--ff-only`, installs locked dependencies, initializes MetLife configuration without replacing DB/API settings, restarts the Bridge listener, checks `/health`, and retains the existing tunnel. On the first update, pull once to obtain this launcher. See [CAP-NHAT-METLIFE.md](CAP-NHAT-METLIFE.md). Electron 0.3.2 connects automatically to `http://SERVER:3008` on the trusted clinic LAN without sign-in or file import. Direct desktop requests must have private sockets and the actual server hostname/IP; browser, public-host and forwarded/proxy requests still require authentication. Clinic LAN machines therefore have MetLife access. Ensure DNS and inbound TCP 3008 work on the private clinic network; `METLIFE_SERVER_URL` may override the desktop LAN address. Service-managed installations must restart through their existing supervisor.

The financial tables are read only through these APIs. Financial changes go through the R5 Open Dental UI driver. The private operation journal contains patient context; keep it outside public web directories. Run `npm run test:metlife` for the API/posting tests. Driver implementation is present but has not been verified on the actual R5 workstation.
