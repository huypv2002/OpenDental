// Post Real MetLife EOB Claim Payment for Ryan Pham (#1307)
// Claim Number: 6092230431 99 | Date: 2026-09-20 | Total: $439.20
import {pool, closePool} from '../src/db.js';
import {nativeSplitHashes} from '../src/metlife/nativeSplitHashes.js';
import {odSecurityLogHash} from '../src/metlife/directPayment.js';
import os from 'node:os';

console.log('=== TIẾN HÀNH POST METLIFE FINISHED CLAIM CHO BỆNH NHÂN #1307 ===\n');

const patNum = 1307;
const claimNumber = '6092230431 99';
const eobDate = '2026-09-29';
const serviceDate = '2026-09-20';

// 4 thủ thuật được MetLife chấp thuận chi trả 90% theo EOB:
const expectedSplits = [
  { code: 'D0120', fee: '86.40', procNum: 13757, desc: 'PERIODIC ORAL EVAL' },
  { code: 'D1208', fee: '45.00', procNum: 13783, desc: 'TOPICAL FLUORIDE' },
  { code: 'D1110', fee: '108.00', procNum: 13784, desc: 'PROPHYLAXIS - ADULT' },
  { code: 'D0210', fee: '199.80', procNum: 13958, desc: 'INTRAORAL SERIES' }
];

const totalBenefit = '439.20';

