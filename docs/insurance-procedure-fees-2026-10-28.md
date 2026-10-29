# Procedure fee columns — confirmed 28/10/2026

Procedure Amount (`procedurelog.ProcFee`) is separate from the insurance payment and its paysplits. For paid EOB service rows, use:

| Carrier | Procedure fee source | Parser field |
| --- | --- | --- |
| MetLife | Fee Charged | feeCents |
| Liberty | Allowed Amount | allowedCents |
| CIGNA | Amount Charged | feeCents |
| Delta Dental | Accepted Fee | allowedCents |

Example: MetLife D5225 with Fee Charged 950.00 and Plan Benefit 475.00 must have procedure Amount 950.00 and insurance payment/split 475.00. Never replace a missing fee column with the benefit amount. Liberty Submitted Amount and Delta Submitted Fee remain available as original source data, but do not set the procedure fee.

Confirmed exception, 30/10/2026: when a paid MetLife D0210 Allowable replacement omits Fee Charged or service date, resolve exactly one existing completed OD D0210 (also matching the date if the EOB supplies one). Use its existing date for allocation and preserve its procedure fee and FeeBilled when the EOB omits the charge. Missing or ambiguous OD matches stop before document/financial writes; no service is created for this exception. History retains the original missing EOB fields and separately records the OD fallback. This does not change the MetLife processed-date rule for the payment itself.

The same fee selection is used for existing services, newly created services, creation readback and audit receipts. Related claimproc FeeBilled and claim totals follow the selected procedure charge. Other patients/claims remain outside the settlement scope. Existing rules for denied/bundled rows and missing-service eligibility are unchanged.

On replay, the processor first verifies the saved patient's claim, payment date, amount and every split. A conflict still requires review. An exact matching saved payment can have the old benefit-as-fee corrected without creating another payment, split or attachment. Once procedure/claim fees agree, further replay does not repeat fee edits. History records the correction. Reprocessing is explicit: the scanner does not automatically rescan PROCESSED.

Validation covers distinct submitted/accepted/paid values for all four carriers, new and existing services, correction of old fees on exact-payment replay, unchanged payment allocations, missing fee columns, fee idempotency and preservation of unrelated records. All posting tests use simulated clinic state. Real private 1041/584/1283/621 regressions cover multi-patient Liberty and MetLife quadrants. No live financial record was changed by development/tests.

Deploy the updated source to SERVER and restart Bridge. For an already-processed file such as 1004, the update alone does not rewrite its saved procedure: explicitly reprocess the original file to run the verified replay correction, or correct the procedure in OD after reviewing the source EOB. Do not delete/recreate the existing payment.
