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

The clinic separately approved reusing a unique existing completed OD D0210
for an Allowable replacement row that lacks Fee Charged/date. The missing
date comes from that procedure; the missing fee is preserved rather than
replaced with the benefit. FeeBilled is preserved as well. An absent or
ambiguous existing procedure requires review. History retains the original
missing EOB fields and records the resolved OD fee/date separately.

Validation includes synthetic full-processor PDF/TXT retries, preservation of
nonzero OD fees, missing/ambiguous match rejection, default strict parsing and
reconciled payment totals. The supplied 690 PDF was converted with Scribe and
processed twice against a simulated database: one $77.20 payment, splits
$38.00/$39.20, zero added procedures, and unchanged fixture D0210 fee/date.
The fixture fee is invented test data, not an observation of the live chart.
No live financial data was modified during these tests.

Deploy the source to SERVER and restart the running Bridge. Use the existing
retry-errors action for the intended source if the previous attempt moved it
to ERRORS/REVIEW. Updating source alone does not retry old failures.
