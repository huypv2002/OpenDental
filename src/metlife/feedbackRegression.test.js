import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {extractPdf,parseMetlife} from './parser.js';
import {metlifePaymentFields} from './paymentFormat.js';
import {parseLiberty} from '../liberty/parser.js';
import {parseCigna} from '../cigna/parser.js';
import {parseDelta} from '../delta/parser.js';
import {readDeltaDocument} from '../delta/document.js';
import {processSinglePdf,scanIncomingFolder,retryErrorFiles} from './autoProcessor.js';
import {insuranceZeroFields} from './insuranceSettlement.js';
import {appendDailyWorkbook} from './dailyExcel.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';

const fixtureDir=process.env.INSURANCE_FEEDBACK_DIR;
const cases=[['493','CIGNA',42000,'2025-09-05'],['1307','MetLife',43920,'2026-09-29'],['1283','DELTA DENTAL',20150,'2026-10-21'],['1282','LIBERTY Dental Plan',16700,'2026-10-07'],['1278','MetLife',44200,'2026-09-22'],['1041','LIBERTY Dental Plan',173300,'2026-10-02']];
async function loadCase(id,carrier){
 const all=await fs.readdir(fixtureDir),file=all.find(f=>f.startsWith(id+' ')&&f.endsWith('.pdf'));
 assert.ok(file,`Missing private feedback fixture ${id}`);const bytes=await fs.readFile(path.join(fixtureDir,file));
 const extracted=carrier==='DELTA DENTAL'?(await readDeltaDocument(bytes,file)).extracted:await extractPdf(bytes);
 const p=carrier==='CIGNA'?parseCigna(extracted):carrier==='DELTA DENTAL'?parseDelta(extracted):carrier==='MetLife'?parseMetlife(extracted):parseLiberty(extracted);
 assert.deepEqual(p.errors,[]);
 const normalized=carrier==='MetLife'?[{claimNumber:metlifePaymentFields(p).claimNumber,patient:{firstName:'PERSON',lastName:'TEST'},date:p.processed,procedures:p.procedures}]:p.claims;
 const claims=normalized.map((c,i)=>({carrier,patNum:normalized.length===1?Number(id):101+i,claimNumber:c.claimNumber,firstName:c.patient.firstName,lastName:c.patient.lastName,memberId:c.patient.memberId,serviceDate:c.procedures.find(p=>p.date)?.date,procedures:c.procedures.map(p=>({...p,...(carrier==='LIBERTY Dental Plan'&&p.code==='D0220'?{odTooth:p.tooth==='8'?'13':'8'}:{})}))}));
 return {bytes,extracted,parsed:p,claims};
}

