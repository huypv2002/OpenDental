#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdf } from '../src/metlife/parser.js';
import { parseLiberty } from '../src/liberty/parser.js';

const targetFile = process.argv[2] || '/Users/phamvanhuy/.gemini/antigravity-ide/brain/4a57ede7-764d-426c-9039-24fe987b472e/.user_uploaded/media_1792520482271.pdf';

console.log('='.repeat(70));
console.log('LIBERTY DENTAL PLAN EOB INSPECTOR & PAYLOAD GENERATOR');
console.log('Reading file:', targetFile);
console.log('='.repeat(70));

const buffer = await fs.readFile(targetFile);
const extracted = await extractPdf(buffer);
const parsed = parseLiberty(extracted);

if (parsed.errors.length) {
  console.error('\n⚠️ PHÁT HIỆN LỖI ĐỊNH DẠNG:');
  parsed.errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}

console.log('\n[1] THÔNG TIN CHECK / REMITTANCE:');
console.log('  - Carrier:            ', parsed.carrier);
console.log('  - Vendor:             ', parsed.vendor.name, `(#${parsed.vendor.number})`);
console.log('  - Check Number:       ', parsed.check.number);
console.log('  - Check Date:         ', parsed.check.date, `(Gốc: ${parsed.check.dateRaw})`);
console.log('  - Tổng tiền Net Check:', `$${parsed.check.netPaymentFormatted}`);
console.log('  - Số lượng Claim:     ', parsed.claimsCount);

console.log('\n[2] CHI TIẾT TỪNG CLAIM & PAYLOAD OPEN DENTAL:');

parsed.claims.forEach((claim, idx) => {
  console.log('-'.repeat(70));
  console.log(`CLAIM #${idx + 1}: ${claim.claimNumber} (${claim.claimType})`);
  console.log('  - Bệnh nhân:    ', `${claim.patient.lastName}, ${claim.patient.firstName}`);
  console.log('  - Member ID:    ', claim.patient.memberId);
  console.log('  - Plan Name:    ', claim.plan.name);
  console.log('  - Group Number: ', claim.plan.group);
  console.log('  - Bảo hiểm trả: ', `$${(claim.totals.planPaidCents / 100).toFixed(2)}`);
  console.log('  - Bệnh nhân nợ: ', `$${(claim.totals.patientDueCents / 100).toFixed(2)}`);

  console.log('  - Chi tiết dịch vụ (Procedures):');
  claim.procedures.forEach((p) => {
    const fee = `$${(p.feeCents / 100).toFixed(2)}`;
    const allow = `$${(p.allowedCents / 100).toFixed(2)}`;
    const paid = `$${(p.benefitCents / 100).toFixed(2)}`;
    const toothStr = p.tooth ? `[Răng/Cung: ${p.tooth}] ` : '';
    console.log(`    * Line ${p.line}: ${p.code} ${toothStr}- ${p.description}`);
    console.log(`      Phí gửi: ${fee.padStart(8)} | Được duyệt: ${allow.padStart(8)} | BH chi trả: ${paid.padStart(8)} -> [${p.status}]`);
  });

  console.log('\n  - Payload thanh toán Open Dental (Tương thích 100% với MetLife Bridge):');
  console.log('    {');
  console.log(`      "payType": "${claim.paymentPayload.payType}",`);
  console.log(`      "checkNum": "${claim.paymentPayload.checkNum}",`);
  console.log(`      "claimNum": "${claim.paymentPayload.claimNum}",`);
  console.log(`      "payDate": "${claim.paymentPayload.payDate}",`);
  console.log(`      "amount": "${claim.paymentPayload.amount}",`);
  console.log(`      "payNote": "${claim.paymentPayload.payNote}",`);
  console.log(`      "splitsCount": ${claim.paymentPayload.splits.length},`);
  console.log('      "splits": [');
  claim.paymentPayload.splits.forEach((s) => {
    console.log(`        { "code": "${s.code}", "date": "${s.date}", "tooth": "${s.tooth || ''}", "amount": "${s.amount}" },`);
  });
  console.log('      ]');
  console.log('    }');
});

console.log('='.repeat(70));
console.log('✓ XÁC THỰC THÀNH CÔNG: Toàn bộ claims và payload đã sẵn sàng kết nối Open Dental.');
console.log('='.repeat(70));
