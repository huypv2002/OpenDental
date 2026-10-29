# CIGNA — portal and payment-statement layouts

Both layouts use the existing CIGNA posting path and filename PatNum identity. Printed patient names do not select or reject the OD patient.

| Layout | Recognition | Procedure fee | Payment date |
| --- | --- | --- | --- |
| Portal, previously supported | Claim/Reference Number, Date Processed, Claim Amount Paid | Amount Charged | Date Processed |
| Explanation of dental payment | Cigna Dental, DOCUMENT / CLAIMANT / CLAIM, PROCESSED DATE, service rows | Amount You Charged | Processed Date |

The new statement has seven money columns plus a percentage: charged, contracted, eligible, deductible, remaining, coinsurance, percentage and plan-paid amount. The parser verifies header order, complete rows, valid dates, percentage calculations, the eligible/deductible/remaining relationship, and coinsurance plus payment. It then reconciles every money column, Amount paid by the plan, Customer's responsibility and Payment Summary across continuation pages. Missing pages, unclear rows, duplicate services without a tooth to distinguish them, mixed templates and conflicting totals require review before any DB access. This initially supports the verified statement layout; other copay/contract arrangements that do not reconcile require review.

On this layout CLAIM # can be only `002`. To avoid collisions between unrelated claims, the stored claim identity is `DOCUMENT #-CLAIMANT #-CLAIM #`. Payment # is retained separately as a payment sequence. Per the 30/10 clinic instruction, the visible claim and Payment note show DOCUMENT # only: `Claim number: D262938009560`. The compound value remains an internal replay key. The processor recognizes both old compound notes and the new document-only note, verifies the full payment/splits, and shortens the exact old generated note on replay without changing payment amounts or creating a second payment. History display also shows DOCUMENT # only. Do not use the short claim sequence or deposit reference alone as the unique claim key. The legacy portal Claim/Reference identity is unchanged.

For the supplied 140 PDF, the reconciled identity is `D262938009560-01-002`, six services total 393.00, service date 2026-10-20 and Processed Date 2026-10-22. Payment Summary's deposit date is 2026-10-28 and does not replace Processed Date. The document includes continuation, definitions, blank and appeal pages; those pages do not create extra claims/payments. Read-only API lookup confirmed patient #140; no live payment was created during development.

## Verification

Synthetic tests cover both CIGNA templates, rejected partial/changed/mixed documents before DB access, full statement posting and renamed replay with persistent simulated clinic state. The optional actual PDF test runs the production Scribe conversion and posting path with simulated DB/native hashes, then verifies one payment, six splits, one document and one history row across replay.

```sh
CIGNA_STATEMENT_TEST_PDF=/private/1793288482937_140.pdf npm run test:metlife
```

Patient PDFs/extracted text remain outside Git. Local success does not verify real Windows hashes or live OD posting. Deploy with git pull and restart Bridge; no new dependency is added. Original PDFs can then be retried through the usual input folder. The update does not automatically process existing REVIEW/ERRORS files.
