// Inspect Patient 1307 details, account, procedures, and claims
import {pool, closePool} from '../src/db.js';
import {readPatientContext} from '../src/metlife/context.js';

console.log('=== THÔNG TIN BỆNH NHÂN #1307 TRÊN OPEN DENTAL ===\n');

try {
  // 1. Lấy thông tin cơ bản
  const [patients] = await pool.execute(
    'SELECT PatNum, FName, LName, Preferred, Birthdate, BalTotal, InsEst, ClinicNum FROM patient WHERE PatNum = ?',
    [1307]
  );

  if (!patients.length) {
    console.error('Không tìm thấy bệnh nhân #1307 trong database.');
    process.exit(1);
  }

  const p = patients[0];
  console.log(`Bệnh nhân: ${p.LName}, ${p.FName} (PatNum: ${p.PatNum})`);
  console.log(`Ngày sinh: ${p.Birthdate ? p.Birthdate.toISOString().slice(0, 10) : 'N/A'}`);
  console.log(`Số dư tài khoản (BalTotal): $${p.BalTotal}`);
  console.log(`Bảo hiểm ước tính (InsEst): $${p.InsEst}`);
  console.log(`Phòng khám (ClinicNum): ${p.ClinicNum}\n`);

  // 2. Bảo hiểm (Insurance)
  const [ins] = await pool.execute(
    `SELECT ip.GroupNum, c.CarrierName, s.SubscriberID, pp.Ordinal
     FROM patplan pp
     JOIN inssub s ON s.InsSubNum = pp.InsSubNum
     JOIN insplan ip ON ip.PlanNum = s.PlanNum
     JOIN carrier c ON c.CarrierNum = ip.CarrierNum
     WHERE pp.PatNum = ? ORDER BY pp.Ordinal`,
    [1307]
  );
  console.log('--- BẢO HIỂM HIỆN CÓ ---');
  if (ins.length) {
    ins.forEach((item, idx) => {
      console.log(`  [${idx + 1}] Carrier: ${item.CarrierName} | Group: ${item.GroupNum} | SubscriberID: ${item.SubscriberID}`);
    });
  } else {
    console.log('  (Không có bảo hiểm nào đang gán)');
  }

  // 3. Thủ thuật hoàn thành (Completed Procedures)
  const [procs] = await pool.execute(
    `SELECT pl.ProcNum, pl.ProcDate, pl.ProcFee, pl.ToothNum, pc.ProcCode, pc.Descript, pl.ProcStatus, pl.ProvNum
     FROM procedurelog pl
     JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
     WHERE pl.PatNum = ? AND pl.ProcStatus = 2
     ORDER BY pl.ProcDate DESC LIMIT 10`,
    [1307]
  );
  console.log('\n--- CÁC THỦ THUẬT ĐÃ HOÀN THÀNH (GẦN ĐÂY) ---');
  if (procs.length) {
    procs.forEach((item) => {
      console.log(`  ProcNum: ${item.ProcNum} | Ngày: ${item.ProcDate.toISOString().slice(0, 10)} | Răng: ${item.ToothNum || 'N/A'} | Mã: ${item.ProcCode} (${item.Descript}) | Phí: $${item.ProcFee}`);
    });
  } else {
    console.log('  (Không có thủ thuật hoàn thành nào gần đây)');
  }

  // 4. Các Claim đang chờ chi trả
  const [claims] = await pool.execute(
    `SELECT c.ClaimNum, c.DateService, c.ClaimFee, c.ClaimStatus, c.ClaimType, cr.CarrierName
     FROM claim c
     JOIN insplan ip ON ip.PlanNum = c.PlanNum
     JOIN carrier cr ON cr.CarrierNum = ip.CarrierNum
     WHERE c.PatNum = ? ORDER BY c.DateService DESC LIMIT 5`,
    [1307]
  );
  console.log('\n--- CLAIMS BẢO HIỂM ---');
  if (claims.length) {
    claims.forEach((item) => {
      console.log(`  ClaimNum: ${item.ClaimNum} | Ngày dịch vụ: ${item.DateService.toISOString().slice(0, 10)} | Phí: $${item.ClaimFee} | Trạng thái: ${item.ClaimStatus} | Bảo hiểm: ${item.CarrierName}`);
    });
  } else {
    console.log('  (Chưa có claim nào)');
  }

  // 5. Thanh toán gần đây (Payments & PaySplits)
  const [payments] = await pool.execute(
    `SELECT p.PayNum, p.PayDate, p.PayAmt, p.PayType, p.CheckNum, p.PayNote
     FROM payment p
     WHERE p.PatNum = ? ORDER BY p.PayDate DESC LIMIT 5`,
    [1307]
  );
  console.log('\n--- LỊCH SỬ THANH TOÁN GẦN ĐÂY ---');
  if (payments.length) {
    payments.forEach((item) => {
      console.log(`  PayNum: ${item.PayNum} | Ngày: ${item.PayDate.toISOString().slice(0, 10)} | Số tiền: $${item.PayAmt} | Note: ${item.PayNote || ''}`);
    });
  } else {
    console.log('  (Chưa có thanh toán nào)');
  }

  console.log('\n===============================================================');
  console.log('Bệnh nhân #1307 đã được đọc đầy đủ metadata!');
  console.log('===============================================================\n');
} catch (err) {
  console.error('Lỗi khi đọc dữ liệu:', err.message);
} finally {
  await closePool();
}
