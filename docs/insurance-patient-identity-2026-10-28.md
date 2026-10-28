# Patient identification — clinic rule confirmed 28/10/2026

The user confirmed this rule with Nhân. It supersedes earlier name-matching rules. Descriptive notes in supplied attachment filenames are reference context, not additional change requests.

| Carrier | Patient identity |
| --- | --- |
| MetLife / CIGNA / Delta Dental | PatNum at the beginning of the filename. Do not compare the EOB name, DOB or subscriber to select the patient. |
| Liberty | Subscriber ID from each patient claim block. Ignore filename PatNum and printed patient names for identity. |

Non-Liberty examples: `1004.pdf`, `1004.txt`, `1792789329060_423.pdf`, `1283 DELTA SAMPLE.pdf`. Download/archive timestamp prefixes and descriptive suffixes are supported. A timestamp by itself, arbitrary embedded numbers or a missing/nonexistent patient number require review. Never fall back to a different patient by name. Every claim in a non-Liberty file follows the filename's patient; separate multi-patient files by patient number.

Liberty first tries the complete Subscriber ID. If no patient matches, it tries the ID without a trailing numeric dependent suffix, accommodating OD records that omit `-01`. Either lookup must identify exactly one patient. Multiple patients sharing an exact or base ID require review; the resolver does not choose by name or pick the first result. All claims pass read-only patient/procedure/settlement preflight before the first document or financial write.

## Supplied multi-patient Liberty fixture

The 1041 PDF contains two claims under one check, not a single patient payment. Read-only SERVER API lookups confirmed the linked patient/subscriber records:

| Claim | OD patient | Claim payment | Service rows |
| --- | --- | --- | --- |
| 77361505 | 1041 — VANG DOAN | 1483.00 | 2 |
| 77362477 | 1280 — MY NGUYEN | 250.00 | 7 |

The total is 1733.00. The first patient's OD Subscriber ID omits the source's numeric dependent suffix; the second retains it. The processor keeps payments, splits, documents and history scoped to each resolved patient. Existing procedure matching, financial reconciliation, estimate/write-off settlement and duplicate-payment checks remain active.

## Validation and deployment boundary

- All 12 supplied PDFs parsed without claim errors, including scanned Delta PDFs through the existing local OCR reader.
- All 12 were processed and replayed after renaming in persistent simulated clinic state, with intentionally different OD names. They preserved each patient's amount/splits and reused payments/documents without adding procedures. The Liberty fixture used the two patient numbers above and the observed ID suffix variants.
- Unit tests execute the identity SELECTs against an in-memory SQL database, including missing filename numbers, missing patients, exact Liberty IDs, base-ID fallback, ambiguous/shared subscribers and no name fallback.
- Optional real-PDF regression: `EOB_CURRENT_FEEDBACK_DIR=/private/fixtures LIBERTY_TEST_MULTI_PDF=/private/fixtures/1041.pdf npm run test:metlife`. Keep patient PDFs and extracted evidence out of Git.

PDF parsing and simulated posting are not proof of Scribe conversion, native Windows hashes, or live financial posting. This change does not fix the separately reported stopped PDF-to-TXT library. Live API access was SELECT-only. No SERVER financial records were changed. Install the updated Bridge source and restart its service on SERVER to activate the new identity rules; no Electron UI change is required.
