import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { extractPdf } from '../metlife/parser.js';
import { parseLiberty, parseShortDos, parseLibertyToothAndDesc } from './parser.js';

test('parseShortDos converts MM/DD/YY to YYYY-MM-DD correctly', () => {
  assert.equal(parseShortDos('09/17/26'), '2026-09-17');
  assert.equal(parseShortDos('10/02/26'), '2026-10-02');
  assert.equal(parseShortDos('12/31/99'), '1999-12-31');
  assert.equal(parseShortDos('invalid'), null);
});

test('parseLibertyToothAndDesc extracts tooth and description', () => {
  assert.deepEqual(parseLibertyToothAndDesc('Q01 Complete denture, maxillary'), {
    tooth: 'Q01',
    description: 'Complete denture, maxillary'
  });
  assert.deepEqual(parseLibertyToothAndDesc('8 Intraoral, periapical, first radiographic image'), {
    tooth: '8',
    description: 'Intraoral, periapical, first radiographic image'
  });
  assert.deepEqual(parseLibertyToothAndDesc('Comprehensive oral evaluation'), {
    tooth: null,
    description: 'Comprehensive oral evaluation'
  });
  assert.deepEqual(parseLibertyToothAndDesc('FM Full mouth debridement'), {
    tooth: 'FM',
    description: 'Full mouth debridement'
  });
});

test('parseLiberty parses full Liberty Dental Plan PDF with multi-claim payload', async () => {
  const samplePdfPath = '/Users/phamvanhuy/.gemini/antigravity-ide/brain/4a57ede7-764d-426c-9039-24fe987b472e/.user_uploaded/media_1792520482271.pdf';
  let buffer;
  try {
    buffer = await fs.readFile(samplePdfPath);
  } catch (err) {
    // If not accessible in CI, skip test
    return;
  }

  const extracted = await extractPdf(buffer);
  const parsed = parseLiberty(extracted);

  assert.equal(parsed.errors.length, 0, `Unexpected errors: ${parsed.errors.join('; ')}`);
  assert.equal(parsed.carrier, 'LIBERTY Dental Plan');
  assert.equal(parsed.check.number, '109119');
  assert.equal(parsed.check.date, '2026-10-02');
  assert.equal(parsed.check.netPaymentCents, 173300);
  assert.equal(parsed.check.netPaymentFormatted, '1733.00');

  assert.equal(parsed.claimsCount, 2);

  // Claim 1: Doan, Vang
  const c1 = parsed.claims[0];
  assert.equal(c1.claimNumber, '77361505');
  assert.equal(c1.patient.lastName, 'Doan');
  assert.equal(c1.patient.firstName, 'Vang');
  assert.equal(c1.patient.memberId, '346M97946-01');
  assert.match(c1.plan.group, /H8849-010-001/);
  assert.equal(c1.totals.planPaidCents, 148300);
  assert.equal(c1.procedures.length, 2);

  // Procedure D5110
  assert.equal(c1.procedures[0].code, 'D5110');
  assert.equal(c1.procedures[0].tooth, 'Q01');
  assert.equal(c1.procedures[0].date, '2026-09-17');
  assert.equal(c1.procedures[0].feeCents, 95000);
  assert.equal(c1.procedures[0].benefitCents, 74300);
  assert.equal(c1.procedures[0].status, 'Approved');

  // Procedure D5120
  assert.equal(c1.procedures[1].code, 'D5120');
  assert.equal(c1.procedures[1].tooth, 'Q02');
  assert.equal(c1.procedures[1].date, '2026-09-17');
  assert.equal(c1.procedures[1].feeCents, 95000);
  assert.equal(c1.procedures[1].benefitCents, 74000);

  // Payment payload for Open Dental
  assert.equal(c1.paymentPayload.amount, '1483.00');
  assert.equal(c1.paymentPayload.checkNum, '');
  assert.equal(c1.paymentPayload.payNote, 'Claim number: 77361505');
  assert.equal(c1.paymentPayload.claimNum, '77361505');
  assert.equal(c1.paymentPayload.splits.length, 2);
  assert.equal(c1.paymentPayload.splits[0].amount, '743.00');
  assert.equal(c1.paymentPayload.splits[1].amount, '740.00');

  // Claim 2: Nguyen, My
  const c2 = parsed.claims[1];
  assert.equal(c2.claimNumber, '77362477');
  assert.equal(c2.patient.lastName, 'Nguyen');
  assert.equal(c2.patient.firstName, 'My');
  assert.equal(c2.patient.memberId, '264W01090-01');
  assert.equal(c2.totals.planPaidCents, 25000);
  assert.equal(c2.procedures.length, 7);

  assert.equal(c2.procedures[0].code, 'D0150');
  assert.equal(c2.procedures[0].benefitCents, 3800);

  assert.equal(c2.procedures[1].code, 'D0220');
  assert.equal(c2.procedures[1].tooth, '8');
  assert.equal(c2.procedures[1].benefitCents, 1400);

  assert.equal(c2.procedures[2].code, 'D0230');
  assert.equal(c2.procedures[2].tooth, '24');
  assert.equal(c2.procedures[2].benefitCents, 1200);

  assert.equal(c2.procedures[3].code, 'D0274');
  assert.equal(c2.procedures[3].benefitCents, 3500);

  assert.equal(c2.procedures[4].code, 'D0330');
  assert.equal(c2.procedures[4].benefitCents, 6800);

  assert.equal(c2.procedures[5].code, 'D1110');
  assert.equal(c2.procedures[5].benefitCents, 6300);

  assert.equal(c2.procedures[6].code, 'D1208');
  assert.equal(c2.procedures[6].benefitCents, 2000);

  assert.equal(c2.paymentPayload.amount, '250.00');
  assert.equal(c2.paymentPayload.splits.length, 7);
});

