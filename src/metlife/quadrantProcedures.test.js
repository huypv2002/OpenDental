import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {linesOf,parseMetlife,extractPdf} from './parser.js';
import {appendDailyWorkbook} from './dailyExcel.js';
import {planMissingProcedures} from './missingProcedures.js';
import {matchLibertyProcedures} from '../liberty/validation.js';
import {processSinglePdf} from './autoProcessor.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';

function fixture(){
 const item=(str,x,y)=>({str,x,y,width:20}),items=[];
 for(const [i,text] of ['MetLife Claim Summary','Relationship to Subscriber: Self','Group Number: G123','Claim Number: 1234567890 99','Patient Name: TEST PERSON','Subscriber Name: TEST PERSON','PROCESSED on 09/17/2026','Claim Detail'].entries())items.push(item(text,25,25+i*22));
 for(const [i,area] of ['UR','UL'].entries()){
  const y=240+i*22,amount=i?'268.80':'200.00';
  items.push(item('09/13/2026',10,y),item('D4341',110,y),item('Approved',170,y),item(area,240,y),item('$400.00',290,y),item('$'+amount,500,y));
 }
 items.push(item('Total',25,420),item('$468.80',500,420));
 const payment=[item('Payment Detail',25,35),item('Paid / Settled',10,80),item('09/17/2026',90,80),item('$468.80',170,80),item('EFT',380,80),item('123456789',460,80)];
 return {sha256:'q'.repeat(64),pages:[items,payment].map((items,i)=>({page:i+1,width:612,height:792,items,lines:linesOf(items)}))};
}

test('MetLife preserves each D4341 quadrant, rather than treating blank teeth as duplicate services',()=>{
 const p=parseMetlife(fixture());assert.deepEqual(p.errors,[]);
 assert.deepEqual(p.procedures.map(p=>[p.code,p.tooth,p.surface,p.benefitCents]),[['D4341',null,'UR',20000],['D4341',null,'UL',26880]]);
 const procs=p.procedures.map((p,i)=>({ProcNum:i+1,ProcCode:p.code,ProcDate:p.date,ToothNum:'',Surf:p.surface}));
 assert.equal(planMissingProcedures(procs,p.procedures,{metlife:true}).additions.length,0);
 assert.deepEqual([...matchLibertyProcedures(procs,{procedures:p.procedures}).values()].map(p=>p.ProcNum),[1,2]);
 const other={...p.procedures[0],surface:'LR'};
 assert.throws(()=>planMissingProcedures(procs,[other],{metlife:true}),/không tự thêm trùng/);
 assert.equal(planMissingProcedures(procs.slice(0,1),p.procedures,{metlife:true}).additions.length,1);
 assert.throws(()=>planMissingProcedures(procs,[{...other,surface:''}],{metlife:true}),/vùng hàm/);
 assert.equal(planMissingProcedures(procs.slice(0,1),[{...other,surface:''}],{metlife:true}).additions.length,0);
 assert.throws(()=>planMissingProcedures([...procs,{...procs[0],ProcNum:3}],p.procedures,{metlife:true}),/trùng/);
});

test('MetLife same-code/day quadrants receive separate fees, payment splits and history IDs; repeat reuses payment',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-quadrants-')),extracted=fixture(),parsed=parseMetlife(extracted);
 const f=await insuranceLedger(root,[{patNum:99,firstName:'TEST',lastName:'PERSON',claimNumber:parsed.claimRaw,serviceDate:'2026-09-13',procedures:parsed.procedures}]);
 const file=path.join(root,'99.pdf'),bytes=Buffer.from('%PDF-synthetic-quadrants');
 try{
  await fs.writeFile(file,bytes);await processSinglePdf(f.pool,file,{extract:async()=>extracted,hashSplits:f.hashes});
  assert.equal(f.payments.length,1);assert.equal(Number(f.payments[0].PayAmt),468.8);
  assert.deepEqual(f.splits.map(s=>[s.ProcNum,s.SplitAmt]),[[1000,'200.00'],[1001,'268.80']]);
  assert.deepEqual(f.fees,[['400.00',1000],['400.00',1001]]);
  assert.deepEqual(JSON.parse(f.history[0].Details).procedures.map(p=>[p.procNum,p.surface]),[[1000,'UR'],[1001,'UL']]);
  assert.equal(f.addedAudit.length,0);
  await fs.writeFile(file,bytes);await processSinglePdf(f.pool,file,{extract:async()=>extracted,hashSplits:f.hashes});
  assert.equal(f.payments.length,1);assert.equal(f.splits.length,2);assert.equal(f.fees.length,2);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('private MetLife quadrant PDF: six exact allocations, leading-zero tooth and complete Excel fees', {skip:!process.env.METLIFE_QUADRANT_TEST_PDF},async()=>{
 const bytes=await fs.readFile(process.env.METLIFE_QUADRANT_TEST_PDF),extracted=await extractPdf(bytes),parsed=parseMetlife(extracted);
 assert.deepEqual(parsed.errors,[]);assert.equal(parsed.benefitCents,46880);assert.equal(parsed.processed,'2026-06-17');
 assert.deepEqual(parsed.procedures.map(p=>[p.code,p.date,p.tooth,p.surface,p.feeCents,p.benefitCents]),[
  ['D4342','2026-05-14',null,'UR',10000,5680],['D4341','2026-05-14',null,'LR',15000,9360],['D2391','2026-05-14','5','',12000,6560],
  ['D4341','2026-05-19',null,'UL',15000,9360],['D4341','2026-05-19',null,'LL',15000,9360],['D2391','2026-05-19','12','',12000,6560]
 ]);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-private-quadrants-'));
 const f=await insuranceLedger(root,[{patNum:621,firstName:parsed.patient,lastName:'PERSON',claimNumber:parsed.claimRaw,serviceDate:'2026-05-14',procedures:parsed.procedures}]);
 const file=path.join(root,'621.pdf');
 try{
  await fs.writeFile(file,bytes);await processSinglePdf(f.pool,file,{hashSplits:f.hashes});
  assert.deepEqual(f.splits.map(s=>s.ProcNum),[1000,1001,1002,1003,1004,1005]);
  assert.deepEqual(f.fees,[['100.00',1000],['150.00',1001],['120.00',1002],['150.00',1003],['150.00',1004],['120.00',1005]]);
  assert.equal(f.payments.length,1);assert.equal(f.payments[0].PayDate,'2026-06-17');assert.equal(Number(f.payments[0].PayAmt),468.8);
  const report=await appendDailyWorkbook(f.pool,f.history,path.join(root,'report.xlsx'),'2026-10-23');assert.equal(report.appended,1);assert.equal(report.reviewCount,0);
  await fs.writeFile(file,bytes);await processSinglePdf(f.pool,file,{hashSplits:f.hashes});
  assert.equal(f.payments.length,1);assert.equal(f.splits.length,6);assert.equal(f.documents.length,1);assert.equal(f.fees.length,6);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
