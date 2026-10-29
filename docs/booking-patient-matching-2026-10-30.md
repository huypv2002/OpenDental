# Website booking patient identity

Clinic instruction, 30 October 2026: reuse the existing patient number when
date of birth and phone both match, even if the submitted name is incorrect
or shortened. A different date of birth or phone creates a new chart. Driver
license alone does not override a phone or DOB mismatch.

Phone matching ignores punctuation and an optional US country prefix `1`.
The entered phone may match WirelessPhone, HmPhone, or WkPhone. If several
charts already share the DOB and phone, the lowest PatNum is reused. The
existing chart's name and contact details are preserved; the submitted name
is recorded in the appointment note. Returning-patient appointments now have
IsNewPatient=0.

Same-day active online appointment checks use the same DOB/phone rule across
all charts, so a shortened name or a historical duplicate cannot bypass the
existing duplicate-booking restriction.

## Existing records

The clinic explicitly declined repairing the two previously created charts.
This change does not merge, delete, or relink any historical patient or
appointment. PatNum 1339/1340 and AptNum 4185/4186 remain as they are.

## Verification

Run `npm run test:booking`. Transaction tests use a simulated database and
cover reuse, new-chart creation, phone formats, home/work numbers, historical
duplicates, unchanged chart details, IsNewPatient and same-day rejection.

Read-only Bridge data confirmed the two reported pairs originally shared DOB
and phone but had shortened first names. A subsequent read found the
duplicate charts named NEW PT 1/NEW PT 2 with empty phones; this work does
not alter those records. Replaying the original inputs from the saved booking
notes against the fetched patient rows selects 138 for 1339's input and 135
for 1340's input. This replay
does not create an appointment or establish deployment on SERVER. A running
Bridge must load the updated source before new bookings use this policy.
