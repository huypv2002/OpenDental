# User-converted Delta TXT import

Put a user-created `.txt` file into `D:\SHARE\INSURANCE CLAIM\DELTA DENTAL`. Supported layout: Delta Dental Provider Tools as in the supplied 1279 TXT, with patient name/DOB/Subscriber ID, claim number, sent date, six monetary columns per service and Claim total. TXT support is now extended to all four carriers; see [insurance-txt-import.md](insurance-txt-import.md) for the current workflow and requirements.

Direct TXT input does not invoke PDF conversion or OCR. PDF input now automatically converts through Scribe.js; see [pdf-to-text-import.md](pdf-to-text-import.md). It reads UTF-8 (with or without BOM) or UTF-16 with BOM. `$34 00` is read as `$34.00`; only explicit dollar amounts with exactly two separated cents digits are normalized. The warning records that formatting change. Digits are never guessed, and all existing benefit and six-column claim-total reconciliation checks remain active.

The existing patient matching, fee settlement, claim payment verification, daily Excel and PROCESSED workflows are reused. The original TXT bytes and extension are retained in Finished Claims/AtoZ and PROCESSED; no PDF is generated. Electron history can display the text and open the original file. UTF-16 responses advertise the original encoding.

Validation: synthetic encoding/error cases, folder scanner through posting twice after rename with persistent simulated database state (one payment, two splits, one document), original-byte archive retrieval, and the actual user TXT parse to $232.00. No real SERVER database or SMS is touched. Native Open Dental handling of TXT attachments and packaged Electron preview need verification on Windows. New PDF-to-text conversion dependencies are not installed.

Run `DELTA_TEXT_TEST_FILE=/private/path/1279.txt node --test src/delta/textDocument.test.js` for the optional actual TXT regression. Do not commit patient source files.

## Identity mismatch diagnostics

For a single claim with an exact patient-number filename (`1279.txt`, `1279.pdf`, or a download timestamp followed by `_1279.pdf`), select that PatNum and verify given name and surname. Given-name spaces are ignored (`Van Anh` and `VANANH`); the existing final-given-name alternative (`Quoc Toan` / `Toan`) is retained. DOB, Subscriber ID and the attached insurance plan do not block this filename-bound lookup, per the clinic's updated instruction. A wrong patient number, missing patient or different name still stops payment. Financial validation and payment replay checks are unchanged.

Without a reliable single-patient filename (including multi-claim files), the existing full-name, DOB, Delta plan and Subscriber ID lookup remains in use. The diagnostic command reports optional DOB/insurance flags for information; they are not blockers for an exact filename-bound patient. Scanner errors report only blocking name/number mismatches for that path.

On SERVER, from the Bridge repository with its existing `.env`, run:

```bat
node scripts/inspect-delta-patient.mjs "D:\SHARE\INSURANCE CLAIM\DELTA DENTAL\ERRORS\1279.txt"
```

Use the current path if the TXT is elsewhere. This command only reads the TXT and performs SELECT queries. Its output contains match flags, patient number and claim number; it does not print Subscriber IDs or connection settings. A false flag identifies a field difference; only patientExists, firstNameMatches and lastNameMatches block filename-bound processing. This diagnostic does not modify patient records or retry payment.

The authenticated administrative API also supports `GET /api/admin/patients/:patNum/insurance` with the existing Bridge API token. It performs SELECT-only queries and returns the selected patient's name/DOB and linked plans (carrier, group, subscriber and Subscriber ID). It returns no-store responses, rejects invalid IDs, returns 404 for a missing patient, and caps the lookup at 50 insurance records. This route requires updating and restarting SERVER; the SMS API token does not grant access to the separately authenticated MetLife desktop routes. Do not put tokens or full clinical responses in diagnostics logs.
