import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {procedureFeeCents} from './procedureFee.js';
import {metlifeText,libertyText,cignaText,delta} from './testSupport/insuranceTextFixtures.js';
import {readInsuranceTextDocument} from './textDocument.js';
import {parseMetlife} from './parser.js';
import {parseLiberty} from '../liberty/parser.js';
import {parseCigna} from '../cigna/parser.js';
import {parseDelta} from '../delta/parser.js';
import {processSinglePdf} from './autoProcessor.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';
import {planMissingProcedures} from './missingProcedures.js';

const cases=[
 ['MetLife',metlifeText.replaceAll('$100.00','$950.00').replaceAll('$80.00','$475.00'),parseMetlife,[95000],[47500]],
 ['LIBERTY Dental Plan',libertyText.replaceAll('950.00 743.00','1000.00 900.00'),parseLiberty,[90000],[74300]],
 ['CIGNA',cignaText,parseCigna,[15000],[5680]],
 ['DELTA DENTAL',delta.replaceAll('$170.00 $170.00 $170.00','$200.00 $170.00 $170.00').replace('$340.00 $340.00 $340.00','$400.00 $340.00 $340.00'),parseDelta,[17000,17000],[9600,13600]]
];

for(const [carrier,text,parse,fees,paid] of cases){
 for(const missing of [false,true])test(`${carrier}: ${missing?'new':'existing'} procedure uses the carrier fee column; replay repairs old benefit-as-fee without another payment`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fee-column-'));
  try{
   const parsed=parse(readInsuranceTextDocument(Buffer.from(text)).extracted);assert.deepEqual(parsed.errors,[]);
   const c=parsed.claims?.[0],procedures=parsed.procedures||c.procedures;
   const f=await insuranceLedger(root,[{patNum:1004,firstName:c?.patient.firstName||'TEST',lastName:c?.patient.lastName||'PERSON',memberId:c?.patient.memberId,claimNumber:c?.claimNumber||parsed.claimRaw,procedures,serviceDate:procedures[0].date}]);
   const unrelated={...f.unrelated};
   assert.deepEqual(procedures.map(p=>procedureFeeCents(p,carrier)),fees);
   if(missing)f.procs.splice(0,procedures.length);
   else for(const p of f.procs.filter(p=>p.ProcNum!==99998))p.ProcFee=0;
   const file=path.join(root,'1004.txt');
   const run=async()=>{await fs.writeFile(file,text);return processSinglePdf(f.pool,file,{hashSplits:f.hashes});};
   await run();
   const payment=f.payments[0],splitIds=f.splits.map(s=>s.ProcNum),rows=splitIds.map(id=>f.procs.find(p=>p.ProcNum===id));
   const cents=v=>Math.round(Number(v)*100);
   assert.deepEqual(rows.map(p=>cents(p.ProcFee)),fees);
   const billed=()=>rows.map(p=>f.claimprocs.find(cp=>cp.ProcNum===p.ProcNum)).filter(Boolean).map(cp=>cents(cp.FeeBilled));
   if(!missing)assert.deepEqual(billed(),fees);
   assert.deepEqual(f.splits.map(s=>cents(s.SplitAmt)),paid);
   assert.equal(cents(payment.PayAmt),paid.reduce((a,b)=>a+b,0));
   assert.equal(f.addedAudit.length,missing?procedures.length:0);
   if(missing)assert.deepEqual(f.addedAudit.map(a=>JSON.parse(a[5]).amountCents),fees);
   // Reproduce fees written by the old implementation, keeping the exact payment.
   rows.forEach((p,i)=>p.ProcFee=(paid[i]/100).toFixed(2));
   f.claimprocs.filter(cp=>rows.some(p=>p.ProcNum===cp.ProcNum)).forEach(cp=>cp.FeeBilled=1);
   payment.ExternalId='';
   await run();
   assert.deepEqual(rows.map(p=>cents(p.ProcFee)),fees);
   if(!missing)assert.deepEqual(billed(),fees);
   assert.equal(f.payments.length,1);assert.equal(f.payments[0].PayNum,payment.PayNum);
   assert.deepEqual(f.splits.map(s=>cents(s.SplitAmt)),paid);
   assert.equal(f.documents.length,1);assert.equal(f.history.length,1);
   assert.deepEqual(f.unrelated,unrelated);
   assert.deepEqual(JSON.parse(f.history[0].Details).feeCorrection.updatedFees.length,fees.length);
   const edits=f.fees.length;await run();assert.equal(f.fees.length,edits);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 });
}

test('fee selection never substitutes the benefit when a required source column is absent',()=>{
 for(const carrier of ['MetLife','CIGNA','LIBERTY Dental Plan','DELTA DENTAL']){
  const p={code:'D5225',date:'2026-05-22',benefitCents:47500};
  assert.throws(()=>procedureFeeCents(p,carrier),e=>e.code==='EOB_REVIEW_REQUIRED');
  assert.throws(()=>planMissingProcedures([{ProcNum:1,ProcCode:p.code,ProcDate:p.date}], [p],{carrier}),e=>e.code==='EOB_REVIEW_REQUIRED');
 }
});
