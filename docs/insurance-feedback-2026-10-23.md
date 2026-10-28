# Insurance feedback — 23/10/2026

## Requirements

- [x] Insurance Estimate and Write-off are explicitly zero for the resolved claim/procedures in MetLife, Liberty, CIGNA and Delta, including overrides; unrelated patients, claims and insurance plans are preserved.
- [x] CIGNA 493: preserve tooth 03 as tooth 3; reconcile five $84 splits to $420. The $704 payment batch is not the individual claim payment.
- [x] Liberty 1282: five services, $167, check date 2026-10-07. Follow the MetLife matching convention for a unique code/date. Require tooth agreement when a code/date is repeated. Preserve source versus OD tooth differences in history.
- [x] Liberty 1041: two patient claims ($1483 + $250), $1733 overall, check date 2026-10-02. Preflight every claim before the first write. Resume a previously completed claim without deleting/recreating its Payment or PDF.
- [x] Keep MetLife 1307 ($439.20, processed 2026-09-29) and supplied MetLife 1278 ($442, processed 2026-09-22) as regressions. SERVER logs also contain another 1278 claim for $35; it is a different claim and must remain separate.
- [x] ERRORS/REVIEW do not restart themselves every 30 seconds. Explicit retry preserves incoming files with the same filename.
- [x] Excel prints a clear update message when rows change, without repeating “file already exists” every scan; report retry stays separate from payment posting.
- [x] Verify all six supplied PDFs and meaningful simulated DB workflows; no clinic credentials or documents committed. Document local versus SERVER evidence.

## Evidence and design

SERVER logs confirm CIGNA 493 fails D2391 matching. Its original PDF uses tooth `03`, previously discarded by the parser. Liberty 1282 and the second patient in 1041 fail D0220 matching. The first patient in 1041 was repeatedly replaced while the second failed. Excel “File đã tồn tại ... Thêm 0 hồ sơ” was informational, not CIGNA's failure.

The EOB claim identifier is not the OD `ClaimNum`. Resolve actual claimprocs from patient, carrier, matched service IDs and one insurance subscription. Stop for review on ambiguous claim associations. Zero `InsPayEst`, `BaseEst`, `InsEstTotal`, `InsEstTotalOverride`, `WriteOff`, `WriteOffEst`, `WriteOffEstOverride`; read them back while locked. An override of 0 is deliberate; -1 means no override. Recompute only the linked claim's estimate/write-off totals and received date. Do not clear actual insurance payments or reset all claims for a patient.

Existing ledger payments must match patient, claim, payment date, amount and complete procedure/provider/clinic/date allocations. A verified match is reused; an inconsistent or incomplete match is parked for review. No payment/paysplit deletion. Reuse identical Finished Claims PDFs and use UUID filenames for new copies.

