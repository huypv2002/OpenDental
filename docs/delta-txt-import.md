# User-converted Delta TXT import

Put a user-created `.txt` file into `D:\SHARE\INSURANCE CLAIM\DELTA DENTAL`. Supported layout: Delta Dental Provider Tools as in the supplied 1279 TXT, with patient name/DOB/Subscriber ID, claim number, sent date, six monetary columns per service and Claim total. TXT support is now extended to all four carriers; see [insurance-txt-import.md](insurance-txt-import.md) for the current workflow and requirements.

Direct TXT input does not invoke PDF conversion or OCR. PDF input now automatically converts through Scribe.js; see [pdf-to-text-import.md](pdf-to-text-import.md). It reads UTF-8 (with or without BOM) or UTF-16 with BOM. `$34 00` is read as `$34.00`; only explicit dollar amounts with exactly two separated cents digits are normalized. The warning records that formatting change. Digits are never guessed, and all existing benefit and six-column claim-total reconciliation checks remain active.

The existing patient matching, fee settlement, claim payment verification, daily Excel and PROCESSED workflows are reused. The original TXT bytes and extension are retained in Finished Claims/AtoZ and PROCESSED; no PDF is generated. Electron history can display the text and open the original file. UTF-16 responses advertise the original encoding.

Validation: synthetic encoding/error cases, folder scanner through posting twice after rename with persistent simulated database state (one payment, two splits, one document), original-byte archive retrieval, and the actual user TXT parse to $232.00. No real SERVER database or SMS is touched. Native Open Dental handling of TXT attachments and packaged Electron preview need verification on Windows. New PDF-to-text conversion dependencies are not installed.

Run `DELTA_TEXT_TEST_FILE=/private/path/1279.txt node --test src/delta/textDocument.test.js` for the optional actual TXT regression. Do not commit patient source files.
