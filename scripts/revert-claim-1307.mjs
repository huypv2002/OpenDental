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

      await conn.execute(
        `UPDATE claimproc SET InsPayAmt = 0, Status = 0, DateCP = '0001-01-01' WHERE PatNum = ? AND Status = 1`,
        [patNum]
      );
      await conn.execute(
        `UPDATE claim SET ClaimStatus = 'W', DateReceived = '0001-01-01' WHERE PatNum = ? AND ClaimStatus = 'R'`,
        [patNum]
      );
      console.log('  ✓ Đã reset claimproc và claim về trạng thái ban đầu.');
      console.log('\n>>> ĐÃ HOÀN TÁC THÀNH CÔNG! Bệnh nhân #1307 đã sạch bản ghi payment thử nghiệm.');
    }

    await conn.query('UNLOCK TABLES');
  } finally {
    try { await conn.query('UNLOCK TABLES'); } catch {}
    conn.release();
  }

  // Dọn sạch journals và lock file nếu có
  try {
    const [delJ1] = await pool.query('DELETE FROM luk_metlife_postings WHERE PatNum = ?', [patNum]);
    if (delJ1.affectedRows > 0) console.log(`  ✓ Đã dọn ${delJ1.affectedRows} dòng trong luk_metlife_postings.`);
  } catch (e) {}
  try {
    const [delJ2] = await pool.query('DELETE FROM luk_metlife_myisam_jobs WHERE PatNum = ?', [patNum]);
    if (delJ2.affectedRows > 0) console.log(`  ✓ Đã dọn ${delJ2.affectedRows} dòng trong luk_metlife_myisam_jobs.`);
  } catch (e) {}

  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const jobDir = process.env.METLIFE_JOB_DIR || path.resolve('metlife-operations');
    await fs.unlink(path.join(jobDir, `patient-${patNum}.lock`)).catch(() => {});
    console.log('  ✓ Đã giải phóng hoàn toàn khóa thao tác của bệnh nhân #1307.');
  } catch (e) {}

  // Tự động kích hoạt biến ghi DB trực tiếp trong .env nếu chưa có
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const envPath = path.resolve('.env');
    let envContent = await fs.readFile(envPath, 'utf8');
    let changed = false;
    if (!envContent.includes('METLIFE_DIRECT_DB_ENABLED=true')) {
      envContent += '\nMETLIFE_DIRECT_DB_ENABLED=true';
      changed = true;
    }
    if (!envContent.includes('ENABLE_OPEN_DENTAL_WRITES=true')) {
      envContent += '\nENABLE_OPEN_DENTAL_WRITES=true';
      changed = true;
    }
    if (changed) {
      await fs.writeFile(envPath, envContent + '\n');
      console.log('  ✓ Đã tự động kích hoạt METLIFE_DIRECT_DB_ENABLED=true và ENABLE_OPEN_DENTAL_WRITES=true trong .env.');
    }
  } catch (e) {}
} catch (err) {
  console.error('Lỗi khi revert:', err);
} finally {
  await closePool();
}
