# Automatic PDF to TXT conversion

PDF files placed in the four insurer folders now use the pinned `scribe.js-ocr@0.16.1` library. Native PDF text is extracted; scanned pages are recognized internally by the library. The application no longer runs its old per-cell OCR reader for incoming PDFs. JPG/JPEG/PNG keep their existing image path. Direct user TXT import remains supported.

The full workflow is PDF -> Scribe word/text data -> aligned TXT -> existing insurer parser -> patient/procedure matching -> verified settlement -> original PDF in Finished Claims -> PROCESSED and daily Excel. There is no remote document-conversion API and no patient document upload. English recognition assets are loaded from the already-installed `@tesseract.js-data/eng` package, not a model CDN.

Generated text is saved under the incoming insurer folder, for example:

`D:\SHARE\INSURANCE CLAIM\DELTA DENTAL\TEXT\1279.pdf.<source-hash>.txt`

TEXT is a subfolder outside the flat input listing, so generated files do not trigger another payment. The original PDF hash, bytes, name and archive remain the source of truth for attachments/history. Metadata records the converter and generated text path. Existing PDF/TXT replay protections still compare patient, claim, payment date, amount and every split; they do not rely on filename alone.

Scribe's logical reading order can separate table columns. The layout adapter reconstructs visual rows and character positions from the library's word boxes, retaining page boundaries. MetLife/CIGNA use their tested TXT column mapping; Liberty/Delta reuse their existing financial validation. No CDT characters or monetary digits are substituted to make validation pass.

Scanned PDFs receive several full-page library readings. Native PDFs do not undergo forced recognition. Valid candidates must agree on claim identifiers, subscriber/date-of-birth identifiers, financial amounts and procedure areas. Name text requires a unique corroborated reading when multiple valid candidates exist, followed by normal strict Open Dental patient resolution. Missing versus explicit lower-arch notation for D5214 has the same canonical area. The supported automatic Delta Provider Tools claim-number format is 14 digits; unsupported/incomplete identifiers require review instead of inferring missing digits.

The converter handles a 30 MB / 10-page maximum in an isolated child process, with a 120-second timeout and private temporary input/model/output files cleaned up on success or failure. Conversion is asynchronous so the main Bridge process is not occupied by synchronous recognition. A corrupt document, timeout, unreadable financial data or conflicting readings stops before payment posting.

A TXT file is also retained when the library produces text that fails claim validation. The error points to that text for comparison; TXT creation alone never means payment succeeded. Known limitation: the supplied scanned Delta 1012 still has ambiguous CDT/monetary text in Scribe's output and is intentionally refused for automatic payment. Its previous dedicated Delta reader can parse it, but this new PDF path does not silently fall back to that per-cell reader. Staff may import independently converted, correct TXT using the existing direct-TXT path. Never edit guessed digits to bypass reconciliation.

Validation includes native/scanned private fixtures from all four insurers, the actual 1279/423 examples, MetLife quadrant 621/584, Liberty multiple patients, source-preserving PDF attachment storage, PDF/TXT replay using a persistent simulated clinic, failure before DB access, generated-TXT scan exclusion, ambiguous claim-number handling and existing insurance regression suites. Private documents are not committed. The synthetic PDF fixture now contains real table headings so the new column-preserving path can be exercised rather than bypassed in tests.

## SERVER update

From the repository root on SERVER run `git pull`, then `npm ci`, then restart with `npm start`. The new dependency must be installed on SERVER. No separate Python, Tesseract CLI or Windows conversion executable is required. No `.env` switch is required: automatic PDF conversion is the default incoming-PDF path.

Windows execution and native Open Dental/Phone Link behavior are not proven by local macOS tests. The converter itself never sends SMS or alters existing financial records; only the normal validated posting path creates a payment.

## Local checks

`EOB_PDF_TO_TEXT_DIR=/private/fixture/folder npm run test:metlife` enables actual library conversion fixtures. The 1012 test verifies TXT production plus refusal of ambiguous data rather than claiming a reconciled automatic payment. Other optional fixture variables remain unchanged. Test helpers may inject native extraction or synthetic conversion; production scanner calls use Scribe by default.
