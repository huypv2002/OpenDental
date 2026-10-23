import {cents} from './parser.js';

export const insuranceZeroFields=['InsPayEst','BaseEst','InsEstTotal','InsEstTotalOverride','WriteOff','WriteOffEst','WriteOffEstOverride'];
export const reviewError=message=>Object.assign(new Error(message),{code:'EOB_REVIEW_REQUIRED'});
const marks=items=>items.map(()=>'?').join(',');
export const procedureDay=value=>value instanceof Date?`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`:String(value||'').slice(0,10);
const same=(a,b)=>String(a)===String(b);

// Identify a single OD claim/insurance subscription before any mutation. A claim
// number printed by a carrier is not OD's ClaimNum primary key.
export async function prepareInsuranceSettlement(db,{patNum,carrier,procedures,dbProcs,splits}){
 const ids=new Set(splits.filter(s=>Number(s.ProcNum)>0).map(s=>String(s.ProcNum)));
 for(const p of procedures){
  const matches=dbProcs.filter(r=>r.ProcCode===p.code&&(!p.date||procedureDay(r.ProcDate)===p.date)&&(!/^\d+$/.test(p.tooth||'')||Number(r.ToothNum)===Number(p.tooth)));
  if(matches.length===1)ids.add(String(matches[0].ProcNum));
 }
 if(!ids.size)throw reviewError('Chưa xác định dịch vụ để đặt Insurance Estimate và Write-off về 0.');
 const name=carrier==='LIBERTY Dental Plan'?'LIBERTY':carrier==='DELTA DENTAL'?'DELTA':carrier;
 const [rows]=await db.execute(`SELECT cp.ClaimProcNum,cp.PatNum,cp.ProcNum,cp.ClaimNum,cp.PlanNum,cp.InsSubNum,cp.Status,cp.InsPayAmt,cp.ClaimPaymentNum,${insuranceZeroFields.map(f=>`cp.${f}`).join(',')}
 FROM claimproc cp JOIN insplan ip ON ip.PlanNum=cp.PlanNum JOIN carrier ca ON ca.CarrierNum=ip.CarrierNum
 WHERE cp.PatNum=? AND cp.ProcNum IN (${marks([...ids])}) AND cp.Status IN (0,1,4,6) AND UPPER(ca.CarrierName) LIKE ?`,[patNum,...ids,`%${name.toUpperCase()}%`]);
 const claimIds=[...new Set(rows.filter(r=>Number(r.ClaimNum)>0).map(r=>String(r.ClaimNum)))];
 if(claimIds.length>1)throw reviewError('Dịch vụ liên quan nhiều claim OD của cùng hãng; cần đối chiếu trước khi cập nhật ước tính.');
 const linked=rows.filter(r=>Number(r.ClaimNum)>0),plans=new Set((linked.length?linked:rows).map(r=>`${r.PlanNum}/${r.InsSubNum}`));
 if(plans.size>1)throw reviewError('Dịch vụ liên quan nhiều hợp đồng bảo hiểm; chưa cập nhật ước tính.');
 const selected=rows.filter(r=>Number(r.ClaimNum)>0||plans.has(`${r.PlanNum}/${r.InsSubNum}`));
 if(selected.some(r=>cents(r.InsPayAmt||0)!==0||Number(r.ClaimPaymentNum)>0))throw reviewError('Dịch vụ đã có thanh toán bảo hiểm trong claimproc; cần đối chiếu trước khi tạo Insurance Paid.');
 return {patNum,claimIds,procIds:[...ids],rows:selected};
}

// Run on the same locked connection as Payment/Splits. Recheck identity and
// zero-value readback so a stale preflight cannot silently edit another claim.
export async function verifyInsuranceSettlement(db,plan){
 if(!plan.rows.length)return;
 const ids=plan.rows.map(r=>r.ClaimProcNum);
 const [current]=await db.execute(`SELECT ClaimProcNum,PatNum,ProcNum,ClaimNum,PlanNum,InsSubNum,InsPayAmt,ClaimPaymentNum FROM claimproc WHERE PatNum=? AND ClaimProcNum IN (${marks(ids)})`,[plan.patNum,...ids]);
 if(current.length!==ids.length||current.some(r=>{const old=plan.rows.find(o=>same(o.ClaimProcNum,r.ClaimProcNum));return !old||['PatNum','ProcNum','ClaimNum','PlanNum','InsSubNum'].some(k=>!same(old[k],r[k]))||cents(r.InsPayAmt||0)!==0||Number(r.ClaimPaymentNum)>0;}))throw reviewError('Claim đã thay đổi sau đối chiếu; cần kiểm tra trước khi cập nhật ước tính.');
 return ids;
}