test('parseLiberty parses single-claim Liberty PDF (Lee, Liza - Check #110372)', async () => {
  const samplePdfPath = '/Users/phamvanhuy/.gemini/antigravity-ide/brain/4a57ede7-764d-426c-9039-24fe987b472e/.user_uploaded/media_1792523692379.pdf';
  let buffer;
  try {
    buffer = await fs.readFile(samplePdfPath);
  } catch (err) {
    return;
  }

  const extracted = await extractPdf(buffer);
  const parsed = parseLiberty(extracted);

  assert.equal(parsed.errors.length, 0, `Unexpected errors: ${parsed.errors.join('; ')}`);
  assert.equal(parsed.carrier, 'LIBERTY Dental Plan');
  assert.equal(parsed.check.number, '110372');
  assert.equal(parsed.check.date, '2026-10-07');
  assert.equal(parsed.check.netPaymentFormatted, '167.00');
  assert.equal(parsed.claimsCount, 1);

  const c = parsed.claims[0];
  assert.equal(c.claimNumber, '77486188');
  assert.equal(c.patient.lastName, 'Lee');
  assert.equal(c.patient.firstName, 'Liza');
  assert.equal(c.patient.memberId, '827W06553-01');
  assert.equal(c.totals.planPaidCents, 16700);
  assert.equal(c.procedures.length, 5);

  assert.equal(c.procedures[0].code, 'D0150');
  assert.equal(c.procedures[0].benefitCents, 3800);

  assert.equal(c.procedures[1].code, 'D0220');
  assert.equal(c.procedures[1].tooth, '13');
  assert.equal(c.procedures[1].benefitCents, 1400);

  assert.equal(c.procedures[2].code, 'D0230');
  assert.equal(c.procedures[2].tooth, '23');
  assert.equal(c.procedures[2].benefitCents, 1200);

  assert.equal(c.procedures[3].code, 'D0274');
  assert.equal(c.procedures[3].benefitCents, 3500);

  assert.equal(c.procedures[4].code, 'D0330');
  assert.equal(c.procedures[4].benefitCents, 6800);

  assert.equal(c.paymentPayload.amount, '167.00');
  assert.equal(c.paymentPayload.splits.length, 5);
});

