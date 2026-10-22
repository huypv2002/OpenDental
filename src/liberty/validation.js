export function validateLibertyForPosting(parsed,extracted={}, {claimPattern=/^\d+$/,requireMember=true,verifyLibertyOcr=true}={}){
 const errors=[...parsed.errors];
 const safe=n=>Number.isSafeInteger(n)&&n>=0;
 if(!parsed.claims.length||!safe(parsed.check.netPaymentCents)||parsed.check.netPaymentCents<=0)errors.push('Thiếu tổng NET PAYMENT hợp lệ.');
 let sum=0,rowCount=0;
 const claimIds=new Set();
 for(const claim of parsed.claims){
  if(claimIds.has(claim.claimNumber))errors.push('Số claim xuất hiện nhiều lần; cần đối chiếu tài liệu gốc.');
  claimIds.add(claim.claimNumber);
  if(!claimPattern.test(claim.claimNumber)||!claim.patient.firstName||!claim.patient.lastName||(requireMember&&!claim.patient.memberId))errors.push('Thiếu số claim hoặc thông tin bệnh nhân để đối chiếu.');
  const amount=claim.totals.planPaidCents,rows=claim.procedures;
  if(!safe(amount)||amount<=0||rows.reduce((n,p)=>n+p.benefitCents,0)!==amount)errors.push(`Claim ${claim.claimNumber}: tổng dịch vụ không khớp tổng claim.`);
  if(rows.some((p,i)=>p.line!==i+1||!p.date||!/^D\d{4}$/.test(p.code)||!['benefitCents','feeCents','allowedCents','copayCents','deductibleCents','coinsuranceCents','patientDueCents'].every(k=>safe(p[k]))))errors.push(`Claim ${claim.claimNumber}: dòng dịch vụ thiếu hoặc không hợp lệ.`);
  if(extracted.ocr&&verifyLibertyOcr){
   for(const key of ['submittedCents','allowedCents','copayCents','deductibleCents','coinsuranceCents','patientDueCents']){
    if(rows.reduce((n,p)=>n+p[key],0)!==claim.totals[key])errors.push(`Claim ${claim.claimNumber}: tổng cột ${key} không khớp.`);
   }
  }
  sum+=amount;rowCount+=rows.length;
 }
 if(sum!==parsed.check.netPaymentCents)errors.push('Tổng các claim không khớp NET PAYMENT của check.');
 if(extracted.ocr&&verifyLibertyOcr&&rowCount!==extracted.pages.reduce((n,p)=>n+(p.ocrRows||0),0))errors.push('Có dòng dịch vụ OCR chưa đọc đủ các cột tiền.');
 if(errors.length)throw Object.assign(new Error([...new Set(errors)].join('; ')),extracted.ocr?{code:'EOB_REVIEW_REQUIRED'}:{});
 return parsed;
}

export function matchLibertyProcedures(procs,claim){
 const result=new Map(),ids=new Set();
 for(const p of claim.procedures.filter(p=>p.benefitCents>0)){
  const candidates=procs.filter(r=>r.ProcCode===p.code&&(r.ProcDate?.toISOString?.().slice(0,10)||String(r.ProcDate).slice(0,10))===p.date&&(!/^\d+$/.test(p.tooth||'')||String(r.ToothNum)===p.tooth));
  if(candidates.length!==1||ids.has(String(candidates[0]?.ProcNum)))throw new Error(`${p.code}: chưa khớp duy nhất dịch vụ hoàn tất theo ngày/răng; cần đối chiếu.`);
  ids.add(String(candidates[0].ProcNum));result.set(p,candidates[0]);
 }
 return result;
}
