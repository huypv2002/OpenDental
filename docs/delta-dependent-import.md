# Delta dependent import

The Delta Provider Tools parser keeps patient name/DOB, relationship, subscriber name/DOB/ID and group separately. A `Dependent` is resolved by the single-claim filename's PatNum plus full patient name (spacing ignored) and DOB. It is never resolved to the subscriber's patient number.

After the entire document passes patient/procedure/payment preflight, the processor:

1. Searches exact Delta Subscriber ID and verifies subscriber name, DOB and group. An existing unique matching policy/subscriber is reused.
2. If that policy is absent, finds a unique Delta plan already attached to the patient with the same group. The EOB base group may match a stored group with a hyphenated division suffix, such as `21767` / `21767-10000`. It does not invent a new carrier, group, benefits or InsPlan.
3. Reuses an exact existing subscriber patient by full name/DOB. If absent, creates a separate NonPatient subscriber. Does not change the dependent's guarantor or merge families.
4. Creates an InsSub for that subscriber and exact EOB ID if needed. Adds PatPlan coverage for the dependent with Relationship=Dependent. Existing plans and claim history are retained, and the new coverage receives the next free insurance ordinal.
5. Reads back the patient/subscriber/policy/relationship before continuing payment. A `luk_eob_dependent_links` receipt records pending and verified stages, IDs and claim. Partial retries resolve exact existing records instead of blindly inserting again.

The writer uses dedicated-connection MyISAM-compatible table locks, as does the existing procedure writer. It respects `METLIFE_DIRECT_DB_DISABLED=true`. Ambiguous subscribers/plans, wrong DOB, conflicting existing relationship, missing source metadata, unsupported schema or failed readback stop processing. No Subscriber ID suffix is guessed; the old dependent ID is not replaced with the subscriber ID.

Limits: this currently handles the explicit Delta `Dependent` relationship with name, subscriber DOB, ID and group present. Self and other relationships retain the existing resolver. It does not automatically rewrite previously issued claims or remove old insurance. A new plan's next ordinal can be secondary; existing primary insurance remains in place.

Validation covers the private 1279 TXT metadata and a persistent SQL fixture: new NonPatient/policy/coverage, existing subscriber reuse across families, preserved old insurance, retry recovery after each persisted insert, identity/group ambiguity, stale plans and conflicting relationships. These tests do not establish native Windows/MySQL runtime acceptance. Deploy on SERVER with `git pull`, restart Bridge, and verify the new PatPlan in OD after the next import.

Open Dental references: [PatPlans](https://www.opendental.com/site/apipatplans.html), [InsSubs](https://www.opendental.com/site/apiinssubs.html), [Patients](https://www.opendental.com/site/apipatients.html).
