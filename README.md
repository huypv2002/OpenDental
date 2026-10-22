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

Format regressions can additionally use `LIBERTY_TEST_SINGLE_PDF`, `LIBERTY_TEST_MULTI_PDF`, and `LIBERTY_TEST_SINGLE_IMAGE`. The PDF matrix checks the original PDF, a JPEG rendered from its claim page, and an image-only PDF against the same patient/member/claim/service/date/amount data. JPEG processor tests use a simulated DB and verify per-patient isolation, PDF document copies and preservation of the original image. Missing optional fixtures are explicitly skipped. Local results do not establish successful processing on the clinic's SERVER or validate every future EOB layout.

## CIGNA claim folder

The scanner also watches `D:\SHARE\INSURANCE CLAIM\CIGNA` beside METLIFE and LIBERTY. CIGNA currently supports the supplied text-based portal PDF layout, including a claim table continuing onto later pages. It uses the common Insurance Paid payload, blank check number, `Claim number: <claim>` note, Finished Claims import, archive and daily Excel report. CIGNA document filenames start with `CIGNA_`, and history/Excel preserve the CIGNA carrier label. Images and scanned CIGNA PDFs require review rather than being interpreted as Liberty images.

For this confirmed CIGNA workflow, payment is the sum of the **Plan Coinsurance Paid** service values. Zero summary/header values do not override positive, reconciled service values; a conflicting nonzero summary stops processing. Each service's amount must agree with Covered Balance multiplied by its displayed percentage. All other table totals must reconcile across the complete PDF. Processing requires `PROCESSED` status; the payment date is `Date Processed`.

An alternate benefit row with zero submitted charge is paired with exactly one original charged service on the same tooth/date. The saved split uses the original OD code and the alternate paid amount. The supplied sample becomes D2392/tooth 30 = $56.80 and D2392/tooth 31 = $56.80, total $113.60, dated 2026-10-15; D2150 is retained in the source audit rather than posted as an extra service. Ambiguous replacements, missing continuation pages and mismatched totals go to review before financial writes. Patient matching checks exact names, a unique CIGNA insurance association and the numeric patient filename when available; completed services must uniquely match code/date/tooth.

Read-only inspection (no DB connection or payment):

```powershell
node scripts/inspect-cigna-eob.mjs 'C:\path\1275.pdf'
```

`CIGNA_TEST_PDF` enables an optional real-file regression during `npm run test:metlife`. Mock DB tests also cover split-tooth isolation, normalized payload, CIGNA Finished Claims filenames, history, archive and Excel. Real clinic writes remain a separate deployment verification.

## Daily insurance Excel report

After each automatic scan, successfully saved MetLife, Liberty, CIGNA and Delta Dental claims are appended to a daily workbook. With the standard `D:\SHARE\INSURANCE CLAIM\METLIFE` incoming path, the output is `D:\SHARE\INSURANCE CLAIM\EXCEL\YYYY-MM-DD.xlsx`, beside METLIFE and LIBERTY, dated by the SERVER's local calendar. `INSURANCE_EXCEL_DIR` can override the output directory. A day with no successful records does not create an empty workbook.

`PAYMENTS` follows the supplied 15-column layout, with one row per EOB service and grouped patient/payment totals. `DATE` is the service date; `INSUR PAID DAY` is the EOB payment date (MetLife Processed date / Liberty Check Date). `CHARGE` is the matching completed procedure's actual fee in OD at first export. `INSUR BILL` is the submitted EOB fee, and `INSUR PAY` is the insurance benefit per service. `CREDIT` is the saved claim payment. `TOTAL` sums the group's charges; `BALANCE` is that group's total minus credit, not the patient's entire account balance. Unknown procedure fees and dependent totals stay blank rather than becoming zero. `PAYMENT` is `CREDIT`; `STATUS` is `Đã lưu`.

`TONG HOP` counts unique source files, saved claims, and their total payment. A multi-patient EOB counts as one file and multiple claims. Persisted payment, claim and source identities prevent re-scans or renamed copies from adding duplicate groups; a hidden internal sheet stores those identities. Existing exported groups and staff cell edits are preserved when new groups are appended. Keep the daily workbook's main header and internal sheet intact.

Legacy successful history entries can lack the payment date or EOB service details. Those entries appear separately in `CAN DOI CHIEU`, with the known patient/claim/payment information and the missing-data reason. Valid entries still export to `PAYMENTS`. `TONG HOP` distinguishes exported records/totals from the count awaiting review. Pending dates remain eligible for report-only recovery; correcting the history data lets the next scan append a recovered record once and clear its review entry. This does not recreate the OD payment or invent missing service data.

The exporter accepts history details returned as TEXT, Buffer or mysql2 JSON objects. For legacy entries missing dates/services, it can recover from the existing payment and linked paysplits only after matching the patient, total payment, procedure dates and split sum. The original submitted EOB fee remains blank when it cannot be recovered, and the carrier is marked unknown when no carrier information is available. Duplicate history for the same source/claim does not add more groups. Every successful export logs the absolute filename and confirms a nonempty file on disk, including reports containing only review entries.

MetLife `Allowable` replacement lines can omit their service date. The Excel exporter resolves that date only through a uniquely matched OD procedure linked to the saved payment; it does not copy a neighboring EOB date. An unknown submitted fee remains blank and does not block the otherwise reconciled claim. Missing linked dates still appear with the affected service codes in `CAN DOI CHIEU`. Updating this generated tab rebuilds it cleanly, repairing repeated headers left by older versions and grouping duplicate review records for the same patient/claim/amount.

To create/retry a report explicitly in a known folder without scanning PDFs or creating any payment:

```powershell
node scripts/export-insurance-excel.mjs 2026-10-21 --dir 'D:\SHARE\INSURANCE CLAIM\EXCEL'
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

## Delta Dental claim folder

The scanner watches `D:\SHARE\INSURANCE CLAIM\DELTA DENTAL` alongside the other carriers. The supported layout is Delta **Provider Tools / Fee for service**, including the supplied two-page scanned PDF. PDF/JPG/JPEG/PNG processing uses local OCR when needed; arbitrary Delta layouts require review. Existing Liberty OCR remains separate.

Payment uses this claim's reconciled **Claim total / Delta Dental pays**, with **Date payment sent** as the payment date. The deposit `Amount` may cover multiple claims and is retained for audit, not used as the claim payment. For the confirmed `280.pdf` example, this means **$154.00 on 2026-06-17**, not the $187 deposit amount. Blank Check #, `Claim number: <claim>` note, Finished Claims PDF import, history, archive and daily Excel use the common workflow; document filenames start with `DELTA_`.

Exact table rows repeated at the page boundary are removed only as a suffix/prefix overlap. A denied charged row and a single paid adjustment with the same code/date/tooth are combined, preserving the submitted charge. All six resulting money columns must reconcile with Claim total, and benefits must match the displayed allowance/deductible/percentage. Missing pages, uncertain OCR and ambiguous matches stop for review before writes. Every patient must uniquely match name, DOB, Delta carrier and Subscriber ID, plus the numeric patient filename when available. Completed OD services must uniquely match code/date/tooth before importing documents or updating fees.

Read-only local inspection (does not connect to the DB or submit payments):

```powershell
node scripts/inspect-delta-eob.mjs "D:\SHARE\INSURANCE CLAIM\DELTA DENTAL\280.pdf"
```

Set `DELTA_TEST_PDF` to a private sample path to enable the real scanned-file regression in `npm run test:metlife`. Simulated DB tests cover payload, document, history, archive and Excel. These tests do not establish a successful deployment or financial write on SERVER.
