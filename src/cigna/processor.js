import {resolveFilePatient} from '../metlife/patientFileIdentity.js';
import {parseCigna} from './parser.js';
import {processLibertyPdf} from '../liberty/processor.js';

export async function resolveCignaPatient(pool,{fileName}){
  return resolveFilePatient(pool,{fileName,carrier:'CIGNA'});
}

export async function processCignaPdf(pool,args,options={}){
  const normalized=parseCigna(args.extracted);
  if(normalized.errors.length)throw Object.assign(new Error(normalized.errors.join('; ')),{code:'EOB_REVIEW_REQUIRED'});
  if(normalized.check.netPaymentCents<=0)throw Object.assign(new Error('CIGNA không có dòng Plan Coinsurance Paid dương; cần đối chiếu trước khi tạo thanh toán.'),{code:'EOB_REVIEW_REQUIRED'});
  return processLibertyPdf(pool,args,{...options,normalized,carrier:'CIGNA',patientResolver:resolveCignaPatient});
}
