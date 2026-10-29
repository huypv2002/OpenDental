import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {metlifeText,libertyText,cignaText,delta} from './testSupport/insuranceTextFixtures.js';
import {readInsuranceTextDocument} from './textDocument.js';
import {parseMetlife} from './parser.js';
import {parseLiberty} from '../liberty/parser.js';
import {parseCigna} from '../cigna/parser.js';
import {parseDelta} from '../delta/parser.js';
import {processSinglePdf,scanIncomingFolder} from './autoProcessor.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';
import {insuranceZeroFields} from './insuranceSettlement.js';
import {appendDailyWorkbook} from './dailyExcel.js';

const cases=[['METLIFE',metlifeText,parseMetlife,8000],['LIBERTY',libertyText,parseLiberty,74300],['CIGNA',cignaText,parseCigna,5680],['DELTA DENTAL',delta,parseDelta,23200]];
async function fixture(carrier,text,parse){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'insurance-handover-'));
 const dir=path.join(root,carrier);await fs.mkdir(dir);
 const parsed=parse(readInsuranceTextDocument(Buffer.from(text)).extracted);assert.deepEqual(parsed.errors,[]);
 const c=parsed.claims?.[0],procedures=parsed.procedures||c.procedures;
 const f=await insuranceLedger(root,[{patNum:1279,firstName:c?.patient.firstName||'TEST',lastName:c?.patient.lastName||'PERSON',memberId:c?.patient.memberId,claimNumber:c?.claimNumber||parsed.claimRaw,procedures,serviceDate:procedures[0].date}]);
 const file=path.join(dir,'1279.txt');
 const run=async({name='1279.txt',hashSplits=f.hashes}={})=>{const target=path.join(dir,name);await fs.writeFile(target,text);return processSinglePdf(f.pool,target,{hashSplits});};
 return {root,dir,file,text,parsed,procedures,f,run,close:()=>fs.rm(root,{recursive:true,force:true})};
}

