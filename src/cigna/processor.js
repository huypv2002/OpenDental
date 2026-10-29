import {resolveFilePatient} from '../metlife/patientFileIdentity.js';
import {parseCigna} from './parser.js';
import {processLibertyPdf} from '../liberty/processor.js';
import {reviewError} from '../metlife/insuranceSettlement.js';

export async function resolveCignaPatient(pool,{fileName,claim,claimsCount}){
  if(claimsCount>1)return resolveCignaSubscriber(pool,claim);
  return resolveFilePatient(pool,{fileName,carrier:'CIGNA'});
}

export async function resolveCignaSubscriber(pool,claim){
 const id=String(claim?.patient.memberId||'').trim(),claimant=String(claim?.claimantNumber||'');
 if(!id)throw reviewError(`CIGNA Claim ${claim?.claimNumber||''}: file nhiều claim cần Patient ID / Subscriber ID của từng bệnh nhân.`);
 const suffix=/^(.*?)[ *-](\d{2})$/.exec(id),base=suffix?.[1]||id,dependent=suffix?.[2]||(/^\d{2}$/.test(claimant)?claimant:null);
 const variants=dependent?[`${base} ${dependent}`,`${base}-${dependent}`,`${base}*${dependent}`]:[];
 const tiers=suffix?[[id],variants,[base]]:variants.length?[variants,[id]]:[[id]];
 for(const tier of tiers){
  const ids=[...new Set(tier)];
  const [rows]=await pool.execute(`SELECT DISTINCT p.PatNum,p.FName,p.LName,p.Birthdate,p.ClinicNum,p.PriProv,p.ImageFolder,p.ChartNumber
   FROM patient p JOIN patplan pp ON pp.PatNum=p.PatNum JOIN inssub s ON s.InsSubNum=pp.InsSubNum
   WHERE TRIM(s.SubscriberID) IN (${ids.map(()=>'?').join(',')}) ORDER BY p.PatNum LIMIT 2`,ids);
  if(rows.length===1)return rows[0];
  if(rows.length>1)throw reviewError(`CIGNA Claim ${claim.claimNumber}: Subscriber ID khớp nhiều bệnh nhân; chưa lưu thanh toán.`);
 }
 throw reviewError(`CIGNA Claim ${claim.claimNumber}: chưa tìm được bệnh nhân theo Subscriber ID và mã người phụ thuộc; chưa lưu thanh toán.`);
}

export async function processCignaPdf(pool,args,options={}){
  const normalized=parseCigna(args.extracted);
  if(normalized.errors.length)throw Object.assign(new Error(normalized.errors.join('; ')),{code:'EOB_REVIEW_REQUIRED'});
  if(normalized.check.netPaymentCents<=0)throw Object.assign(new Error('CIGNA không có dòng Plan Coinsurance Paid dương; cần đối chiếu trước khi tạo thanh toán.'),{code:'EOB_REVIEW_REQUIRED'});
  return processLibertyPdf(pool,args,{...options,normalized,carrier:'CIGNA',patientResolver:resolveCignaPatient});
}
