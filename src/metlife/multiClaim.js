import {parseMetlife} from './parser.js';
import {resolveMetlifeAllowableProcedures} from './allowableProcedure.js';
import {reviewError} from './insuranceSettlement.js';

// Group complete Claim Summary pages with their continuation/payment pages.
export function parseMetlifeClaims(extracted,options={}) {
  const groups=[];
  for(const page of extracted.pages){
    const count=page.lines.reduce((n,r)=>n+(r.text.match(/\bClaim Summary\b/g)||[]).length,0);
    if(count>1)throw reviewError('MetLife: nhiều Claim Summary trên cùng trang; cần tách rõ claim.');
    if(count===1)groups.push([]);
    if(!groups.length)throw reviewError('MetLife: trang đầu thiếu Claim Summary.');
    groups.at(-1).push(page);
  }
  const claims=groups.map(pages=>parseMetlife({...extracted,pages},options));
  if(!claims.length)throw reviewError('MetLife: thiếu Claim Summary.');
  const errors=claims.flatMap(c=>c.errors);
  if(new Set(claims.map(c=>c.claimRaw)).size!==claims.length)errors.push('MetLife: số claim xuất hiện nhiều lần trong một tài liệu.');
  return {claims,errors,warnings:claims.flatMap(c=>c.warnings)};
}

export function normalizedMetlifeBatch(batch){
  if(batch.errors.length)throw reviewError(batch.errors.join('; '));
  const claims=batch.claims.map(p=>{
    const name=p.patient.trim().split(/\s+/),lastName=name.pop(),firstName=name.join(' ');
    const procedures=resolveMetlifeAllowableProcedures(p.procedures).map((r,i)=>({...r,line:i+1,
      allowedCents:r.coveredCents??0,copayCents:0,deductibleCents:r.deductibleCents??0,coinsuranceCents:0,patientDueCents:0}));
    return {claimNumber:p.claimRaw,claimBase:p.claimBase,patient:{firstName,lastName},plan:{carrier:'MetLife',group:p.group},
      procedures,rawProcedures:p.procedures,totals:{planPaidCents:p.benefitCents},check:{date:p.processed,number:'',netPaymentCents:p.benefitCents},eobPayment:p.payment};
  });
  return {claims,claimsCount:claims.length,check:{date:claims[0].check.date,number:'',netPaymentCents:claims.reduce((n,c)=>n+c.totals.planPaidCents,0)},errors:[],warnings:batch.warnings};
}

// A multi-patient file cannot use the single PatNum in its filename for all
// claims. Require a unique exact patient name within the EOB's MetLife group.
export async function resolveMetlifeBatchPatient(pool,{claim}){
  const [rows]=await pool.execute(`SELECT DISTINCT p.PatNum,p.FName,p.LName,p.Birthdate,p.ClinicNum,p.PriProv,p.ImageFolder,p.ChartNumber
    FROM patient p JOIN patplan pp ON pp.PatNum=p.PatNum
    JOIN inssub s ON s.InsSubNum=pp.InsSubNum JOIN insplan ip ON ip.PlanNum=s.PlanNum
    JOIN carrier c ON c.CarrierNum=ip.CarrierNum
    WHERE UPPER(c.CarrierName) LIKE '%METLIFE%' AND TRIM(ip.GroupNum)=?
      AND LOWER(TRIM(p.FName))=LOWER(?) AND LOWER(TRIM(p.LName))=LOWER(?)
    ORDER BY p.PatNum LIMIT 2`,[claim.plan.group,claim.patient.firstName,claim.patient.lastName]);
  if(rows.length!==1)throw reviewError(`MetLife claim ${claim.claimNumber}: cần khớp duy nhất tên bệnh nhân và group bảo hiểm; không dùng mã bệnh nhân từ tên file cho cả batch.`);
  return rows[0];
}
