# Direct user TXT imports — all four carriers

Users may still import their own TXT directly. PDF inputs now automatically use the Scribe.js converter described in [pdf-to-text-import.md](pdf-to-text-import.md). Direct TXT input bypasses conversion; no TXT-to-PDF conversion is performed. The original bytes and `.txt` extension are retained in Finished Claims/AtoZ and PROCESSED. Electron history displays TXT as text.

Place a TXT in the insurer's usual SERVER folder under `D:\SHARE\INSURANCE CLAIM`:

| Insurer | Folder | Supported structure |
| --- | --- | --- |
| MetLife | METLIFE | Claim Summary, Claim Detail and Payment Detail |
| Liberty | LIBERTY | PAYMENT DETAILS, patient claim blocks, seven service money columns |
| CIGNA | CIGNA | Processed claim, six service money columns, Plan Coinsurance Paid |
| Delta Dental | DELTA DENTAL | Provider Tools, six service money columns and Claim total |

TXT recognition uses content rather than relying on the folder name. Conflicting insurer signatures or unrecognized formats stop before database queries. This does not expand automatic PDF carrier detection.

UTF-8 with/without BOM and UTF-16 with BOM are supported. A form-feed character may preserve page boundaries. MetLife and CIGNA must retain the aligned whitespace/table columns from the original EOB; collapsing all spaces can lose the financial column identity and is rejected. Ordinary line wrapping and continuation pages still use each carrier's existing parser and validation. New insurer layouts are not guaranteed automatically.

Explicit currency `$34 00` is read as `$34.00`, preserving the value and original file. A formatting warning is retained. No digits or monetary values are invented.

The shared TXT reader reconstructs item positions from character offsets. MetLife headings anchor its existing financial and payment column mapping. CIGNA uses the source columns with its existing amount/percentage validation. Liberty text imports require subscriber matching and reconcile all seven totals. Delta retains the previously tested direct text logic and all six-column reconciliation checks. Normal posting, blank Check #, claim-only note, insurer-specific payment dates, zero insurance estimate/write-off, audit, payment/paysplit verification and daily Excel logic remain shared with PDF imports.

Validation:

- Synthetic MetLife, Liberty and CIGNA imports preserve amounts, processed date and arch/quadrant/tooth identity.
- Missing cells, changed totals, lost column layout, invalid encodings and conflicting carrier signatures stop before database queries.
- Persistent simulated clinic state processes TXT, renamed TXT and the same claim via the PDF posting path without a second payment or extra procedures. Two distinct source attachments may remain, with one payment.
- Original TXT bytes are retained. Daily workbook generation twice produces one report entry.
- Five private native-PDF fixtures (MetLife 1307/621/584, Liberty 1041, CIGNA 1275) have matching parser results when their existing text is represented as aligned TXT. This test-only layout serialization is not a production conversion feature. Tests cover continuation pages, files without form-feed, leading indentation and Liberty's multiple patients.
- Delta's actual supplied user TXT still reads $232.00. Private patient source files are not committed.

Run `INSURANCE_TXT_PDF_DIR=/private/pdf/folder DELTA_TEXT_TEST_FILE=/private/1279.txt npm run test:metlife` for the optional fixtures. These tests do not access SERVER or create real payments. Native OD attachment opening and packaged Electron rendering remain Windows acceptance checks.

After pulling source, restart the Bridge service on SERVER. Electron source users must restart the app to load UI help changes. The previous TXT preview implementation already supports the shared format; no new OCR/runtime dependency is added.
