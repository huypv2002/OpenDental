# Insurance feedback — 26/10/2026

- Liberty 1041: D5110/D5120 are complete upper/lower dentures. Carrier Q01/Q02 must not become periodontal UR/UL. Match the existing arch U/L, create a missing denture with Surf U/L, and reject existing duplicate procedure identities for review.
- MetLife 584: a unique completed code/date with a missing OD quadrant can be reused. Multiple candidates or a different explicit quadrant require review. If enough same-code/date procedures already exist but none match the area, preflight and the locked creation recheck stop instead of inserting another row. Dates are still mandatory: the supplied PDF's D4342 dates are 2025-08-22 and 2025-08-29; the latest screenshot only shows later 2026 activity and does not establish the stored D4342 dates.
- Delta 1283: normalize leading-zero tooth numbers before validation. The supplied claim reconciles to 205.60 with splits 55.20 / 75.20 / 75.20 for teeth 3 / 4 / 14. The deposit header combines claims and remains separate.
- Payment protection also finds exact `Claim number: ...` notes when ExternalId is empty. Patient, payment date, amount and every paysplit must still agree. Existing multiple payments or changed split procedure IDs stop for review; they are never overwritten or deleted.
- MetLife downloaded attachments now ignore a 13-digit timestamp prefix when resolving PatNum.

Open Dental's documented [procedure treatment areas](https://www.opendental.com/manual/procedurecodeedit.html) distinguish Arch from Quad. Existing catalog codes are not rewritten by this change.

## Verification

The real PDFs 1041, 584 and 1283 were read and exercised through persistent simulated clinic state. The tests verify no new procedures for existing matching rows, no duplicate payments on retry/rename, correct Delta allocations and refusal of conflicting anatomy. Tests with blank D4342 quadrants simulate one possible OD representation; the real 584 database fields remain unverified. No live financial records were changed.

Run `EOB_CURRENT_FEEDBACK_DIR=/private/folder npm run test:metlife` for the optional private fixtures; the folder should contain 1041.pdf, 584.pdf and 1283.pdf. PDFs are not committed. Existing 621 quadrant regression was also checked.

## Read-only SERVER diagnostics

From the Bridge repository on SERVER, using its existing .env:

```
node scripts/inspect-eob-procedures.mjs 584
node scripts/inspect-eob-procedures.mjs 1041
```

The command only selects code/date/status/tooth/Surf/fee fields and reports possible duplicate identities. It never adds services, changes fees or payments, or removes duplicates. Already-created procedures/payments require review in OD before another real posting attempt; this fix does not repair those records automatically.
