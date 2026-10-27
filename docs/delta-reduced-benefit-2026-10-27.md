# Delta reduced printed benefit

The supplied new 423 claim prints D5214 with a $1,000.00 accepted fee and maximum allowance, no deductible, and a 50% contract benefit. Its actual Delta Dental pays is $310.40 and Patient pays is $689.60; all six claim-total columns match the service. The deposit header is $542.40 and is not the individual claim amount.

The parser previously required the printed payment to equal the percentage calculation ($500.00) exactly. It now accepts a lower printed payment only when payment plus printed patient share equals Accepted fee. Payments above the calculated amount, inconsistent patient shares, and mismatched claim-total columns still stop processing. A warning records the reduced benefit without guessing its cause.

Validation covers reduced benefits, excess benefits, inconsistent patient shares, mismatched totals, and the supplied PDF through the document reader. Private PDFs remain external fixtures (`DELTA_REDUCED_TEST_PDF`); no production database or payment is modified by these tests.
