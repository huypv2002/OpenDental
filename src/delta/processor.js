import {parseDelta} from './parser.js';
import {processLibertyPdf} from '../liberty/processor.js';

export async function resolveDeltaPatient(pool,{claim,fileName,claimsCount}){
 const fromFile=claimsCount===1?/^(\d+)\.(?:pdf|jpe?g|png)$/i.exec(fileName||'')?.[1]:null;
 const args=[claim.patient.firstName,claim.patient.lastName,claim.patient.birthdate];if(fromFile)args.push(fromFile);args.push(claim.patient.memberId);
 const [rows]=await pool.execute(`SELECT p.PatNum,p.FName,p.LName,p.Birthdate,p.ClinicNum,p.PriProv,p.ImageFolder,p.ChartNumber
 FROM patient p WHERE LOWER(TRIM(p.FName))=LOWER(?) AND LOWER(TRIM(p.LName))=LOWER(?) AND DATE(p.Birthdate)=?
 ${fromFile?'AND p.PatNum=?':''}
 AND EXISTS (SELECT 1 FROM patplan pp JOIN inssub s ON s.InsSubNum=pp.InsSubNum
 JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum
 WHERE pp.PatNum=p.PatNum AND UPPER(c.CarrierName) LIKE '%DELTA%' AND s.SubscriberID=?) LIMIT 2`,args);
 if(rows.length!==1)throw new Error('Chưa đối chiếu duy nhất bệnh nhân, ngày sinh và Subscriber ID Delta Dental; chưa lưu thanh toán.');return rows[0];
}

export async function processDeltaPdf(pool,args,options={}){
 const normalized=parseDelta(args.extracted);
 if(normalized.errors.length)throw Object.assign(new Error(normalized.errors.join('; ')),{code:'EOB_REVIEW_REQUIRED'});
 return processLibertyPdf(pool,args,{...options,normalized,carrier:'DELTA DENTAL',patientResolver:resolveDeltaPatient});
}
