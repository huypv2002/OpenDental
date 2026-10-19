// Revert MetLife Claim Payment for Ryan Pham (#1307)
// Deletes Payment and PaySplits associated with CheckNum = '6092230431 99'
import {pool, closePool} from '../src/db.js';

console.log('=== TIẾN HÀNH HOÀN TÁC (REVERT) CLAIM METLIFE CHO BỆNH NHÂN #1307 ===\n');

const patNum = 1307;
const claimNumber = '6092230431 99';

try {
  const conn = await pool.getConnection();
  try {
    await conn.query('LOCK TABLES payment WRITE, paysplit WRITE, claimproc WRITE, claim WRITE, patient WRITE');

    const [payments] = await conn.execute(
      'SELECT PayNum, PayAmt, PayDate, CheckNum, PayNote FROM payment WHERE PatNum = ? AND CheckNum = ?',
      [patNum, claimNumber]
    );

    if (payments.length === 0) {
      console.log('Không tìm thấy bản ghi Payment nào có số Check/Claim ' + claimNumber + ' để revert.');
    } else {
      for (const p of payments) {
        console.log(`Tìm thấy Payment: PayNum = ${p.PayNum} | Tiền = $${p.PayAmt} | Note = "${p.PayNote}"`);
        const [delSplits] = await conn.execute('DELETE FROM paysplit WHERE PayNum = ?', [p.PayNum]);
        console.log(`  ✓ Đã xóa ${delSplits.affectedRows} PaySplits thuộc PayNum = ${p.PayNum}`);

        const [delPay] = await conn.execute('DELETE FROM payment WHERE PayNum = ?', [p.PayNum]);
        console.log(`  ✓ Đã xóa bản ghi Payment: PayNum = ${p.PayNum}`);
      }
      console.log('\n>>> ĐÃ HOÀN TÁC THÀNH CÔNG! Bệnh nhân #1307 đã sạch bản ghi payment thử nghiệm.');
    }

    await conn.query('UNLOCK TABLES');
  } finally {
    try { await conn.query('UNLOCK TABLES'); } catch {}
    conn.release();
  }
} catch (err) {
  console.error('Lỗi khi revert:', err);
} finally {
  await closePool();
}
