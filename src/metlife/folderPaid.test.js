import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseMetlife} from './parser.js';
import {readInsuranceTextDocument} from './textDocument.js';
import {selectConvertedText} from './pdfToText.js';
import {processSinglePdf} from './autoProcessor.js';
import {metlifeText, row} from './testSupport/insuranceTextFixtures.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';

const text = metlifeText.replace(
  row([[10,'Paid /'],[30,'09/24/2026'],[50,'$80.00'],[130,'EFT'],[155,'123456789']]),
  row([[10,'-'],[30,'09/24/2026'],[50,'$80.00'],[130,'-'],[155,'-']])
).replace('\n          Settled','');
const parse = (source, options) => parseMetlife(readInsuranceTextDocument(Buffer.from(source)).extracted, options);

test('incoming-folder confirmation accepts missing payment metadata without inventing status/method/trace', () => {
  const strict = parse(text);
  assert.ok(strict.errors.some(e => e.includes('Paid / Settled')));
  assert.ok(strict.errors.some(e => e.includes('trace/check')));
  const confirmed = parse(text, {clinicConfirmedPaid:true});
  assert.deepEqual(confirmed.errors, []);
  assert.equal(confirmed.benefitCents, 8000);
  assert.equal(confirmed.payment.status, strict.payment.status);
  assert.equal(confirmed.payment.method, strict.payment.method);
  assert.equal(confirmed.payment.trace, strict.payment.trace);
  assert.equal(confirmed.payment.confirmationSource, 'clinic-incoming-folder');
});

test('PDF-to-TXT validation receives folder confirmation; other entry points remain strict', () => {
  const candidate = {candidates:[{text}],native:true};
  assert.throws(() => selectConvertedText(candidate), /Paid \/ Settled/);
  assert.equal(selectConvertedText(candidate, {clinicConfirmedPaid:true}), text);
});

test('folder confirmation still rejects missing payment rows and inconsistent amounts', () => {
  const options = {clinicConfirmedPaid:true};
  const mismatch = text.replace('$80.00', '$81.00');
  assert.ok(parse(mismatch, options).errors.some(e => e.includes('không khớp')));
  const noPayment = text.slice(0,text.indexOf('Payment Detail'));
  assert.ok(parse(noPayment, options).errors.some(e => e.includes('đúng một dòng thanh toán')));
  assert.throws(() => selectConvertedText({candidates:[{text:mismatch}],native:true}, options), /không khớp/);
});

test('folder PDF and TXT retries with blank payment metadata create one payment (simulated DB)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'metlife-folder-paid-'));
  try {
    const p = parse(text, {clinicConfirmedPaid:true});
    const ledger = await insuranceLedger(root,[{
      patNum:690, firstName:'TEST', lastName:'PERSON', claimNumber:p.claimRaw,
      procedures:p.procedures, serviceDate:'2026-09-20'
    }]);
    const convertPdf = async (bytes, options) => {
      assert.equal(options.clinicConfirmedPaid, true);
      return selectConvertedText({candidates:[{text}],native:true},options);
    };
    for (const fileName of ['690.pdf','690.txt']) {
      const filePath = path.join(root,fileName);
      await fs.writeFile(filePath, fileName.endsWith('.pdf')?'%PDF-synthetic':text);
      const result = await processSinglePdf(ledger.pool,filePath,{convertPdf,hashSplits:ledger.hashes});
      assert.equal(result.success,true);
    }
    assert.equal(ledger.payments.length,1);
    assert.equal(ledger.splits.length,1);
    assert.equal(Number(ledger.payments[0].PayAmt),80);
    assert.equal(ledger.payments[0].CheckNum,'');
    assert.equal(ledger.payments[0].PayNote,'Claim number: 1234567890 99');
    assert.equal(ledger.splits.reduce((total,s)=>total+Math.round(Number(s.SplitAmt)*100),0),8000);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
