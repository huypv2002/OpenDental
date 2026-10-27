import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readInsuranceTextDocument} from './textDocument.js';
import {parseMetlife} from './parser.js';
import {parseDelta} from '../delta/parser.js';
import {parseLiberty} from '../liberty/parser.js';
import {parseCigna} from '../cigna/parser.js';
import {procedureAreaKey} from './procedureIdentity.js';
import {validateLibertyForPosting} from '../liberty/validation.js';
const worker=fileURLToPath(new URL('./pdfToTextWorker.mjs',import.meta.url));
const review=message=>Object.assign(new Error(message),{code:'EOB_REVIEW_REQUIRED'});

export async function convertPdfBytesToText(bytes,{timeoutMs=120000}={}){
 if(bytes.length>30*1024*1024)throw review('Tài liệu EOB vượt quá 30 MB.');
 if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw review('Nội dung EOB không phải PDF.');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'luk-eob-text-'));
 await fs.chmod(dir,0o700);
 try{
  const input=path.join(dir,'input.pdf'),output=path.join(dir,'output.txt');
  await fs.writeFile(input,bytes,{mode:0o600});
  await new Promise((resolve,reject)=>{
   let message,timedOut=false;
   const child=fork(worker,[input,output],{cwd:dir,execArgv:[],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
   const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
   child.on('message',data=>{if(data?.error)message=String(data.error);});
   child.once('error',()=>{clearTimeout(timer);reject(review('Không khởi chạy được thư viện PDF sang TXT.'));});
   child.once('close',code=>{clearTimeout(timer);if(timedOut)reject(review('Chuyển PDF sang TXT quá thời gian; chưa ghi thanh toán.'));else if(code!==0)reject(review(message||'Thư viện PDF sang TXT bị dừng; chưa ghi thanh toán.'));else resolve();});
  });
  const result=JSON.parse(await fs.readFile(output,'utf8'));
  try{return selectConvertedText(result);}
  catch(error){Object.defineProperty(error,'convertedText',{value:result.candidates.at(-1)?.text});throw error;}
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}

// Generated TXT lives below TEXT, outside the scanner's flat incoming listing.
// Retain the original PDF/hash for attachments, archive, history and replay checks.
export async function readPdfAsText(bytes,filePath,{convert=convertPdfBytesToText,log=console.log}={}){
 const hash=createHash('sha256').update(bytes).digest('hex');
 log(`[PDF -> TXT] Đang chuyển ${path.basename(filePath)} bằng Scribe.js...`);
 let text,conversionError;
 try{text=await convert(bytes);}catch(error){if(typeof error.convertedText!=='string')throw error;text=error.convertedText;conversionError=error;}
 const folder=path.join(path.dirname(filePath),'TEXT');await fs.mkdir(folder,{recursive:true});
 const txtPath=path.join(folder,`${path.basename(filePath)}.${hash.slice(0,16)}.txt`),tmp=`${txtPath}.${randomUUID()}.tmp`;
 try{await fs.writeFile(tmp,text,{mode:0o600});await fs.rename(tmp,txtPath);}finally{await fs.rm(tmp,{force:true});}
 log(`[PDF -> TXT] Đã lưu ${txtPath}; đối chiếu claim từ TXT...`);
 if(conversionError)throw review(`${conversionError.message} TXT đã lưu tại ${txtPath}; chưa ghi thanh toán.`);
 const document=readInsuranceTextDocument(Buffer.from(text));
 document.extracted.sha256=hash;
 document.extracted.sourceFormat='pdf-to-text';
 document.extracted.generatedTextPath=txtPath;
 document.extracted.converter='scribe.js-ocr@0.16.1';
 return {...document,pdfBytes:bytes};
}

export function selectConvertedText({candidates,native=false}){
 const good=[],ids=[];let error='Chưa đọc đủ dữ liệu claim từ TXT.';
 for(const {text} of candidates){
  try{
   const extracted=readInsuranceTextDocument(Buffer.from(text)).extracted;
   const parser={'METLIFE':parseMetlife,'LIBERTY':parseLiberty,'CIGNA':parseCigna,'DELTA DENTAL':parseDelta}[extracted.textCarrier];
   const p=parser(extracted);
   const claimIds=p.claims?.map(c=>c.claimNumber)||[p.claimRaw];
   // This verified Delta Provider Tools format has 14-digit claim IDs.
   // Do not accept a converter result that dropped a digit. Other formats review.
   if(extracted.textCarrier==='DELTA DENTAL'&&claimIds.some(id=>!/^\d{14}$/.test(id))){error='Số claim Delta từ thư viện chưa đúng định dạng 14 chữ số đã hỗ trợ.';continue;}
   if(claimIds.length&&claimIds.every(Boolean))ids.push(JSON.stringify(claimIds));
   if(p.errors.length){error=p.errors.join('; ');continue;}
   if(extracted.textCarrier==='LIBERTY')validateLibertyForPosting(p,extracted);
   const signature=JSON.stringify(p.claims?.map(c=>[c.claimNumber,c.patient.memberId,c.patient.birthdate,c.date,c.paymentPayload.amountCents,c.paymentPayload.splits.map(s=>[s.code,s.date,procedureAreaKey(s),s.amountCents]),c.procedures.map(r=>[r.code,r.date,procedureAreaKey(r),r.feeCents,r.benefitCents,r.allowedCents,r.maximumCents,r.deductibleCents,r.patientDueCents,r.percent])])||[p.claimRaw,p.processed,p.benefitCents,p.procedures.map(r=>[r.code,r.date,procedureAreaKey(r),r.feeCents,r.benefitCents])]);
   const names=JSON.stringify(p.claims?.map(c=>[c.patient.firstName,c.patient.lastName])||p.patient);
   good.push({text,signature,names,ids:JSON.stringify(claimIds)});
  }catch(e){error=e.message;}
 }
 if(!good.length)throw review('PDF -> TXT: '+error);
 if(new Set(good.map(r=>r.signature)).size!==1)throw review('Các kết quả chuyển PDF sang TXT khác nhau về bệnh nhân, claim hoặc thanh toán; cần đối chiếu.');
 if(!native&&ids.filter(id=>id===good[0].ids).length<2)throw review('Chưa xác nhận số claim qua hai kết quả của thư viện PDF sang TXT; cần đối chiếu.');
 if(native||good.length===1)return good[0].text;
 const names=[...new Set(good.map(r=>r.names))],corroborated=names.filter(name=>good.filter(r=>r.names===name).length>=2);
 if(corroborated.length!==1)throw review('Tên bệnh nhân trong các kết quả PDF sang TXT chưa xác nhận duy nhất; cần đối chiếu.');
 return good.find(r=>r.names===corroborated[0]).text;
}