for(const [carrier,text,parse,total] of cases){
 test(`HANDOVER ${carrier}: TXT success, exact payment fields, scoped defaults and daily Excel once`,async()=>{
  const x=await fixture(carrier,text,parse),{f}=x;try{
   const unrelated={...f.unrelated};await x.run();
   assert.equal(f.payments.length,1);assert.equal(Math.round(Number(f.payments[0].PayAmt)*100),total);
   assert.equal(f.payments[0].CheckNum,'');assert.equal(f.payments[0].PayNote,`Claim number: ${f.payments[0].ExternalId}`);
   assert.equal(f.splits.reduce((n,s)=>n+Math.round(Number(s.SplitAmt)*100),0),total);
   assert.ok(f.claimprocs.filter(r=>r!==f.unrelated).every(r=>insuranceZeroFields.every(k=>r[k]===0)));
   assert.deepEqual(f.unrelated,unrelated);assert.equal(f.addedAudit.length,0);
   const report=path.join(x.root,'EXCEL','2026-10-28.xlsx');
   assert.equal((await appendDailyWorkbook(f.pool,f.history,report,'2026-10-28')).appended,1);
   const count=f.procs.length;await x.run({name:'1793111377468_1279.txt'});
   assert.equal(f.payments.length,1);assert.equal(f.documents.length,1);assert.equal(f.procs.length,count);
   assert.equal((await appendDailyWorkbook(f.pool,f.history,report,'2026-10-28')).appended,0);
  }finally{await x.close();}
 });
 for(const field of ['PayAmt','PayDate','split','duplicate'])test(`HANDOVER ${carrier}: conflicting saved ${field} stops retry without new financial writes`,async()=>{
  const x=await fixture(carrier,text,parse),{f}=x;try{
   await x.run();
   if(field==='PayAmt')f.payments[0].PayAmt='0.01';
   if(field==='PayDate')f.payments[0].PayDate='2000-01-01';
   if(field==='split')f.splits[0].ProcNum=999999;
   if(field==='duplicate')f.payments.push({...f.payments[0],PayNum:900});
   const before={p:f.payments.length,s:f.splits.length,d:f.documents.length,a:f.addedAudit.length,fees:f.fees.length};
   await assert.rejects(x.run(),e=>e.code==='EOB_REVIEW_REQUIRED');
   assert.deepEqual({p:f.payments.length,s:f.splits.length,d:f.documents.length,a:f.addedAudit.length,fees:f.fees.length},before);
  }finally{await x.close();}
 });
 test(`HANDOVER ${carrier}: cleared ExternalId still reuses exact claim note and all splits`,async()=>{
  const x=await fixture(carrier,text,parse),{f}=x;try{
   await x.run();f.payments[0].ExternalId='';const pay=f.payments[0].PayNum;
   await x.run();assert.equal(f.payments.length,1);assert.equal(f.payments[0].PayNum,pay);
   assert.equal(f.documents.length,1);assert.equal(f.history.length,1);
  }finally{await x.close();}
 });
 test(`HANDOVER ${carrier}: ambiguous existing completed service stops before creating code, document or payment`,async()=>{
  const x=await fixture(carrier,text,parse),{f}=x;try{
   const p=f.procs.find(p=>p.ProcCode===x.procedures.find(p=>p.benefitCents>0).code);f.procs.push({...p,ProcNum:90000});
   await assert.rejects(x.run(),e=>e.code==='EOB_REVIEW_REQUIRED');
   assert.equal(f.payments.length,0);assert.equal(f.documents.length,0);assert.equal(f.addedAudit.length,0);assert.equal(f.fees.length,0);
  }finally{await x.close();}
 });
 test(`HANDOVER ${carrier}: native hash failure creates no payment; retry reuses document and adds one payment`,async()=>{
  const x=await fixture(carrier,text,parse),{f}=x;try{
   await assert.rejects(x.run({hashSplits:async()=>{throw Error('injected native hash failure');}}),/native hash/);
   assert.equal(f.payments.length,0);assert.equal(f.splits.length,0);
   await x.run();assert.equal(f.payments.length,1);assert.equal(f.documents.length,1);
  }finally{await x.close();}
 });
 test(`HANDOVER ${carrier}: failed first split leaves partial payment for review and never posts a second payment`,async()=>{
  const x=await fixture(carrier,text,parse),{f}=x;try{
   const get=f.pool.getConnection;let fail=true;
   f.pool.getConnection=async()=>{const conn=await get();return {...conn,execute:async(sql,args)=>{if(fail&&sql.includes('INSERT INTO paysplit')){fail=false;throw Error('injected split disconnect');}return conn.execute(sql,args);}};};
   await assert.rejects(x.run(),/split disconnect/);assert.equal(f.payments.length,1);assert.equal(f.splits.length,0);
   await assert.rejects(x.run(),e=>e.code==='EOB_REVIEW_REQUIRED'&&/phân bổ/.test(e.message));
   assert.equal(f.payments.length,1);assert.equal(f.splits.length,0);assert.equal(f.history.length,0);
  }finally{await x.close();}
 });
 test(`HANDOVER ${carrier}: history failure after payment is recoverable without duplicating payment or document`,async()=>{
  const x=await fixture(carrier,text,parse),{f}=x;try{
   const execute=f.pool.execute;let fail=true;
   f.pool.execute=async(sql,args)=>{if(fail&&sql.includes('INSERT INTO luk_metlife_history')){fail=false;throw Error('injected history disconnect');}return execute(sql,args);};
   await assert.rejects(x.run(),/history disconnect/);assert.equal(f.payments.length,1);assert.equal(f.history.length,0);
   const pay=f.payments[0].PayNum;await x.run();
   assert.equal(f.payments.length,1);assert.equal(f.payments[0].PayNum,pay);assert.equal(f.history.length,1);assert.equal(f.documents.length,1);
  }finally{await x.close();}
 });
 test(`HANDOVER ${carrier}: scanner ignores TEXT, PROCESSED, ERRORS and REVIEW subfolders`,async()=>{
  const x=await fixture(carrier,text,parse);try{
   for(const folder of ['TEXT','PROCESSED','ERRORS','REVIEW']){await fs.mkdir(path.join(x.dir,folder));await fs.writeFile(path.join(x.dir,folder,'1279.txt'),text);}
   let calls=0;const r=await scanIncomingFolder({execute:async()=>[[]]},path.join(x.root,'METLIFE'),{processFile:async()=>{calls++;},exportReports:async()=>({status:'ok'})});
   assert.equal(r.count,0);assert.equal(calls,0);
  }finally{await x.close();}
 });
}

for(const [carrier,text,parse] of cases)test(`HANDOVER ${carrier}: UTF-8, UTF-16LE/BE and CRLF preserve all claim amounts`,()=>{
 const le=Buffer.from('\ufeff'+text,'utf16le'),be=Buffer.from(le);be.swap16();
 for(const bytes of [Buffer.from(text),Buffer.from('\ufeff'+text.replaceAll('\n','\r\n')),le,be]){
  const result=parse(readInsuranceTextDocument(bytes).extracted);
  assert.deepEqual(result.errors,[]);
  const expected=parse(readInsuranceTextDocument(Buffer.from(text)).extracted);
  assert.equal(result.benefitCents??result.check.netPaymentCents,expected.benefitCents??expected.check.netPaymentCents);
 }
});

