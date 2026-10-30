import {reviewError} from './insuranceSettlement.js';

// Older clinic payments can store only the base claim in a free-text note
// (e.g. "Claims #5101035732"), rather than today's canonical ExternalId/note.
// Stop before adding procedures or changing fees; never repair old payments here.
export async function assertNoLegacyMetlifePayment(db,{patNum,claimRaw,claimBase}) {
  if(!/^\d+$/.test(claimBase||''))return;
  const [rows]=await db.execute(`SELECT PayNum,PatNum,PayDate,PayAmt FROM payment
    WHERE PatNum = ? AND (ExternalId = ? OR CheckNum = ? OR PayNote REGEXP ?)
    AND NOT (COALESCE(ExternalId,'') = ? OR TRIM(COALESCE(PayNote,'')) = ?)`,[
    patNum,claimBase,claimBase,`(^|[^0-9])${claimBase}([^0-9]|$)`,claimRaw,`Claim number: ${claimRaw}`
  ]);
  if(rows.length)throw reviewError(`Claim ${claimRaw}: đã có ${rows.length} khoản thanh toán dùng số claim cũ ${claimBase} (PayNum: ${rows.map(r=>r.PayNum).join(', ')}); cần đối chiếu payment/splits hiện có, chưa thêm dịch vụ hoặc ghi thanh toán mới.`);
}
