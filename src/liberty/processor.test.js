import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {processLibertyPdf} from './processor.js';
import {importPdfToAtoZ} from '../metlife/autoProcessor.js';

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

async function fixture({claims=1,failHistory=false,failArchive=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'liberty-completion-')),fileName='synthetic.pdf',filePath=path.join(root,fileName),fileBytes=Buffer.from('synthetic PDF bytes');
 await fs.writeFile(filePath,fileBytes);
 const messages=[],history=[],documents=[],events=[];let locked=false,released=0,payId=100;
 const conn={query:async sql=>{events.push(sql);if(sql.startsWith('LOCK TABLES'))locked=true;if(sql==='UNLOCK TABLES')locked=false;return [[]];},
  execute:async(sql)=>{
   if(sql.includes('SELECT PayNum'))return [[]];
   if(sql.includes('INSERT INTO payment'))return [{insertId:++payId}];
   if(sql.includes('INSERT INTO securitylog '))return [{insertId:55}];
   if(sql.includes('AS LogDateTime'))return [[{PermType:15,UserNum:0,LogDateTime:'2026-10-07 12:00:00',LogText:'synthetic payment',PatNum:99,DateTPrevious:'0001-01-01 00:00:00'}]];
   return [{affectedRows:1}];
  },release(){assert.equal(locked,false);released++;}};
 const pool={getConnection:async()=>conn,execute:async(sql,args)=>{
  assert.equal(locked,false,'pool queries must run after releasing financial table locks');
  if(sql.includes('FROM patient p')){const id=args[0].includes('002')?100:99;return [[{PatNum:id,FName:'TEST',LName:'PERSON',ClinicNum:0,PriProv:1,ImageFolder:`Test${id}`}]];}
  if(sql.includes('FROM preference'))return [[{PrefName:'DocPath',ValueString:path.join(root,'images')}]];
  if(sql.includes('Category = 19'))return [[{DefNum:18}]];
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
 const preparePayload=async(_pool,{claim})=>({payNote:claim.paymentPayload.payNote,updatedFees:['D0150: synthetic'],splits:claim.procedures.map(p=>({ProcNum:51,ProvNum:1,ClinicNum:0,date:p.date,code:p.code,amount:(p.benefitCents/100).toFixed(2),SecurityHash:'synthetic-only'}))});
 return {root,pool,args:{filePath,fileName,fileBytes,extracted:extractedClaims(claims)},options:{preparePayload,log:message=>messages.push(message)},messages,history,documents,events,get released(){return released;}};
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
  for(const doc of f.documents){assert.match(doc[2],/^LIBERTY_/);assert.equal(doc[3],'LIBERTY Dental Plan EOB Finished Claim');}
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
  const result=await importPdfToAtoZ(f.pool,{patient:{PatNum:99,ImageFolder:'Test99'},fileBytes:f.args.fileBytes,fileName:'synthetic.pdf',claimNumber:'TESTCLAIM'});
  assert.ok(result.docNum);assert.match(f.documents[0][2],/^METLIFE_/);assert.equal(f.documents[0][3],'MetLife EOB Finished Claim');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
