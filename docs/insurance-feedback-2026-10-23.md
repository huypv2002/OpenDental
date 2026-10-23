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