test('HANDOVER CIGNA: unsupported JPEG stops before database access',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cigna-image-'));try{
  const dir=path.join(root,'CIGNA');await fs.mkdir(dir);const file=path.join(dir,'1279.jpg');await fs.writeFile(file,'not an imported claim');let queries=0;
  await assert.rejects(processSinglePdf({execute:async()=>{queries++;}},file),e=>e.code==='EOB_REVIEW_REQUIRED'&&/chưa xử lý ảnh CIGNA/.test(e.message));assert.equal(queries,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('HANDOVER METLIFE: multiple patients/claim summaries are refused before database access',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-multi-review-'));try{
  const file=path.join(root,'1279.txt');await fs.writeFile(file,metlifeText+'\f'+metlifeText.replaceAll('1234567890','1234567891'));
  let queries=0;await assert.rejects(processSinglePdf({execute:async()=>{queries++;}},file),/một Claim Number/);assert.equal(queries,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

for(const carrier of ['CIGNA','DELTA DENTAL']){
 const first=carrier==='CIGNA'?cignaText:delta;
 const second=first.replaceAll('TEST PERSON','OTHER PERSON').replaceAll('E262868007800','E262868007801').replaceAll('20262965110923','20262965110924').replaceAll('115084523301','123456789012').replaceAll('10/15/2026','10/16/2026');
 const parse=carrier==='CIGNA'?parseCigna:parseDelta;
 async function batchFixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'insurance-multi-')),text=first+'\f'+second;
  const extracted=readInsuranceTextDocument(Buffer.from(text)).extracted,parsed=parse(extracted);assert.deepEqual(parsed.errors,[]);assert.equal(parsed.claims.length,2);
  const f=await insuranceLedger(root,parsed.claims.map((c,i)=>({patNum:500+i,firstName:c.patient.firstName,lastName:c.patient.lastName,memberId:c.patient.memberId,claimNumber:c.claimNumber,procedures:c.procedures,serviceDate:c.procedures[0].date})));
  const file=path.join(root,'batch.txt');await fs.writeFile(file,text);return {root,text,file,parsed,f};
 }
 test(`HANDOVER ${carrier}: unnamed multi-patient batch requires patient-number filenames before any write`,async()=>{
  const x=await batchFixture(),{f}=x;try{
   await assert.rejects(processSinglePdf(f.pool,x.file,{hashSplits:f.hashes}),e=>e.code==='EOB_REVIEW_REQUIRED'&&new RegExp(carrier==='CIGNA'?'Subscriber ID':'tên file').test(e.message));
   assert.equal(f.payments.length,0);assert.equal(f.documents.length,0);assert.equal(f.history.length,0);assert.equal(f.events.length,0);
  }finally{await fs.rm(x.root,{recursive:true,force:true});}
 });
 test(`HANDOVER ${carrier}: unnamed batch with ambiguous services stops before the first payment or document`,async()=>{
  const x=await batchFixture(),{f}=x;try{
   const row=f.procs.find(p=>p.PatNum===501);f.procs.push({...row,ProcNum:99000});
   await assert.rejects(processSinglePdf(f.pool,x.file,{hashSplits:f.hashes}),e=>e.code==='EOB_REVIEW_REQUIRED');
   assert.equal(f.payments.length,0);assert.equal(f.documents.length,0);assert.equal(f.addedAudit.length,0);assert.equal(f.fees.length,0);
  }finally{await fs.rm(x.root,{recursive:true,force:true});}
 });
}

test('HANDOVER COMMON: a simultaneous scan returns busy and never starts a second file processor',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'insurance-scan-busy-')),dir=path.join(root,'METLIFE');await fs.mkdir(dir);const file=path.join(dir,'123.txt');await fs.writeFile(file,'synthetic');await fs.utimes(file,new Date(0),new Date(0));
 let release,start;const gate=new Promise(r=>release=r),started=new Promise(r=>start=r);let calls=0;
 const pool={execute:async()=>[[]]},options={processFile:async()=>{calls++;start();await gate;return {success:true};},exportReports:async()=>({status:'ok'})};
 const pending=scanIncomingFolder(pool,dir,options);
 try{await started;assert.equal((await scanIncomingFolder(pool,dir,options)).status,'busy');assert.equal(calls,1);release();assert.equal((await pending).count,1);}finally{release();await pending;await fs.rm(root,{recursive:true,force:true});}
});
