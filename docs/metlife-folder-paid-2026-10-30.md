# Clinic-confirmed paid incoming files

The clinic confirmed that placing a file into the insurance incoming folder
means payment has already been confirmed. MetLife's automatic folder path
therefore does not require PDF status Paid/Settled, method EFT/Check/ACH, or a
check/trace number. Source metadata remains unchanged. Parsed payment history
records `confirmationSource: clinic-incoming-folder`.

This policy is passed through PDF-to-TXT candidate selection and final folder
parsing, including direct TXT retries. Generic parsing remains strict. Amount
reconciliation, positive payment, claim identity, procedure allocation and
duplicate-payment verification still apply.

Latest confirmation (16:05) supersedes the earlier preserve-existing-D0210-only
rule. For a paid MetLife Allowable D0210:

- Use the explicit service date, or the single shared date of the grouped
  denied X-ray rows D0220/D0230/D0274/D0330 marked with notes 65/J.
- Use Fee Charged when present, otherwise Covered Expense, otherwise $150.
  Zero is a real value; negative/invalid amounts are rejected.
- Reuse a uniquely matching D0210 or add a missing one via audited creation.
  Ambiguous dates/matches require review. D0120 is never substituted.
- Keep benefit payment allocations separate from procedure charges. Preserve
  original missing EOB fields and record `bundleResolution` separately.

All four incoming processors opt into adding missing EOB services with zero
benefit as well. Such new services use zero charge under the existing denied
service fee policy and do not receive a payment split.

Legacy payments may use a base claim such as `5101035732` in an old free-text
note instead of the full `5101035732 89` ExternalId. The processor detects
these payments before creating services/documents/changing fees, then checks
again under the payment lock. It requires review of the existing payment and
splits; it never silently replaces, reallocates or reposts that old payment.
Canonical exact-payment replay retains its existing verification behavior.

Real-file validation: the supplied 690 PDF was converted with Scribe. With a
simulated missing D0210 and no existing payment, processing adds D0210 dated
2025-09-19 with $74 charge and records one $77.20 payment split $38/$39.20.
PDF/TXT replay creates no duplicate service or payment. A separate fixture
with the old $77.20 base-claim payment stops before any writes. D0120 stays
unchanged in both cases. These are simulated DB results, not live OD writes.

Multi-patient files are processed claim by claim with all claims preflighted
before the first service/document/payment write:

- MetLife: split at Claim Summary page starts, keeping continuation/payment
  pages together. Each patient must match an exact name and MetLife group
  uniquely in OD. Multiple summaries on one page still require review.
- Delta: multi-claim files use Subscriber ID + DOB + exact name in a Delta
  plan, never a shared PatNum from the filename.
- CIGNA: multi-claim files use each claim's Subscriber ID/dependent identifier.
  Missing or ambiguous patient identifiers require review.
- Liberty: retain per-claim Subscriber ID resolution and batch preflight.

Single-patient filename-based routing is unchanged. All source pages remain
attached to each resolved patient's claim document. The supported formats
are those recognized by the existing parsers; this does not establish every
carrier layout or live clinic deployment. Synthetic MetLife PDF/TXT batches
and a merged four-page PDF were verified, including retries and a later
patient mismatch stopping the batch before writes.

Deploy the source to SERVER and restart the running Bridge. Use the existing
retry-errors action for the intended source if the previous attempt moved it
to ERRORS/REVIEW. Updating source alone does not retry old failures.
