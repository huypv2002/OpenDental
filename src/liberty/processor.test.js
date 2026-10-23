import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {processLibertyPdf} from './processor.js';
import {importPdfToAtoZ} from '../metlife/autoProcessor.js';
import {readInsuranceDocument} from './document.js';
import {parseLiberty} from './parser.js';

function extractedClaims(count){
 const lines=['LIBERTY Dental Plan','PAYMENT DETAILS','Check Number: TESTCHECK','Check Date: 10/07/2026',`NET PAYMENT: ${count===1?'38.00':'80.00'}`];
 for(let i=0;i<count;i++){
  const amount=i===0?'38.00':'42.00';
  lines.push(`Patient: TEST, PERSON${i+1} - TEST-00${i+1}`, 'Plan: TEST PLAN Group: TESTGROUP', `CLAIM: ${7001+i} (Original)`,
   `1 09/22/26 D0150 Comprehensive oral evaluation 100.00 ${amount} 0.00 0.00 0.00 0.00 ${amount}`,
   `CLAIM TOTALS: 100.00 ${amount} 0.00 0.00 0.00 0.00 ${amount}`,`NET PAYMENT FOR PATIENT: ${amount}`);
 }
 return {sha256:'a'.repeat(64),pages:[{lines:lines.map(text=>({text}))}]};
}

async function fixture({claims=1,failHistory=false,failArchive=false,input=null}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'liberty-completion-')),fileName=input?.fileName||'synthetic.pdf',filePath=path.join(root,fileName),fileBytes=input?.pdfBytes||Buffer.from('synthetic PDF bytes');
 const extracted=input?.extracted||extractedClaims(claims),parsed=parseLiberty(extracted);
 await fs.writeFile(filePath,input?.sourceBytes||fileBytes);
 await fs.mkdir(path.join(root,'images'));
 const messages=[],history=[],documents=[],events=[];let locked=false,released=0,payId=100;
 const conn={query:async sql=>{events.push(sql);if(sql.startsWith('LOCK TABLES'))locked=true;if(sql==='UNLOCK TABLES')locked=false;return [[]];},
  execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];
   if(sql.includes('INSERT INTO payment')){assert.equal(args[3],'');assert.ok(parsed.claims.some(c=>args[4]===`Claim number: ${c.claimNumber}`));assert.equal(args[1],parsed.check.date);}
   if(sql.includes('SELECT PayNum')){assert.ok(sql.includes('ExternalId'));assert.equal(args[1],args[2]);assert.ok(args[1]);}
   if(sql.includes('SELECT PayNum'))return [[]];
   if(sql.includes('INSERT INTO payment'))return [{insertId:++payId}];
   if(sql.includes('INSERT INTO securitylog '))return [{insertId:55}];
   if(sql.includes('AS LogDateTime'))return [[{PermType:15,UserNum:0,LogDateTime:'2026-10-07 12:00:00',LogText:'synthetic payment',PatNum:99,DateTPrevious:'0001-01-01 00:00:00'}]];
   return [{affectedRows:1}];
  },release(){assert.equal(locked,false);released++;}};
 const pool={getConnection:async()=>conn,execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];
  assert.equal(locked,false,'pool queries must run after releasing financial table locks');
  if(sql.includes('FROM patient p')){const i=parsed.claims.findIndex(c=>c.patient.memberId===args[0]),id=99+Math.max(i,0),p=parsed.claims[Math.max(i,0)].patient;return [[{PatNum:id,FName:p.firstName,LName:p.lastName,ClinicNum:0,PriProv:1,ImageFolder:`Test${id}`}]];}
  if(sql.includes('procedurecode.ProcCode')&&sql.includes('FROM procedurelog')){
   const claim=parsed.claims[Number(args[0])-99];
   return [claim.procedures.map((p,i)=>({ProcNum:1000+(Number(args[0])-99)*100+i,ProcCode:p.code,ProcDate:p.date,ProcFee:'0.00',ToothNum:p.tooth||'',ProvNum:1,ClinicNum:0}))];
  }
  if(sql.includes('FROM preference'))return [[{PrefName:'DocPath',ValueString:path.join(root,'images')},{PrefName:'AtoZfolderUsed',ValueString:'1'}]];
  if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [[{COLUMN_NAME:'DocNum',EXTRA:'auto_increment'},...['DocCategory','PatNum','FileName','Description','DateCreated','ImgType','MountItemNum','ExternalSource','RawBase64'].map(COLUMN_NAME=>({COLUMN_NAME,IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:''}))]];
  if(sql.includes('Category = 18'))return [[{DefNum:18}]];
  if(sql.includes('INSERT INTO document')){documents.push(args);return [{insertId:200+documents.length}];}
  if(sql.includes('Category = 10'))return [[{DefNum:10,ItemName:'Insurance Paid'}]];
  if(sql.includes('SUM(ProcFee)'))return [[{TotalCharges:38}]];
  if(sql.includes('SUM(SplitAmt)'))return [[{TotalPaid:38}]];
  if(sql.includes('INSERT INTO luk_metlife_history')){
   if(failHistory)throw new Error('synthetic history failure');
   history.push(args);if(failArchive)await fs.unlink(filePath);return [{insertId:history.length}];
  }
  return [{affectedRows:1}];
 }};
 const preparePayload=async(_pool,{claim,patient})=>({payNote:claim.paymentPayload.payNote,updatedFees:['D0150: synthetic'],splits:claim.procedures.map((p,i)=>({ProcNum:1000+(patient.PatNum-99)*100+i,ProvNum:1,ClinicNum:0,date:p.date,code:p.code,amount:(p.benefitCents/100).toFixed(2),SecurityHash:'synthetic-only'}))});
 return {root,pool,args:{filePath,fileName,fileBytes,extracted},options:{preparePayload,log:message=>messages.push(message)},messages,history,documents,events,get released(){return released;}};
}

