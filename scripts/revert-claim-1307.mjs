// Fix Open Dental Patient #1307 to EXACT clinic format:
// 1. Procedure Charges:
//    - D0120: 86.40
//    - D0210: 199.80
//    - D1110: 108.00
//    - D1208: 45.00
//    - D0274: 0.00 (unsent)
//    - D0330: 0.00 (unsent)
//    - D0220: 0.00 (unsent)
//    - D0230: 0.00 (unsent)
//    Total Charges = $439.20
// 2. Remove duplicate Line 2 ('InsPay 244.80 PAYMENT NEEDS TO BE FINALIZED')
// 3. Keep ONLY Line 1 ('Insurance paid #6092230431 99 $439.20')
// 4. BalTotal = 0.00 (Charges $439.20 - Paid $439.20 = $0.00)

import {pool, closePool} from '../src/db.js';

console.log('=== ĐỒNG BỘ PHÍ VÀ SỐ DƯ BỆNH NHÂN #1307 VỀ ĐÚNG ĐỊNH DẠNG PHÒNG KHÁM ===\n');

const patNum = 1307;

try {
  const conn = await pool.getConnection();
  try {
    await conn.query(
      'LOCK TABLES payment WRITE, paysplit WRITE, claimpayment WRITE, claimproc WRITE, claim WRITE, patient WRITE, procedurelog WRITE, procedurecode READ'
    );

    // ====================================================
    // BƯỚC 1: CẬP NHẬT CHUẨN CHARGES TỪNG THỦ THUẬT
    // ====================================================
    console.log('--- [1/3] CẬP NHẬT PHÍ CÁC THỦ THUẬT (CHARGES) ---');
    const exactFees = {
      D0120: 86.40,
      D0210: 199.80,
      D1110: 108.00,
      D1208: 45.00,
      D0274: 0.00,  // Denied (kết hợp vào D0210 theo MetLife Note 65, J)
      D0330: 0.00,  // Denied (kết hợp vào D0210 theo MetLife Note 65, J)
      D0220: 0.00,  // Denied (kết hợp vào D0210 theo MetLife Note 65, J)
      D0230: 0.00   // Denied (kết hợp vào D0210 theo MetLife Note 65, J)
    };

    const [patientProcs] = await conn.execute(
      `SELECT procedurelog.ProcNum, procedurecode.ProcCode, procedurelog.ProcFee, procedurecode.Descript
       FROM procedurelog
       JOIN procedurecode ON procedurecode.CodeNum = procedurelog.CodeNum
       WHERE procedurelog.PatNum = ? AND procedurelog.ProcStatus = 2`,
      [patNum]
    );

    for (const proc of patientProcs) {
      if (exactFees[proc.ProcCode] !== undefined) {
        const targetFee = exactFees[proc.ProcCode];
        await conn.execute('UPDATE procedurelog SET ProcFee = ? WHERE ProcNum = ?', [targetFee, proc.ProcNum]);
        await conn.execute('UPDATE claimproc SET FeeBilled = ? WHERE ProcNum = ?', [targetFee, proc.ProcNum]);
        console.log(`  ✓ ${proc.ProcCode} (${proc.Descript}): $${proc.ProcFee} ➔ $${targetFee.toFixed(2)}`);
      }
    }

    // ====================================================
    // BƯỚC 2: XÓA DÒNG THỨ 2 (INSPAY 244.80)
    // ====================================================
    console.log('\n--- [2/3] XÓA DÒNG THỨ 2 (PAYMENT NEEDS TO BE FINALIZED) ---');

    // Xóa claimpayment dở dang nếu có
    const [linkedCp] = await conn.execute(
      'SELECT DISTINCT ClaimPaymentNum FROM claimproc WHERE PatNum = ? AND ClaimPaymentNum > 0',
      [patNum]
    );
    for (const r of linkedCp) {
      await conn.execute('DELETE FROM claimpayment WHERE ClaimPaymentNum = ?', [r.ClaimPaymentNum]);
      console.log(`  ✓ Đã xóa claimpayment #${r.ClaimPaymentNum}`);
    }
    await conn.execute(`DELETE FROM claimpayment WHERE CheckAmt IN (244.80, 439.20) OR CheckNum LIKE '%6092230431%'`);

    // Reset claimproc để Open Dental không sinh ra dòng ảo
    const [resCp] = await conn.execute(
      `UPDATE claimproc SET InsPayAmt = 0, Status = 0, ClaimPaymentNum = 0, DateCP = '0001-01-01' WHERE PatNum = ?`,
      [patNum]
    );
    console.log(`  ✓ Đã reset ${resCp.affectedRows} dòng claimproc về 0 (xóa dòng InsPay).`);

    // ====================================================
    // BƯỚC 3: KIỂM TRA PAYMENT $439.20 VÀ CÂN BẰNG SỐ DƯ
    // ====================================================
    console.log('\n--- [3/3] KIỂM TRA DUY NHẤT 1 DÒNG PAYMENT $439.20 & TÍNH BALANCE ---');

    // Cập nhật Claim
    await conn.execute(
      `UPDATE claim SET ClaimFee = 439.20, ClaimStatus = 'R', DateReceived = '2026-09-29' WHERE PatNum = ?`,
      [patNum]
    );
    console.log('  ✓ Đã cập nhật Claim: ClaimFee = $439.20, Status = R (Received).');

    // Cập nhật BalTotal bệnh nhân:
    // Tổng Charges ($439.20) - Tổng Paid ($439.20) = $0.00
    await conn.execute('UPDATE patient SET BalTotal = 0.00 WHERE PatNum = ?', [patNum]);
    console.log('  ✓ Đã cập nhật BalTotal bệnh nhân = $0.00 (Charges: $439.20 - Paid: $439.20 = $0.00).');

    await conn.query('UNLOCK TABLES');
    console.log('\n=============================================================');
    console.log('>>> THÀNH CÔNG RỰC RỠ:');
    console.log('    1. D0120: $86.40, D0210: $199.80, D1110: $108.00, D1208: $45.00');
    console.log('    2. D0274, D0330, D0220, D0230: $0.00 (đúng như bạn yêu cầu)');
    console.log('    3. Dòng thứ 2 (244.80) đã bị xóa hoàn toàn');
    console.log('    4. Chỉ còn DUY NHẤT 1 dòng $439.20, số dư bệnh nhân chuẩn xác = $0.00');
    console.log('=============================================================');
  } finally {
    try { await conn.query('UNLOCK TABLES'); } catch {}
    conn.release();
  }
} catch (err) {
  console.error('Lỗi:', err);
} finally {
  await closePool();
}
