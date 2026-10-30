import {patientFileNumber,resolveFilePatient} from '../metlife/patientFileIdentity.js';
import {parseDelta} from './parser.js';
import {processLibertyPdf} from '../liberty/processor.js';
import {reviewError} from '../metlife/insuranceSettlement.js';

// Diagnostics may report name differences, but posting identity is PatNum only.
const nameConditionFor=(names,compact)=>names.map(()=>compact
 ? `LOWER(REPLACE(TRIM(p.FName),' ',''))=LOWER(REPLACE(?,' ',''))`
 : `LOWER(TRIM(p.FName))=LOWER(?)`).join(' OR ');

export const deltaPatientFileNumber=patientFileNumber;

export async function resolveDeltaPatient(pool,{fileName,claim,claimsCount}){
 if(claimsCount>1){
  const p=claim?.patient;
  if(!p?.memberId||!p.birthdate||!p.firstName||!p.lastName)throw reviewError('Delta Dental: file nhiều bệnh nhân cần Subscriber ID, ngày sinh và họ tên cho từng claim.');
  const [rows]=await pool.execute(`SELECT DISTINCT p.PatNum,p.FName,p.LName,p.Birthdate,p.ClinicNum,p.PriProv,p.ImageFolder,p.ChartNumber
   FROM patient p JOIN patplan pp ON pp.PatNum=p.PatNum JOIN inssub s ON s.InsSubNum=pp.InsSubNum
   JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum
   WHERE TRIM(s.SubscriberID)=? AND DATE(p.Birthdate)=?
     AND LOWER(TRIM(p.FName))=LOWER(?) AND LOWER(TRIM(p.LName))=LOWER(?)
     AND UPPER(c.CarrierName) LIKE '%DELTA%' ORDER BY p.PatNum LIMIT 2`,[p.memberId,p.birthdate,p.firstName,p.lastName]);
  if(rows.length!==1)throw reviewError(`Delta Dental claim ${claim.claimNumber}: chưa khớp duy nhất Subscriber ID/ngày sinh/họ tên; không dùng chung mã bệnh nhân từ tên file.`);
  return rows[0];
 }
 return resolveFilePatient(pool,{fileName,carrier:'Delta Dental'});
}

// Optional read-only diagnostics; these differences do not block filename identity.
// Report flags only; never put subscriber IDs or connection settings in logs.
export async function diagnoseDeltaPatient(pool,{claim,fileName,claimsCount}){
 const patNum=claimsCount===1?deltaPatientFileNumber(fileName):null;
 if(!patNum)throw new Error('Cần tên file là mã bệnh nhân và đúng một claim để kiểm tra.');
 const first=claim.patient.firstName.trim().replace(/\s+/g,' '),names=[first];
 if(first.includes(' '))names.push(first.split(' ').at(-1));
 const [rows]=await pool.execute(`SELECT p.PatNum,
 (${nameConditionFor(names,true)}) AS firstNameMatches,
 (LOWER(TRIM(p.LName))=LOWER(?)) AS lastNameMatches,
 (DATE(p.Birthdate)=?) AS birthdateMatches,
 EXISTS (SELECT 1 FROM patplan pp JOIN inssub s ON s.InsSubNum=pp.InsSubNum
 JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum
 WHERE pp.PatNum=p.PatNum AND UPPER(c.CarrierName) LIKE '%DELTA%') AS deltaPlanExists,
 EXISTS (SELECT 1 FROM patplan pp JOIN inssub s ON s.InsSubNum=pp.InsSubNum
 JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum
 WHERE pp.PatNum=p.PatNum AND UPPER(c.CarrierName) LIKE '%DELTA%' AND s.SubscriberID=?) AS subscriberMatches
 FROM patient p WHERE p.PatNum=? LIMIT 1`,[...names,claim.patient.lastName,claim.patient.birthdate,claim.patient.memberId,patNum]);
 if(!rows.length)return {patNum:Number(patNum),patientExists:false};
 return {patNum:Number(patNum),patientExists:true,...Object.fromEntries(['firstNameMatches','lastNameMatches','birthdateMatches','deltaPlanExists','subscriberMatches'].map(k=>[k,Number(rows[0][k])===1]))};
}

export async function processDeltaPdf(pool,args,options={}){
 const normalized=parseDelta(args.extracted);
 if(normalized.errors.length)throw Object.assign(new Error(normalized.errors.join('; ')),{code:'EOB_REVIEW_REQUIRED'});
 return processLibertyPdf(pool,args,{...options,normalized,carrier:'DELTA DENTAL',patientResolver:resolveDeltaPatient});
}
