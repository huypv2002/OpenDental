# Procedure fee columns — confirmed 28/10/2026

Procedure Amount (`procedurelog.ProcFee`) is separate from the insurance payment and its paysplits. For paid EOB service rows, use:

| Carrier | Procedure fee source | Parser field |
| --- | --- | --- |
| MetLife | Fee Charged | feeCents |
| Liberty | Allowed Amount | allowedCents |
| CIGNA | Amount Charged | feeCents |
| Delta Dental | Accepted Fee | allowedCents |

Example: MetLife D5225 with Fee Charged 950.00 and Plan Benefit 475.00 must have procedure Amount 950.00 and insurance payment/split 475.00. Never replace a missing fee column with the benefit amount. Liberty Submitted Amount and Delta Submitted Fee remain available as original source data, but do not set the procedure fee.

Updated clinic confirmation, 30/10/2026 16:05: for paid MetLife D0210 Allowable, use an explicit Fee Charged when present, otherwise Covered Expense, otherwise $150. Derive a missing service date from the X-ray rows explicitly marked as grouped (65/J); their dates must agree. If a D0210 is missing, add it through the audited procedure-creation path. Never substitute D0120 or use the benefit as the charge. This supersedes the earlier preserve-existing-fee-only fallback. History keeps the original EOB fields and separately records resolved fee/date and their sources. The payment itself still uses MetLife's processed date.

The same fee selection is used for existing services, newly created services, creation readback and audit receipts. Related claimproc FeeBilled and claim totals follow the selected procedure charge. Other patients/claims remain outside the settlement scope. Existing rules for denied/bundled rows and missing-service eligibility are unchanged.

On replay, the processor first verifies the saved patient's claim, payment date, amount and every split. A conflict still requires review. An exact matching saved payment can have the old benefit-as-fee corrected without creating another payment, split or attachment. Once procedure/claim fees agree, further replay does not repeat fee edits. History records the correction. Reprocessing is explicit: the scanner does not automatically rescan PROCESSED.

Validation covers distinct submitted/accepted/paid values for all four carriers, new and existing services, correction of old fees on exact-payment replay, unchanged payment allocations, missing fee columns, fee idempotency and preservation of unrelated records. All posting tests use simulated clinic state. Real private 1041/584/1283/621 regressions cover multi-patient Liberty and MetLife quadrants. No live financial record was changed by development/tests.

Deploy the updated source to SERVER and restart Bridge. For an already-processed file such as 1004, the update alone does not rewrite its saved procedure: explicitly reprocess the original file to run the verified replay correction, or correct the procedure in OD after reviewing the source EOB. Do not delete/recreate the existing payment.
