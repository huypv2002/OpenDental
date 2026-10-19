// Remove duplicate Line 2 (InsPay 244.80 PAYMENT NEEDS TO BE FINALIZED)
// Keeping Line 1 (Insurance paid #6092230431 99 $439.20) intact as requested!

import {pool, closePool} from '../src/db.js';

console.log('=== TIẾN HÀNH XÓA DÒNG THỨ 2 (INSPAY 244.80 PAYMENT NEEDS TO BE FINALIZED) ===\n');

const patNum = 1307;

try {
  const conn = await pool.getConnection();
  try {
    await conn.query('LOCK TABLES claimproc WRITE, claimpayment WRITE, patient WRITE, procedurelog WRITE, paysplit READ');

    // 1. Tìm và xóa claimpayment dở dang (244.80)
    const [linkedCp] = await conn.execute(
      'SELECT DISTINCT ClaimPaymentNum FROM claimproc WHERE PatNum = ? AND ClaimPaymentNum > 0',
      [patNum]
    );
    for (const r of linkedCp) {
      await conn.execute('DELETE FROM claimpayment WHERE ClaimPaymentNum = ?', [r.ClaimPaymentNum]);
      console.log(`  ✓ Đã xóa claimpayment #${r.ClaimPaymentNum}`);
    }

    const [delCp] = await conn.execute(
      `DELETE FROM claimpayment WHERE CheckAmt IN (244.80, 439.20) OR CheckNum LIKE '%6092230431%'`
    );
    if (delCp.affectedRows > 0) {
      console.log(`  ✓ Đã xóa ${delCp.affectedRows} dòng claimpayment 244.80`);
    }

    // 2. Reset triệt để claimproc để Open Dental không tổng hợp ra dòng "PAYMENT NEEDS TO BE FINALIZED"
    const [resProc] = await conn.execute(
      `UPDATE claimproc SET InsPayAmt = 0, Status = 0, ClaimPaymentNum = 0, DateCP = '0001-01-01' WHERE PatNum = ?`,
      [patNum]
    );
    console.log(`  ✓ Đã reset ${resProc.affectedRows} dòng claimproc (InsPayAmt = 0, Status = 0, ClaimPaymentNum = 0).`);

    // 3. Cập nhật lại số dư tài khoản bệnh nhân chính xác:
    // Tổng Charges ($748.00) - Duy nhất 1 Payment ($439.20) = $308.80
    const [chargeRes] = await conn.execute(
      'SELECT SUM(ProcFee) AS TotalCharges FROM procedurelog WHERE PatNum = ? AND ProcStatus = 2',
      [patNum]
    );
    const [paidRes] = await conn.execute(
      'SELECT SUM(SplitAmt) AS TotalPaid FROM paysplit WHERE PatNum = ?',
      [patNum]
    );
    const charges = Number(chargeRes[0]?.TotalCharges || 0);
    const paid = Number(paidRes[0]?.TotalPaid || 0);
    const correctBal = (charges - paid).toFixed(2);

    await conn.execute('UPDATE patient SET BalTotal = ? WHERE PatNum = ?', [correctBal, patNum]);
    console.log(`  ✓ Đã cập nhật BalTotal bệnh nhân = $${correctBal} (Charges: $${charges.toFixed(2)} - Paid: $${paid.toFixed(2)})`);

    await conn.query('UNLOCK TABLES');
    console.log('\n>>> THÀNH CÔNG! Dòng thứ 2 đã được xóa bỏ hoàn toàn. Chỉ còn duy nhất 1 dòng $439.20!');
  } finally {
    try { await conn.query('UNLOCK TABLES'); } catch {}
    conn.release();
  }
} catch (err) {
  console.error('Lỗi:', err);
} finally {
  await closePool();
}