References: [Open Dental ClaimProcs API fields and override semantics](https://www.opendental.com/site/apiclaimprocs.html), [Account Module insurance estimate](https://www.opendental.com/manual/account.html).

## Verification

Verified with the current source: `npm run test:metlife` reports **129 tests, 127 passed, 0 failed, 2 skipped**. Both skipped tests require a real test MariaDB and were not run against the clinic.

The six private feedback PDFs were exercised through their actual readers/processors using a persistent simulated clinic DB, native-hash test doubles, real document files and real Excel workbooks. Each case verifies total/date, blank check, claim-only note, seven zero estimate/write-off fields, unaffected unrelated claim/service, document and history, Excel output, then repeat processing with unchanged Payment/Doc IDs, no additional splits, no fee updates and no native-hash invocation. CIGNA verifies all five tooth-specific splits, including tooth 3.

Additional 1041 tests prove: (1) an ambiguous second-patient service blocks the first write; (2) a failure after the first patient's successful payment resumes without replacing that payment or document. Tests cover conflict/partial-payment rejection, zero-value readback failure, changed claim association, foreign patient/claim preservation, and explicit retry without overwriting an incoming file.

No clinic financial write was executed during development. Actual SERVER/client display after deployment remains unverified. No retrospective clinic-data cleanup is performed by this change.

## Delta 1012: FLB radiograph bundling

The supplied two-page scan has five service rows, including three zero-benefit radiographs marked FLB and a paid D0210 complete series. Submitted fees sum to $386, while Claim total correctly excludes the $143 of bundled radiographs and shows $243. Benefits reconcile to $115 ($42 D0150 + $73 D0210); payment sent date is 2026-04-30. The $230 deposit header is separate from this claim's benefits.

Preserve explanation codes during OCR. Allow the submitted-fee exclusion only with the FLB explanation in the same claim, eligible zero-value radiographs, one paid D0210 on the same date, combined radiograph fees at least the series fee, and an exact adjusted total. All other money columns must still reconcile. Preserve original service rows and submitted fees in parsed history/report data. Missing evidence and inconsistent financial totals still stop processing.

Private PDF regression: `DELTA_FLB_TEST_PDF=/path/to/1012.pdf node --test src/delta/parser.test.js`. Patient documents remain outside the repository.

After this fix, the full four-carrier suite with the original private fixtures and the new FLB scan reports **132 tests, 130 passed, 0 failed, 2 skipped** (real database tests). The Delta suite alone passes all 11 tests with both scanned PDFs enabled. No live clinic payment was written.

## Add missing paid services (all four carriers)

Per the subsequent clinic instruction, retain every positive insurance-benefit allocation in the validated claim. When the patient's completed service is absent, create a completed procedure for that patient with the EOB service date/tooth/surface, primary provider and clinic, and a procedure fee selected from the carrier-specific column confirmed on 28/10/2026; see [procedure fee rules](insurance-procedure-fees-2026-10-28.md). This supersedes the earlier benefit-as-fee convention. Zero-benefit rows do not create procedures. Missing dates, unreadable anatomy, ambiguous duplicate rows and pending matching procedures require review.

Use an existing procedurecode when present. A missing catalog code is added with its source description (or the code itself), source treatment area, and first visible procedure category. These are minimal source-based catalog entries, not a replacement CDT catalog. Refresh/reopen OD to load newly added catalog entries.

Read-only preflight covers all claims before service creation. Creation rechecks the patient/provider and existing service under table locks, reads back saved identity/amount, and records the addition in `luk_eob_added_procedures` and successful processing history. Typical auto-increment OD schemas are supported; unsupported keys, required column types or procedure-level security hashes stop for review. No existing planned procedure is automatically marked complete.

If a later PDF/hash/payment step fails, an already-created service remains in the patient's account; retry reuses it. Payment matching and duplicate protection remain active. Tests exercise actual private PDFs through simulated persistent ledgers for each carrier, including a missing catalog entry, preserved allocation amounts and repeated processing without a second service or payment. Live SERVER creation remains unverified.

## D4341/D4342 quadrant matching

The service-creation duplicate check originally compared code/date/tooth without OD `Surf`. Multiple periodontal quadrants can share the same code, date and blank tooth. Preserve explicit MetLife UR/UL/LR/LL (including Q01-Q04 labels) from the procedure area and include the quadrant in duplicate checks, service matching and scoped insurance defaults. Completed-service queries read `Surf`; new quadrant procedures store it correctly. MetLife fee updates and history use the exact matched ProcNum for each paid row, avoiding a first-by-code allocation.

Synthetic regressions cover two same-code/day quadrants with different amounts totaling $468.80, separate fee/split/history IDs, a missing third quadrant, true duplicate rejection, missing-quadrant review and retry without another payment.

The subsequently supplied 621.pdf confirms six paid rows: D4342 UR ($56.80), D4341 LR/UL/LL ($93.60 each), and two D2391 rows ($65.60 each, teeth 05 and 12), totaling $468.80. Preserve leading-zero tooth 05 as numeric tooth 5. Use verified money-column headings when available: this layout's old fee range accidentally included Negotiated Fee, and Covered Expense included Deductible. The corrected parser reads all six submitted fees. The actual PDF passes reader -> simulated ledger -> six scoped fees/splits -> Finished Claims -> Excel without review rows; repeat preserves the original payment/document. Clinic data was not written. Optional private fixture: `METLIFE_QUADRANT_TEST_PDF=/path/to/621.pdf node --test src/metlife/quadrantProcedures.test.js`.

Excel EPERM/EBUSY/EACCES keeps the report pending and preserves the existing workbook. The log now directs the operator to close the workbook on every machine and check write permissions if needed. Report retries never rerun payment posting.
