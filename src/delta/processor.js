import {parseDelta} from './parser.js';
import {processLibertyPdf} from '../liberty/processor.js';

export function deltaPatientFileNumber(fileName){
 // A downloaded attachment can add a millisecond timestamp before PatNum.
 // Never treat an arbitrary embedded number or the timestamp as a patient hint.
 const number=/^(?:\d{13}_)?(\d{1,12})\.(?:pdf|jpe?g|png|txt)$/i.exec(fileName||'')?.[1];
 return number&&Number.isSafeInteger(Number(number))&&Number(number)>0?number:null;
}

export async function resolveDeltaPatient(pool,{claim,fileName,claimsCount}){
 const fromFile=claimsCount===1?deltaPatientFileNumber(fileName):null;
 const firstName=claim.patient.firstName.trim().replace(/\s+/g,' ');
 const names=[firstName];
 // OD can retain only the given name (TOAN) while the EOB prints QUOC TOAN.
 // Permit that exact final token only when a single-claim filename also binds
 // the same PatNum; surname, DOB, Delta carrier and Subscriber ID remain mandatory.
 if(fromFile&&firstName.includes(' '))names.push(firstName.split(' ').at(-1));
 const nameCondition=names.map(()=>`LOWER(TRIM(p.FName))=LOWER(?)`).join(' OR ');
 const args=[...names,claim.patient.lastName,claim.patient.birthdate];if(fromFile)args.push(fromFile);args.push(claim.patient.memberId);
 const [rows]=await pool.execute(`SELECT p.PatNum,p.FName,p.LName,p.Birthdate,p.ClinicNum,p.PriProv,p.ImageFolder,p.ChartNumber
 FROM patient p WHERE (${nameCondition}) AND LOWER(TRIM(p.LName))=LOWER(?) AND DATE(p.Birthdate)=?
 ${fromFile?'AND p.PatNum=?':''}
 AND EXISTS (SELECT 1 FROM patplan pp JOIN inssub s ON s.InsSubNum=pp.InsSubNum
 JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum
 WHERE pp.PatNum=p.PatNum AND UPPER(c.CarrierName) LIKE '%DELTA%' AND s.SubscriberID=?) LIMIT 2`,args);
 if(rows.length!==1){
  let detail='';
  if(rows.length===0&&fromFile){
   const checks=await diagnoseDeltaPatient(pool,{claim,fileName,claimsCount});
   const missing=Object.entries(checks).filter(([key,value])=>key!=='patNum'&&value===false).map(([key])=>({patientExists:'mã bệnh nhân',firstNameMatches:'tên',lastNameMatches:'họ',birthdateMatches:'ngày sinh',deltaPlanExists:'bảo hiểm Delta',subscriberMatches:'Subscriber ID thuộc Delta'}[key]));
   if(missing.length)detail=` Hồ sơ #${fromFile} không khớp: ${missing.join(', ')}.`;
  }
  throw Object.assign(new Error('Chưa đối chiếu duy nhất bệnh nhân, ngày sinh và Subscriber ID Delta Dental; chưa lưu thanh toán.'+detail),{code:'EOB_REVIEW_REQUIRED'});
 }
 return rows[0];
}

// Read-only diagnostics use the same SQL comparisons as the actual resolver.
// Report flags only; never put subscriber IDs or connection settings in logs.
export async function diagnoseDeltaPatient(pool,{claim,fileName,claimsCount}){
 const patNum=claimsCount===1?deltaPatientFileNumber(fileName):null;
 if(!patNum)throw new Error('Cần tên file là mã bệnh nhân và đúng một claim để kiểm tra.');
 const first=claim.patient.firstName.trim().replace(/\s+/g,' '),names=[first];
 if(first.includes(' '))names.push(first.split(' ').at(-1));
 const [rows]=await pool.execute(`SELECT p.PatNum,
 (${names.map(()=>`LOWER(TRIM(p.FName))=LOWER(?)`).join(' OR ')}) AS firstNameMatches,
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
