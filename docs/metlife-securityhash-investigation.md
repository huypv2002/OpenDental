# MetLife SecurityHash investigation

Date: 2026-10-19. Internal engineering note; do not expose in the customer UI.

## Evidence and version boundaries

- SERVER reports ProgramVersion 24.3.61.0 and DataBaseVersion 24.3.53.0.
- The installed OpenDentBusiness, CodeBase and CDT DLLs report 24.3.61.0.
- Live synthetic probes on SERVER reach `CDT.Class1.VerifyCallingAssembly()`:
  - PowerShell, x86, no entry assembly: `Unable to find assembly to verify`.
  - Our own x86 executable with a real entry assembly: `Method can only be called from an assembly built by Open Dental`.
- Neither probe connected to MariaDB. These failures cannot be attributed to DB grants, table engines or a failed INSERT.
- Public-source inspection is pinned to OpenDental/opendental commit `d804c19546233593d8a66af0591ed118a9e2c794`, whose business AssemblyVersion is **24.3.63.0**. It is adjacent-version evidence, not an exact reconstruction of the installed 24.3.61 binary.
- Public CDT binary: repository path `Required dlls/CDT.dll`, Git blob `6d28a923b6b2d00fe1d08ad9ec9a5c7e6bac1a49`; SHA-256 `94388e1de923b24eeeefbe5c6d7f59eda26ea323c7e2f5070d44692a901e13f3`. It was inspected statically, not executed against clinic data.

## What the public business layer does

[PaySplits.cs](https://github.com/OpenDental/opendental/blob/d804c19546233593d8a66af0591ed118a9e2c794/OpenDentBusiness/Data%20Interface/PaySplits.cs)

`HashFields` builds its input from PatNum, SplitAmt formatted with two decimals, and **DatePay** formatted as an ISO date, then delegates to CDT. Amount formatting uses the current culture. The model's comment mentioning DateEntry disagrees with this implementation; executable behavior must take precedence.

Insert/InsertMany assign the hash before CRUD persistence. Normal update paths rehash only records whose existing hash is valid. HashFields catches an exception and returns the exception type name, explaining why our probes received a nine-character `Exception` result. That result is a failure, not a short valid hash.

These inputs do not include every allocation field. A hash check alone cannot prove the correct ProcNum, PayNum, provider, clinic, note, or payment type. Independent financial readback remains necessary.

## Why the external host fails

Static inspection of **only the caller-verification routine** in the [public CDT binary](https://github.com/OpenDental/opendental/blob/d804c19546233593d8a66af0591ed118a9e2c794/Required%20dlls/CDT.dll) shows this flow:

1. Obtain `Assembly.GetEntryAssembly()`.
2. If absent, inspect stack frames for a candidate assembly.
3. Apply `QuickHashFile` to the candidate file.
4. Compare the result against an internal accepted-file list; reject a nonmember.

This is a file-identity check, not merely a check for a non-null entry assembly, matching DLL version or x86 process. It explains the difference between our PowerShell and standalone-host errors. Exact parity with installed 24.3.61 internals remains unverified without that binary; its live rejection is verified.

No DLL patch, identity impersonation, accepted-file-list extraction, salt extraction or verifier bypass was implemented. The own-name host remains a diagnostic, not a payment writer.

## Rehash is not an integration endpoint

[SecurityHash.cs](https://github.com/OpenDental/opendental/blob/d804c19546233593d8a66af0591ed118a9e2c794/OpenDentBusiness/Misc/SecurityHash.cs)

The public source includes conversion/startup hash workers and a date window for integrity checks. These are maintenance mechanisms, not a per-payment request contract. An ordinary update of an invalid split does not guarantee repair. Consequently, inserting an empty/failure hash and expecting OD to fix it later is not a validated workflow. No maintenance worker was invoked on SERVER.

## Saving includes more than hashing

[FormPayment.cs](https://github.com/OpenDental/opendental/blob/d804c19546233593d8a66af0591ed118a9e2c794/OpenDental/Forms/FormPayment.cs)

The Save path updates payment details, synchronizes splits, sets split dates, records security logs, handles accounting integration where applicable, and invokes aging-related work. Reproducing only Payment/Split INSERT statements plus a hash would not reproduce this complete behavior. Existing appointment SQL writes demonstrate database access, not payment-business-layer equivalence.

## API options and the actual MetLife workflow

Current tool semantics are `payment` + procedure `paysplit` rows using a category-10 definition named **Insurance Paid**. They do not create `claimpayment`, update `claimproc`, or receive a claim. The label alone must not be used to choose a different financial API.

[Payments API](https://www.opendental.com/site/apipayments.html): POST supports PayType and a list of ProcNums on 24.3, but allocation is FIFO. It does not accept an explicit amount for each procedure through that parameter. It also excludes actual insurance-payment/claim-receipt workflows. `Payments PUT Partial`, introduced in **25.1.11**, accepts explicit procedure/amount pairs for an existing payment.

[PaySplits API](https://www.opendental.com/site/apipaysplits.html): PUT starts at **25.2.9** and documents provider/clinic changes, not arbitrary SplitAmt edits. It is not a missing 24.3 endpoint for setting PDF allocations.

For an approved patient-payment workflow on a compatible version, a candidate request sequence is POST payment, PUT Partial with reviewed allocation amounts, then verify Payment/Splits. This is a candidate, not implemented or live-tested. It requires supported OD/API configuration, a synthetic clone trial, crash/idempotency handling for the two requests, and confirmation that the intended payment classification is correct. It cannot silently substitute for genuine insurance-claim receiving.

[Integration guidance](https://www.opendental.com/site/integrationtypes.html): OD identifies its API as its supported third-party write route. Plugins are restricted/whitelisted, so an in-process plugin is not automatically available merely because the clinic has DB root access.

## Practical status and next decision

- **Available now:** 0.4.2 preview-only Auto fill. It never invokes Save or a posting request. The operator reviews and saves in OD separately.
- **Separate request button:** still calls the direct-db backend, never falls back to UI. It remains blocked by installed CDT verification; do not call it production-ready.
- **Next viable request investigation:** establish which OD/API version the clinic can run and confirm patient payment versus claim receiving. Then test exact allocation with OD's supported API on a synthetic clone.
- **If staying on 24.3:** FIFO POST can only be considered for cases where its complete allocation matches the approved plan. A mismatch must be rejected before clinic use; there is currently no demonstrated general replacement for arbitrary PDF split amounts on this version.

No live patient data, credentials or salt material are included in this note. No database or customer workflow was changed during this investigation.
