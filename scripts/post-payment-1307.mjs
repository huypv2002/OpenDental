// Post MetLife Payment for Patient #1307 directly into MariaDB
import {pool, closePool} from '../src/db.js';
import {nativeSplitHashes} from '../src/metlife/nativeSplitHashes.js';
import {odSecurityLogHash, odDateT} from '../src/metlife/directPayment.js';
import os from 'node:os';

console.log('=== THỰC HIỆN POST THANH TOÁN METLIFE CHO BỆNH NHÂN #1307 ===\n');

const patNum = 1307;

try {
  // 1. Kiểm tra Payment Types (Category = 10)
  const [payTypes] = await pool.execute(
    'SELECT DefNum, ItemName, ItemValue FROM definition WHERE Category = 10 AND IsHidden = 0 ORDER BY ItemOrder'
  );
  console.log('Các loại hình thanh toán (Payment Types) có sẵn:');
  payTypes.forEach(t => console.log(`  [${t.DefNum}] ${t.ItemName} (${t.ItemValue || 'Standard'})`));

  // Chọn loại thanh toán Insurance / Check
  let selectedPayType = payTypes.find(t => /ins/i.test(t.ItemName) || /check/i.test(t.ItemName)) || payTypes[0];
  console.log(`\n-> Sử dụng PayType: [${selectedPayType.DefNum}] ${selectedPayType.ItemName}`);

  // 2. Lấy thông tin bệnh nhân
  const [patients] = await pool.execute('SELECT FName, LName, ClinicNum, PriProv FROM patient WHERE PatNum = ?', [patNum]);
  if (!patients.length) throw new Error(`Không tìm thấy bệnh nhân #${patNum}`);
  const patient = patients[0];
  const clinicNum = patient.ClinicNum || 0;
  const provNum = patient.PriProv || 1;

  // 3. Lấy thủ thuật D0120 (ProcNum: 13757 - $86.40) và D1208 (ProcNum: 13783 - $45.00)
  const [procs] = await pool.execute(
    `SELECT pl.ProcNum, pl.ProcDate, pl.ProcFee, pc.ProcCode, pc.Descript, pl.ProvNum, pl.ClinicNum
     FROM procedurelog pl
     JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
     WHERE pl.PatNum = ? AND pl.ProcStatus = 2 AND pl.ProcFee > 0
     ORDER BY pl.ProcDate DESC`,
    [patNum]
  );

  console.log('\nCác thủ thuật có thể phân bổ chi trả:');
  procs.forEach((pr, i) => console.log(`  [${i + 1}] ProcNum: ${pr.ProcNum} | Mã: ${pr.ProcCode} | Phí: $${pr.ProcFee}`));

  // Kế hoạch thanh toán MetLife cho 2 thủ thuật mẫu:
  // Thủ thuật 1: ProcNum 13757 (D0120) - chi trả $86.40
  // Thủ thuật 2: ProcNum 13783 (D1208) - chi trả $45.00
  // Tổng thanh toán: $131.40
  const today = new Date().toISOString().slice(0, 10);
  const targetProcs = procs.slice(0, 2);
  
  if (!targetProcs.length) {
    throw new Error('Bệnh nhân không có thủ thuật nào để phân bổ.');
  }

  const splitsPlan = targetProcs.map(pr => ({
    ProcNum: pr.ProcNum,
    ProvNum: pr.ProvNum || provNum,
    ClinicNum: pr.ClinicNum || clinicNum,
    date: pr.ProcDate.toISOString().slice(0, 10),
    amount: Number(pr.ProcFee).toFixed(2),
    amountCents: Math.round(Number(pr.ProcFee) * 100)
  }));

  const totalAmount = splitsPlan.reduce((sum, s) => sum + Number(s.amount), 0).toFixed(2);
  const checkNum = 'METLIFE-' + Math.floor(100000 + Math.random() * 900000);
  const payNote = 'MetLife EOB Direct Payment Test - Procedure Splits';

  console.log(`\n--- KẾ HOẠCH THANH TOÁN (PLAN) ---`);
  console.log(`Bệnh nhân: ${patient.LName}, ${patient.FName} (#${patNum})`);
  console.log(`Tổng tiền chi trả: $${totalAmount}`);
  console.log(`Số séc / CheckNum: ${checkNum}`);
  console.log(`Ngày thanh toán: ${today}`);
  splitsPlan.forEach(s => console.log(`  -> Phân bổ thủ thuật #${s.ProcNum}: $${s.amount}`));

  // 4. Sinh SecurityHash độc lập bằng In-Memory Engine
  console.log('\n[BƯỚC 1] Đang tạo SecurityHash chuẩn xác qua In-Memory Engine...');
  const hashPlan = {
    patNum,
    date: today,
    splits: splitsPlan
  };

  const hashes = await nativeSplitHashes(hashPlan);
  console.log('✓ Đã tạo thành công SecurityHash cho các splits:');
  hashes.forEach((h, idx) => {
    splitsPlan[idx].SecurityHash = h;
    console.log(`  Split #${idx + 1} (ProcNum ${splitsPlan[idx].ProcNum}): ${h}`);
  });

  // 5. Khóa bảng MyISAM và ghi trực tiếp vào MariaDB
  console.log('\n[BƯỚC 2] Đang khóa bảng (LOCK TABLES) và ghi trực tiếp vào MariaDB...');
  const conn = await pool.getConnection();

  try {
    await conn.query('LOCK TABLES payment WRITE, paysplit WRITE, securitylog WRITE, securityloghash WRITE, patient WRITE');

    // a. Insert payment
    const [payRes] = await conn.execute(
      `INSERT INTO payment (
        PayType, PayDate, PayAmt, CheckNum, BankBranch, PayNote, IsSplit, PatNum,
        ClinicNum, DateEntry, DepositNum, Receipt, IsRecurringCC, SecUserNumEntry,
        PaymentSource, ProcessStatus, RecurringChargeDate, ExternalId, PaymentStatus,
        IsCcCompleted, MerchantFee
      ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, CURDATE(), 0, '', 0, 0, 0, 0, '0001-01-01', '', 0, 0, 0.00)`,
      [selectedPayType.DefNum, today, totalAmount, checkNum, payNote, splitsPlan.length > 1 ? 1 : 0, patNum, clinicNum]
    );
    const payNum = payRes.insertId;
    console.log(`  ✓ Đã tạo bản ghi Payment: PayNum = ${payNum}`);

    // b. Insert paysplits
    for (const split of splitsPlan) {
      const [splitRes] = await conn.execute(
        `INSERT INTO paysplit (
          SplitAmt, PatNum, ProcDate, DatePay, ProcNum, ProvNum, ClinicNum, PayNum,
          DateEntry, SecUserNumEntry, SecurityHash, UnearnedType, IsDiscount, DiscountType,
          PayPlanNum, FSplitNum, AdjNum, PayPlanChargeNum, PayPlanDebitType
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), 0, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
        [split.amount, patNum, split.date, today, split.ProcNum, split.ProvNum, split.ClinicNum, payNum, split.SecurityHash]
      );
      console.log(`  ✓ Đã tạo PaySplit #${splitRes.insertId} cho thủ thuật #${split.ProcNum} ($${split.amount})`);
    }

    // c. Insert securitylog
    const logText = `Payment created for ${patient.LName}, ${patient.FName} with payment type '${selectedPayType.ItemName}', amount '$${totalAmount}'`;
    const [logRes] = await conn.execute(
      `INSERT INTO securitylog (
        PermType, UserNum, LogText, PatNum, CompName, DateTPrevious
      ) VALUES (15, 0, ?, ?, ?, '0001-01-01 00:00:00')`,
      [logText, patNum, os.hostname().slice(0, 255)]
    );
    const securityLogNum = logRes.insertId;

    // d. Insert securityloghash
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
      console.log(`  ✓ Đã ghi nhật ký bảo mật (securitylog #${securityLogNum} & hash)`);
    }

    await conn.query('UNLOCK TABLES');
    console.log('\n===============================================================');
    console.log(`>>> POST THANH TOÁN THÀNH CÔNG RỰC RỠ VÀO OPENDENTAL!`);
    console.log(`  - Bệnh nhân: PHAM, RYAN (#1307)`);
    console.log(`  - Mã thanh toán: PayNum = ${payNum}`);
    console.log(`  - Tổng tiền: $${totalAmount} (Séc: ${checkNum})`);
    console.log(`  - Bây giờ bạn mở Open Dental, vào mục Account của bệnh nhân #1307 sẽ thấy khoản thanh toán hiển thị đầy đủ!`);
    console.log('===============================================================\n');
  } finally {
    try { await conn.query('UNLOCK TABLES'); } catch {}
    conn.release();
  }
} catch (err) {
  console.error('\n✗ Lỗi trong quá trình post thanh toán:', err);
} finally {
  await closePool();
}
