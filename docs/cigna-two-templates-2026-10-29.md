# CIGNA — portal and payment-statement layouts

Both layouts use the existing CIGNA posting path and filename PatNum identity. Printed patient names do not select or reject the OD patient.

| Layout | Recognition | Procedure fee | Payment date |
| --- | --- | --- | --- |
| Portal, previously supported | Claim/Reference Number, Date Processed, Claim Amount Paid | Amount Charged | Date Processed |
| Explanation of dental payment | Cigna Dental, DOCUMENT / CLAIMANT / CLAIM, PROCESSED DATE, service rows | Amount You Charged | Processed Date |

The new statement has seven money columns plus a percentage: charged, contracted, eligible, deductible, remaining, coinsurance, percentage and plan-paid amount. The parser verifies header order, complete rows, valid dates, percentage calculations, the eligible/deductible/remaining relationship, and coinsurance plus payment. It then reconciles every money column, Amount paid by the plan, Customer's responsibility and Payment Summary across continuation pages. Missing pages, unclear rows, duplicate services without a tooth to distinguish them, mixed templates and conflicting totals require review before any DB access. This initially supports the verified statement layout; other copay/contract arrangements that do not reconcile require review.

## Updated on 30/10: multiple claims and document-only claim numbers

CIGNA now supports multiple claim blocks and patients within one PDF, including a page that finishes one patient and starts the next. Each block retains its own Processed Date, total, services, teeth and patient. The file's Payment Summary must equal the sum of claim payments; it is never allocated in full to each person.

A single-claim file still selects the clinic-assigned filename PatNum. A multi-claim file resolves each patient by Patient ID / Subscriber ID from the EOB, without name or filename fallback. Explicit numeric dependent suffixes, and CLAIMANT # when the EOB prints only the base ID, support the verified OD formats `TEST123 02`, `TEST123-02` and `TEST123*02`. A matching dependent-specific ID takes priority over a base subscriber record. Missing IDs, missing subscribers or multiple patient matches stop all claims before the first document/financial write. Legacy portal batches also require a readable Patient/Subscriber/Member ID per claim; a batch without IDs requires review.

Service labels may include `for Tooth#/Quad/Arch:30 (see note AA)`. Preserve the tooth/area and explanation reference. A zero-charged alternate-benefit line is combined with exactly one positive-charged original service with the same date and tooth only when both referenced notes explicitly describe alternate benefit. Payment follows the alternate benefit; the procedure code and Amount Charged follow the original service. Ambiguous/missing evidence requires review.

DOCUMENT # is now the claim number throughout new payment notes, ExternalId, history, log and document description. For example, `D262938009560` is shown and saved without `-01-002`. CLAIMANT #, source CLAIM # and Payment # remain separate metadata. Different claimant/claim sequences sharing one DOCUMENT # require review rather than silently merging people.

Earlier builds stored `DOCUMENT #-CLAIMANT #-CLAIM #`. The derived old key remains a replay alias: an exact saved patient/date/amount/split match is reused. On explicit replay, the old generated note, ExternalId, history claim number and matching attachment description are migrated to DOCUMENT # without creating another payment/history/document. Conflicting payments still stop. The history API also formats old CIGNA claim/note/description values for display before replay.

Updating source does not rewrite historical OD notes automatically. After deploying and restarting SERVER, explicitly replay the original PDF to migrate a previously saved note such as `Claim number: D262938009560-01-002`. Existing manual notes that do not exactly match the old generated note are preserved.

## Verification

Synthetic tests cover both CIGNA templates, rejected partial/changed/mixed documents before DB access, full statement posting and renamed replay with persistent simulated clinic state. The optional actual PDF test runs the production Scribe conversion and posting path with simulated DB/native hashes, then verifies one payment, six splits, one document and one history row across replay.

```sh
CIGNA_STATEMENT_TEST_PDF=/private/140.pdf CIGNA_MULTI_TEST_PDF=/private/1317.pdf npm run test:metlife
```

Patient PDFs/extracted text remain outside Git. Local success does not verify real Windows hashes or live OD posting. Deploy with git pull and restart Bridge; no new dependency is added. Original PDFs can then be retried through the usual input folder. The update does not automatically process existing REVIEW/ERRORS files.