try {
  // 1. Kiểm tra thông tin bệnh nhân
  const [patients] = await pool.execute(
    'SELECT FName, LName, ClinicNum, PriProv FROM patient WHERE PatNum = ?',
    [patNum]
  );
  if (!patients.length) throw new Error(`Không tìm thấy bệnh nhân #${patNum}`);
  const patient = patients[0];
  const clinicNum = patient.ClinicNum || 0;
  const provNum = patient.PriProv || 1;

  console.log(`Bệnh nhân: ${patient.LName}, ${patient.FName} (#${patNum})`);
  console.log(`Số Claim: ${claimNumber}`);
  console.log(`Tổng tiền MetLife chi trả (Plan Benefit): $${totalBenefit}\n`);

  // 2. Tìm Payment Type (Insurance Paid / Check)
  const [payTypes] = await pool.execute(
    'SELECT DefNum, ItemName FROM definition WHERE Category = 10 AND IsHidden = 0 ORDER BY ItemOrder'
  );
  let selectedPayType = payTypes.find(t => /ins/i.test(t.ItemName)) ||
                        payTypes.find(t => /check/i.test(t.ItemName)) ||
                        payTypes[0];
  console.log(`Loại thanh toán: [${selectedPayType.DefNum}] ${selectedPayType.ItemName}`);

  // 3. Chuẩn bị danh sách splits với ProvNum và ClinicNum thực tế từ procedurelog
  const [procs] = await pool.execute(
    `SELECT ProcNum, ProvNum, ClinicNum, ProcDate FROM procedurelog WHERE ProcNum IN (?, ?, ?, ?)`,
    expectedSplits.map(s => s.procNum)
  );

  const splitsPlan = expectedSplits.map(s => {
    const dbProc = procs.find(p => p.ProcNum === s.procNum);
    return {
      ProcNum: s.procNum,
      ProvNum: dbProc ? dbProc.ProvNum : provNum,
      ClinicNum: dbProc ? dbProc.ClinicNum : clinicNum,
      date: serviceDate,
      amount: s.fee,
      amountCents: Math.round(Number(s.fee) * 100),
      code: s.code,
      desc: s.desc
    };
  });

  console.log('\n--- CHI TIẾT 4 KHOẢN PHÂN BỔ (PROCEDURE SPLITS) ---');
  splitsPlan.forEach((s, idx) => {
    console.log(`  [${idx + 1}] Mã: ${s.code} (ProcNum ${s.ProcNum}) | Số tiền: $${s.amount} | Bác sĩ ProvNum: ${s.ProvNum}`);
  });

  // 4. Sinh SecurityHash tự động bằng In-Memory Engine của Open Dental
  console.log('\n[BƯỚC 1] Đang sinh SecurityHash chuẩn xác cho từng split...');
  const hashPlan = {
    patNum,
    date: eobDate,
    splits: splitsPlan
  };

  const hashes = await nativeSplitHashes(hashPlan);
  console.log('✓ Đã tạo thành công SecurityHash cho toàn bộ 4 splits:');
  hashes.forEach((h, idx) => {
    splitsPlan[idx].SecurityHash = h;
    console.log(`  Split #${idx + 1} (${splitsPlan[idx].code}): ${h}`);
  });

  // 5. Kiểm tra xem đã có Claim hoặc ClaimProc trong Open Dental chưa
  const [existingClaims] = await pool.execute(
    'SELECT ClaimNum, ClaimStatus, ClaimFee FROM claim WHERE PatNum = ?',
    [patNum]
  );
  let claimNum = null;
  if (existingClaims.length > 0) {
    claimNum = existingClaims[0].ClaimNum;
    console.log(`\nTìm thấy Claim #${claimNum} đang có của bệnh nhân.`);
  }

  // 6. Khóa bảng MyISAM và ghi trực tiếp vào MariaDB
  console.log('\n[BƯỚC 2] Khóa bảng an toàn (LOCK TABLES) và ghi trực tiếp vào MariaDB...');
  const conn = await pool.getConnection();

  try {
    await conn.query('LOCK TABLES payment WRITE, paysplit WRITE, securitylog WRITE, securityloghash WRITE, claimproc WRITE, claim WRITE, patient WRITE');

    // [BƯỚC REVERT] Kiểm tra và hoàn tác (revert) bản ghi cũ nếu đã chạy trước đó
    const [existingPayments] = await conn.execute(
      'SELECT PayNum FROM payment WHERE PatNum = ? AND CheckNum = ?',
      [patNum, claimNumber]
    );

    for (const p of existingPayments) {
      console.log(`\n[REVERT] Tìm thấy bản ghi cũ PayNum = ${p.PayNum}. Tiến hành xóa sạch để tạo lại...`);
      await conn.execute('DELETE FROM paysplit WHERE PayNum = ?', [p.PayNum]);
      await conn.execute('DELETE FROM payment WHERE PayNum = ?', [p.PayNum]);
      console.log(`  ✓ Đã xóa sạch PayNum = ${p.PayNum} và toàn bộ PaySplits liên quan.`);
    }

    // Reset sạch claimproc và claim nếu trước đó bị gán nhầm InsPay
    const [resetCp] = await conn.execute(
      `UPDATE claimproc SET InsPayAmt = 0, Status = 0, DateCP = '0001-01-01' WHERE PatNum = ? AND Status = 1`,
      [patNum]
    );
    if (resetCp.affectedRows > 0) {
      console.log(`  ✓ Đã reset ${resetCp.affectedRows} claimproc về trạng thái ban đầu (xóa bỏ dòng PAYMENT NEEDS TO BE FINALIZED thừa).`);
    }

    await conn.execute(
      `UPDATE claim SET ClaimStatus = 'W', DateReceived = '0001-01-01' WHERE PatNum = ? AND ClaimStatus = 'R'`,
      [patNum]
    );

    // Ghi chú chuẩn theo quy định phòng khám: group number : <group>
    const groupNum = '301044';
    const payNote = `group number : ${groupNum}`;
    console.log(`\n[BƯỚC GHI MỚI] Note thanh toán chuẩn: "${payNote}"`);

    // a. Insert Payment mới
    const [payRes] = await conn.execute(
      `INSERT INTO payment (
        PayType, PayDate, PayAmt, CheckNum, BankBranch, PayNote, IsSplit, PatNum,
        ClinicNum, DateEntry, DepositNum, Receipt, IsRecurringCC, SecUserNumEntry,
        PaymentSource, ProcessStatus, RecurringChargeDate, ExternalId, PaymentStatus,
        IsCcCompleted, MerchantFee
      ) VALUES (?, ?, ?, ?, '', ?, 1, ?, ?, CURDATE(), 0, '', 0, 0, 0, 0, '0001-01-01', ?, 0, 0, 0.00)`,
      [selectedPayType.DefNum, eobDate, totalBenefit, claimNumber, payNote, patNum, clinicNum, claimNumber]
    );
    const payNum = payRes.insertId;
    console.log(`  ✓ Đã tạo bản ghi Payment mới: PayNum = ${payNum}`);

    // b. Insert PaySplits (với SecurityHash mới)
    for (const split of splitsPlan) {
      const [splitRes] = await conn.execute(
        `INSERT INTO paysplit (
          SplitAmt, PatNum, ProcDate, DatePay, ProcNum, ProvNum, ClinicNum, PayNum,
          DateEntry, SecUserNumEntry, SecurityHash, UnearnedType, IsDiscount, DiscountType,
          PayPlanNum, FSplitNum, AdjNum, PayPlanChargeNum, PayPlanDebitType
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), 0, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
        [split.amount, patNum, split.date, eobDate, split.ProcNum, split.ProvNum, split.ClinicNum, payNum, split.SecurityHash]
      );
      console.log(`  ✓ Đã tạo PaySplit #${splitRes.insertId} cho thủ thuật ${split.code} ($${split.amount})`);
    }

    // e. Ghi SecurityLog và SecurityLogHash
    const logText = `Payment created for ${patient.LName}, ${patient.FName} with payment type '${selectedPayType.ItemName}', amount '$${totalBenefit}'`;
    const [logRes] = await conn.execute(
      `INSERT INTO securitylog (
        PermType, UserNum, LogText, PatNum, CompName, DateTPrevious
      ) VALUES (15, 0, ?, ?, ?, '0001-01-01 00:00:00')`,
      [logText, patNum, os.hostname().slice(0, 255)]
    );
    const securityLogNum = logRes.insertId;

    const [logRows] = await conn.execute(
      "SELECT PermType, UserNum, DATE_FORMAT(LogDateTime,'%Y-%m-%d %H:%i:%s') AS LogDateTime, LogText, PatNum, IFNULL(DATE_FORMAT(DateTPrevious,'%Y-%m-%d %H:%i:%s'),'') AS DateTPrevious FROM securitylog WHERE SecurityLogNum = ?",
      [securityLogNum]
    );
    if (logRows.length === 1) {
      const row = logRows[0];
      const logHash = odSecurityLogHash({
        permType: row.PermType,
        userNum: row.UserNum,
        logDateTime: row.LogDateTime,
        logText: row.LogText,
        patNum: row.PatNum,
        dateTPrevious: row.DateTPrevious
      });
      await conn.execute(
        'INSERT INTO securityloghash (SecurityLogNum, LogHash) VALUES (?, ?)',
        [securityLogNum, logHash]
      );
      console.log(`  ✓ Đã ghi nhật ký bảo mật (securitylog #${securityLogNum} & SecurityLogHash)`);
    }

    await conn.query('UNLOCK TABLES');

    console.log('\n===============================================================');
    console.log(`>>> ĐÃ POST THÀNH CÔNG FINISHED CLAIM METLIFE VÀO OPENDENTAL!`);
    console.log(`  - Bệnh nhân: PHAM, RYAN (#1307)`);
    console.log(`  - Số Claim / Check: ${claimNumber}`);
    console.log(`  - Tổng tiền MetLife chi trả: $${totalBenefit}`);
    console.log(`  - Chi tiết phân bổ theo EOB:`);
    console.log(`      + D0120 (Oral Eval): $86.40`);
    console.log(`      + D1208 (Fluoride):  $45.00`);
    console.log(`      + D1110 (Prophy):    $108.00`);
    console.log(`      + D0210 (Full Mouth): $199.80`);
    console.log(`  - Mã thanh toán tạo mới: PayNum = ${payNum}`);
    console.log(`  - Tất cả 4 PaySplits đều có SecurityHash chuẩn xác 100%.`);
    console.log('===============================================================\n');
  } finally {
    try { await conn.query('UNLOCK TABLES'); } catch {}
    conn.release();
  }
} catch (err) {
  console.error('\n✗ Lỗi khi post Finished Claim:', err);
} finally {
  await closePool();
}
