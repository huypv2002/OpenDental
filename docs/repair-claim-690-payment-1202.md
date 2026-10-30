# One-time repair: patient 690 / existing payment 1202

Run from the existing Bridge checkout on SERVER using its `.env` database
configuration. This is separate from the folder scanner: it does not create
a new payment or reprocess the EOB. No Bridge restart is needed for this script.

Close the OD Payment editing window first, without saving unreviewed manual
changes. Keep Open Dental installed/available for its native split hash helper.
Then update and run:

```bat
git pull --ff-only origin main
SUA-CLAIM-690.bat
```

The BAT first prints a SELECT-only preview. Choose N to stop, or Y to apply
the displayed repair. Equivalent commands for an operator who prefers a shell:

```bat
node scripts/repair-claim-690.mjs
node scripts/repair-claim-690.mjs --apply
```

## Exact scope

- Requires patient 690 MINH BUI, Insurance Paid payment 1202, amount $77.20,
  payment date 2025-10-15 and claim 5101035732 in the payment note/ExternalId.
- Requires exactly two splits: completed D0150 $38.00 and D0120 $39.20, with
  service dates 2025-09-19. Patient/provider/clinic must agree. Unexpected
  adjustment, transfer, payment-plan, unearned or actual claimproc insurance
  links stop the repair.
- Adds completed D0210 on 2025-09-19 with charge $74.00 if missing. An existing
  unique completed $74 D0210 with the same provider/clinic can be reused. It
  must not already have another allocated payment. The D0210 catalog code
  must already exist and be a visible mouth-level service.
- Moves only the existing $39.20 split's ProcNum and recalculates SecurityHash
  using the installed native OD helper. SplitNum, amount, dates, patient,
  provider and clinic stay unchanged. The entire payment row and $38 split
  stay unchanged. No D0120 row is renamed, removed or re-priced.
- A new D0210 is an additional $74 charge. Its creation adds $74 to the
  patient's cached BalTotal; existing unrelated balance components are not
  recalculated from an incomplete ledger. If D0210 already exists, no balance
  increase is applied. Review the account/aging in OD after the repair.
- OD securitylog records Completed Procedure Create (23) and Payment Edit (16)
  with securityloghash. UserNum is the system sentinel 0, not an employee ID.

## Backups and interrupted runs

The script saves complete before/after patient, payment, split, procedure and
claimproc snapshots under `metlife-backups/repair-690-1202/repair-journal.json`.
This folder is ignored by Git and contains private clinic information. Keep
it private and retain the original EOB. The intent file is flushed to disk
before any clinical mutation, while the involved tables are locked. Hash
helper work runs before acquiring table locks. The locked data must still
match preflight before proceeding.

MyISAM cannot roll back. A failed/interrupted write leaves the intent journal
in place and blocks automatic apply retries. Do not delete this journal to
force another run. Inspect it and the live rows before any manual recovery.
The script never automatically deletes newly created procedures or payments.
Completed reruns verify the already-correct split and perform no writes.

Open Dental/DB must be version 24.3, the procedure table must support normal
auto-increment inserts without a separate procedure hash, and unsupported
accounting/date-lock/random-key preferences stop apply. Direct-write disable
configuration is honored. The script does not modify scanner history or
archive files: do not re-add this already-paid EOB to generate another payment.

Validation: simulated DB tests exercise preview-only operation, missing and
existing D0210, unchanged payment/D0120/$38 split/other records, balance delta,
audit logs, idempotent replay, mismatching data, stale preflight, failed hash
helper/backup, and partial-write retry refusal. No live repair or Windows run
has been performed by these development tests.