export async function applyInsuranceSettlement(db,plan,date){
 if(!plan.rows.length)return;
 const ids=await verifyInsuranceSettlement(db,plan);
 await db.execute(`UPDATE claimproc SET ${insuranceZeroFields.map(f=>`${f}=0`).join(',')} WHERE PatNum=? AND ClaimProcNum IN (${marks(ids)})`,[plan.patNum,...ids]);
 const [saved]=await db.execute(`SELECT ClaimProcNum,${insuranceZeroFields.join(',')} FROM claimproc WHERE PatNum=? AND ClaimProcNum IN (${marks(ids)})`,[plan.patNum,...ids]);
 if(saved.length!==ids.length||saved.some(r=>insuranceZeroFields.some(f=>r[f]===null||r[f]===undefined||Number(r[f])!==0)))throw reviewError('Chưa xác minh Insurance Estimate / Write-off bằng 0; kiểm tra khoản đã lưu trước khi thử lại.');
 for(const claimNum of plan.claimIds){
  const [sums]=await db.execute('SELECT COALESCE(SUM(InsPayEst),0) AS InsPayEst,COALESCE(SUM(WriteOff),0) AS WriteOff FROM claimproc WHERE ClaimNum=? AND PatNum=?',[claimNum,plan.patNum]);
  await db.execute("UPDATE claim SET ClaimStatus='R',DateReceived=?,InsPayEst=?,WriteOff=? WHERE ClaimNum=? AND PatNum=?",[date,sums[0].InsPayEst,sums[0].WriteOff,claimNum,plan.patNum]);
 }
}

function splitMap(splits,date){
 const values=new Map();
 for(const s of splits){const key=[s.ProcNum,s.ProvNum,s.ClinicNum,procedureDay(s.ProcDate??s.date),procedureDay(s.DatePay??date)].join('/');values.set(key,(values.get(key)||0)+cents(s.SplitAmt??s.amount));}
 return values;
}
export async function verifiedInsurancePayment(db,{patNum,claimNumber,date,amountCents,splits}){
 const [payments]=await db.execute('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment WHERE PatNum = ? AND (ExternalId = ? OR CheckNum = ?)',[patNum,claimNumber,claimNumber]);
 if(!payments.length)return null;
 if(payments.length!==1)throw reviewError('Có nhiều khoản thanh toán cùng claim; cần đối chiếu, không ghi đè.');
 const payment=payments[0];
 if(!same(payment.PatNum,patNum)||procedureDay(payment.PayDate)!==date||cents(payment.PayAmt)!==amountCents)throw reviewError('Khoản đã lưu cùng claim khác bệnh nhân/ngày/số tiền; cần đối chiếu, không ghi đè.');
 const [stored]=await db.execute('SELECT PatNum,ProcNum,ProvNum,ClinicNum,ProcDate,DatePay,SplitAmt FROM paysplit WHERE PayNum=? ORDER BY SplitNum',[payment.PayNum]);
 const expected=splitMap(splits,date),actual=splitMap(stored,date);
 if(stored.length!==splits.length||!stored.length||stored.some(s=>!same(s.PatNum,patNum))||expected.size!==actual.size||[...expected].some(([k,v])=>actual.get(k)!==v))throw reviewError('Khoản đã lưu chưa khớp phân bổ; cần đối chiếu, không ghi đè.');
 return payment;
}

export async function recordInsuranceResult(db,values){
 const [previous]=await db.execute("SELECT Id,Details FROM luk_metlife_history WHERE Status='SUCCESS' AND PayNum=? AND PatNum=? AND ClaimNumber=? ORDER BY Id DESC LIMIT 1",[values[9],values[2],values[4]]);
 if(previous.length){
  let details=previous[0].Details||{};if(typeof details==='string')details=JSON.parse(details);
  const next=JSON.parse(values[12]);details={...details,insuranceDefaults:next.insuranceDefaults,lastVerifiedAt:new Date().toISOString()};
  await db.execute('UPDATE luk_metlife_history SET Details=?,Message=? WHERE Id=?',[JSON.stringify(details),'Đã đối chiếu khoản thanh toán đã lưu; Insurance Estimate và Write-off bằng 0.',previous[0].Id]);
  return {reused:true,id:previous[0].Id};
 }
 const [result]=await db.execute(`INSERT INTO luk_metlife_history (
 FileName,FileHash,PatNum,PatientName,ClaimNumber,CheckNumber,TotalAmount,ProceduresCount,FeesUpdated,PayNum,DocNum,Status,Message,Details,ProcessedAt
 ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'SUCCESS',?,?,NOW())`,values);
 return {reused:false,id:result.insertId};
}
