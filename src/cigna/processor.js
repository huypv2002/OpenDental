import {parseCigna} from './parser.js';
import {processLibertyPdf} from '../liberty/processor.js';

export async function resolveCignaPatient(pool,{claim,fileName,claimsCount}){
  const fromFile=claimsCount===1?/^(?:\d{13}_)?(\d{1,12})\.(?:pdf|txt)$/i.exec(fileName||'')?.[1]:null;
  const args=[claim.patient.firstName,claim.patient.lastName];
  if(fromFile)args.push(fromFile);
  const [rows]=await pool.execute(
    `SELECT p.PatNum,p.FName,p.LName,p.Birthdate,p.ClinicNum,p.PriProv,p.ImageFolder,p.ChartNumber
     FROM patient p WHERE LOWER(TRIM(p.FName))=LOWER(?) AND LOWER(TRIM(p.LName))=LOWER(?)
     ${fromFile?'AND p.PatNum=?':''}
     AND EXISTS (SELECT 1 FROM patplan pp JOIN inssub s ON s.InsSubNum=pp.InsSubNum
       JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum
       WHERE pp.PatNum=p.PatNum AND UPPER(c.CarrierName) LIKE '%CIGNA%') LIMIT 2`,args);
  if(rows.length!==1)throw new Error('Chưa đối chiếu duy nhất bệnh nhân và bảo hiểm CIGNA; chưa lưu thanh toán.');
  return rows[0];
}

export async function processCignaPdf(pool,args,options={}){
  const normalized=parseCigna(args.extracted);
  if(normalized.errors.length)throw Object.assign(new Error(normalized.errors.join('; ')),{code:'EOB_REVIEW_REQUIRED'});
  if(normalized.check.netPaymentCents<=0)throw Object.assign(new Error('CIGNA không có dòng Plan Coinsurance Paid dương; cần đối chiếu trước khi tạo thanh toán.'),{code:'EOB_REVIEW_REQUIRED'});
  return processLibertyPdf(pool,args,{...options,normalized,carrier:'CIGNA',patientResolver:resolveCignaPatient});
}