for(const [id,carrier,total,date] of cases)test(`feedback ${id}: source PDF -> scoped zero defaults, payment, Finished Claims, Excel; repeat preserves IDs`,{skip:!fixtureDir,timeout:120000},async()=>{
 const input=await loadCase(id,carrier),root=await fs.mkdtemp(path.join(os.tmpdir(),`insurance-feedback-${id}-`));
 const incoming=path.join(root,carrier==='MetLife'?'METLIFE':carrier==='LIBERTY Dental Plan'?'LIBERTY':carrier),filePath=path.join(incoming,`${id}.pdf`);
 await fs.mkdir(incoming);const f=await insuranceLedger(root,input.claims),beforeUnrelated={...f.unrelated};
 try{
  await fs.writeFile(filePath,input.bytes);
  const result=await processSinglePdf(f.pool,filePath,{hashSplits:f.hashes});assert.equal(result.success,true);
  assert.equal(f.payments.length,input.claims.length);assert.equal(f.payments.reduce((n,p)=>n+Math.round(Number(p.PayAmt)*100),0),total);assert.ok(f.payments.every(p=>p.PayDate===date&&p.CheckNum===''&&p.PayNote===`Claim number: ${p.ExternalId}`));
  const affected=f.claimprocs.filter(r=>r!==f.unrelated);assert.ok(affected.length);assert.ok(affected.every(r=>insuranceZeroFields.every(k=>r[k]===0)));assert.deepEqual(f.unrelated,beforeUnrelated);assert.ok(f.fees.every(args=>!args.includes(99998)));
  assert.equal(f.documents.length,input.claims.length);assert.equal(f.history.length,input.claims.length);assert.ok(f.documents.every(d=>d.DateCreated===`${date} 00:00:00`));
  if(id==='493')assert.deepEqual(f.splits.map(s=>f.procs.find(p=>p.ProcNum===s.ProcNum).ToothNum),['10','25','26','28','3']);
  if(carrier==='LIBERTY Dental Plan')assert.ok(f.history.some(r=>JSON.parse(r.Details).procedureMatchWarnings.length),'unique-code/date tooth discrepancy is recorded');
  const report=path.join(root,'EXCEL','2026-10-23.xlsx');await appendDailyWorkbook(f.pool,f.history,report,'2026-10-23');const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(report);assert.equal(wb.getWorksheet('PAYMENTS').getCell('N2').value,carrier);
  const oldPayments=f.payments.map(p=>p.PayNum),oldDocs=f.documents.map(d=>d.DocNum),oldSplits=f.splits.length,oldFees=f.fees.length,oldHashes=f.hashCalls;
  await fs.writeFile(filePath,input.bytes);await processSinglePdf(f.pool,filePath,{hashSplits:f.hashes});
  assert.deepEqual(f.payments.map(p=>p.PayNum),oldPayments);assert.deepEqual(f.documents.map(d=>d.DocNum),oldDocs);assert.equal(f.splits.length,oldSplits);assert.equal(f.fees.length,oldFees);assert.equal(f.hashCalls,oldHashes);assert.equal(f.history.length,input.claims.length);
  const repeat=await appendDailyWorkbook(f.pool,f.history,report,'2026-10-23');assert.equal(repeat.appended,0);assert.deepEqual(f.unrelated,beforeUnrelated);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('ERRORS and REVIEW do not replay automatically; explicit retry preserves incoming same-name files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'insurance-no-loop-')),dir=path.join(root,'METLIFE');await fs.mkdir(dir);
 for(const type of ['ERRORS','REVIEW']){await fs.mkdir(path.join(dir,type));await fs.writeFile(path.join(dir,type,'1111111111111_claim.pdf'),'%PDF-old-'+type);}
 let calls=0;const pool={execute:async()=>[[]]};
 try{
  const r=await scanIncomingFolder(pool,dir,{processFile:async()=>{calls++;return {success:true};},exportReports:async()=>({status:'ok'})});assert.equal(r.count,0);assert.equal(calls,0);
  // A fresh incoming file is deliberately too new to scan. Explicit retry must
  // preserve it as well as both older failed sources with the same clean name.
  await fs.writeFile(path.join(dir,'claim.pdf'),'%PDF-new');const retry=await retryErrorFiles(pool,dir);assert.equal(retry.movedCount,0);assert.equal(retry.conflicts.length,2);assert.equal(await fs.readFile(path.join(dir,'claim.pdf'),'utf8'),'%PDF-new');
  assert.equal(await fs.readFile(path.join(dir,'ERRORS','1111111111111_claim.pdf'),'utf8'),'%PDF-old-ERRORS');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('1041 second-patient failure is preflighted before the first PDF, fees or payment', {skip:!fixtureDir},async()=>{
 const input=await loadCase('1041','LIBERTY Dental Plan'),root=await fs.mkdtemp(path.join(os.tmpdir(),'insurance-preflight-'));const dir=path.join(root,'LIBERTY');await fs.mkdir(dir);const source=path.join(dir,'1041.pdf');await fs.writeFile(source,input.bytes);const f=await insuranceLedger(root,input.claims);
 try{
  const target=f.procs.find(p=>p.PatNum===f.patients[1].PatNum&&p.ProcCode==='D0220');f.procs.push({...target,ProcNum:99990});
  await assert.rejects(processSinglePdf(f.pool,source,{hashSplits:f.hashes}),e=>e.code==='EOB_REVIEW_REQUIRED'&&/D0220/.test(e.message));
  assert.equal(f.payments.length,0);assert.equal(f.documents.length,0);assert.equal(f.fees.length,0);assert.equal(f.hashCalls,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('1041 resumes after a real first-patient success without replacing that patient payment or PDF', {skip:!fixtureDir},async()=>{
 const input=await loadCase('1041','LIBERTY Dental Plan'),root=await fs.mkdtemp(path.join(os.tmpdir(),'insurance-resume-'));const dir=path.join(root,'LIBERTY');await fs.mkdir(dir);const source=path.join(dir,'1041.pdf');await fs.writeFile(source,input.bytes);const f=await insuranceLedger(root,input.claims);let calls=0;
 try{
  await assert.rejects(processSinglePdf(f.pool,source,{hashSplits:async plan=>{if(++calls===2)throw Error('synthetic second patient helper failure');return f.hashes(plan);}}),/synthetic second patient/);
  assert.equal(f.payments.length,1);assert.equal(f.history.length,1);const firstPay=f.payments[0].PayNum,firstDoc=f.documents[0].DocNum;
  await processSinglePdf(f.pool,source,{hashSplits:f.hashes});assert.equal(f.payments.length,2);assert.equal(f.history.length,2);assert.equal(f.payments[0].PayNum,firstPay);assert.equal(f.documents[0].DocNum,firstDoc);assert.equal(f.documents.length,2);assert.equal(f.hashCalls,2);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