for(const claims of [1,2])test(`Liberty logs completion after ${claims} claim history records and PDF archive`,async()=>{
 const f=await fixture({claims});
 try{
  const result=await processLibertyPdf(f.pool,f.args,f.options);
  assert.equal(result.success,true);assert.equal(result.claimsCount,claims);assert.equal(f.history.length,claims);assert.equal(f.released,claims);
  assert.equal(f.messages.filter(m=>m.includes('✓ CLAIM HOÀN TẤT')).length,claims);
  assert.match(f.messages.at(-1),new RegExp(`✓ HOÀN THÀNH: synthetic.pdf -> ${claims} claim, .* -> PROCESSED`));
  assert.ok(f.messages.some(m=>m.includes('đã mở khóa; cập nhật số dư')));
  assert.equal(path.dirname(result.archivePath),path.join(f.root,'PROCESSED'));
  assert.deepEqual(await fs.readFile(result.archivePath),f.args.fileBytes);
  await assert.rejects(fs.access(f.args.filePath),{code:'ENOENT'});
  for(const record of f.history){const details=JSON.parse(record[12]);assert.equal(details.archivePath,result.archivePath);assert.equal(details.carrier,'LIBERTY Dental Plan');}
  for(const doc of f.documents){assert.match(doc[2],/^LIBERTY_/);assert.match(doc[3],/^Claim 700[12]  (38|42)\.00$/);assert.equal(doc[4],'2026-10-07 00:00:00');}
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('Liberty never reports a completed file when history or archive fails after payment',async()=>{
 for(const failure of ['failHistory','failArchive']){
  const f=await fixture({[failure]:true});
  try{
   await assert.rejects(processLibertyPdf(f.pool,f.args,f.options),failure==='failHistory'?/synthetic history failure/:{code:'ENOENT'});
   assert.equal(f.messages.some(m=>m.includes('✓ HOÀN THÀNH:')),false);
   assert.equal(f.released,1);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
 }
});

test('shared document importer preserves default MetLife naming',async()=>{
 const f=await fixture();
 try{
  const result=await importPdfToAtoZ(f.pool,{patient:{PatNum:99,ImageFolder:'Test99'},fileBytes:f.args.fileBytes,fileName:'synthetic.pdf',claimNumber:'TESTCLAIM',paymentDate:'2026-09-29',amountCents:43920});
  assert.ok(result.docNum);assert.match(f.documents[0][2],/^METLIFE_/);assert.equal(f.documents[0][3],'Claim TESTCLAIM  439.20');assert.equal(f.documents[0][4],'2026-09-29 00:00:00');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

for(const [key,count] of [['LIBERTY_TEST_SINGLE_IMAGE',1],['LIBERTY_TEST_IMAGE',2]]){
 test(`JPEG with ${count} patient(s) creates isolated mock payments, Finished Claims PDFs and original archive`,{skip:!process.env[key],timeout:120000},async()=>{
  const sourceBytes=await fs.readFile(process.env[key]),input=await readInsuranceDocument(sourceBytes,'synthetic.JPEG');
  const parsed=parseLiberty(input.extracted);assert.equal(parsed.claimsCount,count);
  const f=await fixture({input:{...input,sourceBytes,fileName:'synthetic.JPEG'}});
  try{
   const result=await processLibertyPdf(f.pool,f.args,f.options);
   assert.equal(result.success,true);assert.equal(result.claimsCount,count);assert.equal(f.history.length,count);
   assert.deepEqual(f.history.map(row=>row[2]),Array.from({length:count},(_,i)=>99+i));
   assert.deepEqual(f.history.map(row=>row[6]),parsed.claims.map(c=>(c.totals.planPaidCents/100).toFixed(2)));
   assert.deepEqual(await fs.readFile(result.archivePath),sourceBytes);
   for(let i=0;i<count;i++){
    const stored=await fs.readFile(path.join(f.root,'images','T',`Test${99+i}`,f.documents[i][2]));
    assert.ok(stored.subarray(0,100).includes(Buffer.from('%PDF-')));
    const details=JSON.parse(f.history[i][12]);assert.equal(details.splits.length,parsed.claims[i].procedures.length);
    assert.ok(details.splits.every(s=>s.procNum>=1000+i*100&&s.procNum<1100+i*100));
   }
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
 });
}

test('Liberty uses MetLife unique-code/date matching but never guesses between repeated procedures',async()=>{
 const {matchLibertyProcedures}=await import('./validation.js');
 const makeClaim=()=>({procedures:[{code:'D0220',date:'2026-09-22',tooth:'13',benefitCents:1400}]});
 const proc={ProcNum:1,ProcCode:'D0220',ProcDate:'2026-09-22',ToothNum:'8'};
 assert.throws(()=>matchLibertyProcedures([proc],makeClaim()),e=>e.code==='EOB_REVIEW_REQUIRED');
 const c=makeClaim();assert.equal(matchLibertyProcedures([proc],c,{allowUniqueCodeDate:true}).get(c.procedures[0]).ProcNum,1);assert.match(c.procedures[0].matchWarning,/PDF răng 13, OD răng 8/);
 assert.throws(()=>matchLibertyProcedures([proc,{...proc,ProcNum:2}],makeClaim(),{allowUniqueCodeDate:true}),e=>e.code==='EOB_REVIEW_REQUIRED');
 const multiple=makeClaim();multiple.procedures.push({...multiple.procedures[0],tooth:'23'});assert.throws(()=>matchLibertyProcedures([proc],multiple,{allowUniqueCodeDate:true}),e=>e.code==='EOB_REVIEW_REQUIRED');
});
