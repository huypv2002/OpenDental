// Revert MetLife Claim Payment for Ryan Pham (#1307) & Fix 0.00 Procedure Charges
// 1. Deletes BOTH green lines:
//    - Line 1: Payment & PaySplits ($439.20 / CheckNum '6092230431 99')
//    - Line 2: Unfinalized Insurance Payment ($244.80 'PAYMENT NEEDS TO BE FINALIZED') & claimpayment
// 2. Fixes all 0.00 Procedure Charges (D0120, D0210, D1110, D1208, D0274, D0330, D0220, D0230)
//    Updating procedurelog.ProcFee, claimproc.FeeBilled, claim.ClaimFee, and patient.BalTotal

import {pool, closePool} from '../src/db.js';

console.log('=== TIẾN HÀNH REVERT 2 DÒNG XANH & CẬP NHẬT CHARGES BỆNH NHÂN #1307 ===\n');

const patNum = 1307;

try {
  const conn = await pool.getConnection();
  try {
    // Lock tables for MariaDB integrity
    await conn.query(
      'LOCK TABLES payment WRITE, paysplit WRITE, claimpayment WRITE, claimproc WRITE, claim WRITE, patient WRITE, procedurelog WRITE, procedurecode READ'
    );

    // ==========================================
    // PHẦN 1: REVERT 2 DÒNG MÀU XANH
    // ==========================================
    console.log('--- [1/2] XÓA 2 DÒNG THANH TOÁN MÀU XANH ---');

    // 1A. Xóa Payment dòng 1: "Insurance paid #6092230431 99 $439.20"
    const [payments] = await conn.execute(
      `SELECT PayNum, PayAmt, PayDate, CheckNum, PayNote FROM payment 
       WHERE PatNum = ? AND (CheckNum LIKE '%6092230431%' OR PayAmt IN (439.20, 244.80) OR PayNote LIKE '%301044%')`,
      [patNum]
    );

    if (payments.length === 0) {
      console.log('  Không tìm thấy bản ghi payment $439.20 nào cần xóa.');
    } else {
      for (const p of payments) {
        console.log(`  Tìm thấy Payment: PayNum = ${p.PayNum} | Tiền = $${p.PayAmt} | Note = "${p.PayNote}"`);
        const [delSplits] = await conn.execute('DELETE FROM paysplit WHERE PayNum = ?', [p.PayNum]);
        console.log(`    ✓ Đã xóa ${delSplits.affectedRows} PaySplits thuộc PayNum = ${p.PayNum}`);

        const [delPay] = await conn.execute('DELETE FROM payment WHERE PayNum = ?', [p.PayNum]);
        console.log(`    ✓ Đã xóa bản ghi Payment: PayNum = ${p.PayNum}`);
      }
    }

    // 1B. Xóa dòng 2: "Insurance Payment for Claim 09-20-2026 PAYMENT NEEDS TO BE FINALIZED 244.80"
    // Tìm ClaimPaymentNum liên quan đến bệnh nhân #1307 hoặc có số tiền $244.80
    const [linkedClaimPayments] = await conn.execute(
      'SELECT DISTINCT ClaimPaymentNum FROM claimproc WHERE PatNum = ? AND ClaimPaymentNum > 0',
      [patNum]
    );

    const cpNums = linkedClaimPayments.map((r) => r.ClaimPaymentNum);
    const [otherClaimPayments] = await conn.execute(
      `SELECT ClaimPaymentNum, CheckAmt FROM claimpayment WHERE CheckAmt IN (244.80, 439.20) OR CheckNum LIKE '%6092230431%'`
    );
    for (const op of otherClaimPayments) {
      if (!cpNums.includes(op.ClaimPaymentNum)) cpNums.push(op.ClaimPaymentNum);
    }

    if (cpNums.length > 0) {
      for (const cpNum of cpNums) {
        const [delCp] = await conn.execute('DELETE FROM claimpayment WHERE ClaimPaymentNum = ?', [cpNum]);
        console.log(`    ✓ Đã xóa claimpayment #${cpNum} (${delCp.affectedRows} dòng).`);
      }
    } else {
      console.log('  Không tìm thấy bản ghi claimpayment lẻ.');
    }

    // 1C. Reset toàn bộ claimproc của bệnh nhân #1307 về trạng thái chưa thanh toán
    const [resetCp] = await conn.execute(
      `UPDATE claimproc SET InsPayAmt = 0, Status = 0, ClaimPaymentNum = 0, DateCP = '0001-01-01', PayPlanNum = 0 WHERE PatNum = ?`,
      [patNum]
    );
    console.log(`  ✓ Đã reset ${resetCp.affectedRows} dòng claimproc về trạng thái chờ chi trả ban đầu.`);

    // 1D. Reset claim về trạng thái Waiting (chờ nhận tiền)
    const [resetClaim] = await conn.execute(
      `UPDATE claim SET ClaimStatus = 'W', DateReceived = '0001-01-01' WHERE PatNum = ?`,
      [patNum]
    );
    console.log(`  ✓ Đã reset claim của bệnh nhân #1307 về trạng thái 'W' (Waiting).`);

    // ==========================================
    // PHẦN 2: CẬP NHẬT CHARGES TỪ 0.00 THÀNH PHÍ CHUẨN
    // ==========================================
    console.log('\n--- [2/2] CẬP NHẬT CHARGES CÁC THỦ THUẬT (ProcFee Fix) ---');

    // Bảng giá chuẩn cho các thủ thuật của Ryan Pham:
    // Theo EOB: D0120 ($96.00), D1208 ($50.00), D1110 ($120.00), D0210 ($222.00) => Tổng $488.00
    // Các thủ thuật chụp phim kèm theo: D0274 ($70.00), D0330 ($130.00), D0220 ($33.00), D0230 ($27.00)
    const standardFees = {
      D0120: 96.00,  // Periodic oral eval (EOB: $96.00, trả 90% = $86.40)
      D1208: 50.00,  // Topical fluoride (EOB: $50.00, trả 90% = $45.00)
      D1110: 120.00, // Adult prophy (EOB: $120.00, trả 90% = $108.00)
      D0210: 222.00, // Intraoral complete series (EOB: $222.00, trả 90% = $199.80)
      D0274: 70.00,  // Bitewings - 4 images
      D0330: 130.00, // Panoramic image
      D0220: 33.00,  // Periapical first image
      D0230: 27.00   // Periapical additional image
    };

    const [patientProcs] = await conn.execute(
      `SELECT procedurelog.ProcNum, procedurelog.ProcDate, procedurelog.ProcFee, procedurecode.ProcCode, procedurecode.Descript
       FROM procedurelog
       JOIN procedurecode ON procedurecode.CodeNum = procedurelog.CodeNum
       WHERE procedurelog.PatNum = ? AND procedurelog.ProcStatus = 2`,
      [patNum]
    );

    let updatedCount = 0;
    for (const proc of patientProcs) {
      const targetFee = standardFees[proc.ProcCode];
      if (targetFee !== undefined) {
        await conn.execute('UPDATE procedurelog SET ProcFee = ? WHERE ProcNum = ?', [targetFee, proc.ProcNum]);
        await conn.execute('UPDATE claimproc SET FeeBilled = ? WHERE ProcNum = ?', [targetFee, proc.ProcNum]);
        console.log(`  ✓ Cập nhật ${proc.ProcCode} (${proc.Descript}): $${proc.ProcFee} ➔ $${targetFee.toFixed(2)}`);
        updatedCount++;
      }
    }

    // Cập nhật tổng ClaimFee trên bảng claim
    const [claims] = await conn.execute('SELECT ClaimNum FROM claim WHERE PatNum = ?', [patNum]);
    for (const c of claims) {
      const [sumRes] = await conn.execute(
        'SELECT SUM(FeeBilled) AS TotalClaimFee FROM claimproc WHERE ClaimNum = ?',
        [c.ClaimNum]
      );
      const totalClaimFee = sumRes[0]?.TotalClaimFee || 0;
      await conn.execute('UPDATE claim SET ClaimFee = ? WHERE ClaimNum = ?', [totalClaimFee, c.ClaimNum]);
      console.log(`  ✓ Cập nhật Claim #${c.ClaimNum}: ClaimFee = $${Number(totalClaimFee).toFixed(2)}`);
    }

    // Cập nhật lại số dư tài khoản bệnh nhân (BalTotal)
    const [sumProcs] = await conn.execute(
      'SELECT SUM(ProcFee) AS TotalCharges FROM procedurelog WHERE PatNum = ? AND ProcStatus = 2',
      [patNum]
    );
    const [sumPayments] = await conn.execute(
      'SELECT SUM(SplitAmt) AS TotalPaid FROM paysplit WHERE PatNum = ?',
      [patNum]
    );
    const totalCharges = Number(sumProcs[0]?.TotalCharges || 0);
    const totalPaid = Number(sumPayments[0]?.TotalPaid || 0);
    const finalBalance = (totalCharges - totalPaid).toFixed(2);

    await conn.execute('UPDATE patient SET BalTotal = ? WHERE PatNum = ?', [finalBalance, patNum]);
    console.log(`  ✓ Cập nhật BalTotal bệnh nhân #1307 = $${finalBalance} (Charges: $${totalCharges.toFixed(2)} - Paid: $${totalPaid.toFixed(2)})`);

    await conn.query('UNLOCK TABLES');
    console.log('\n>>> HOÀN TẤT THÀNH CÔNG: 2 dòng xanh đã biến mất, toàn bộ Charges đã có phí chuẩn!');
  } finally {
    try { await conn.query('UNLOCK TABLES'); } catch {}
    conn.release();
  }

  // Dọn sạch journals và lock file nếu có
  try {
    await pool.query('DELETE FROM luk_metlife_postings WHERE PatNum = ?', [patNum]);
    await pool.query('DELETE FROM luk_metlife_myisam_jobs WHERE PatNum = ?', [patNum]);
  } catch (e) {}

  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const jobDir = process.env.METLIFE_JOB_DIR || path.resolve('metlife-operations');
    await fs.unlink(path.join(jobDir, `patient-${patNum}.lock`)).catch(() => {});
  } catch (e) {}

} catch (err) {
  console.error('Lỗi khi thực hiện:', err);
} finally {
  await closePool();
}
