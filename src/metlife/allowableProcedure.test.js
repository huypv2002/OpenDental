import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveMetlifeAllowableProcedures} from './allowableProcedure.js';
import {parseMetlife} from './parser.js';
import {readInsuranceTextDocument} from './textDocument.js';
import {processSinglePdf} from './autoProcessor.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';
import {metlifeText,row} from './testSupport/insuranceTextFixtures.js';

const source={code:'D0210',bundled:true,benefitCents:3920,feeCents:null,coveredCents:7400,date:null};
const grouped={code:'D0220',date:'2025-09-19',status:'Denied',benefitCents:0,evidence:'Denied 65, J'};
test('D0210 uses grouped X-ray date and EOB Covered Expense without modifying source',()=>{
  const [p]=resolveMetlifeAllowableProcedures([source,grouped]);
  assert.equal(p.date,'2025-09-19');assert.equal(p.feeCents,7400);assert.equal(p.benefitCents,3920);
  assert.equal(p.bundleResolution.dateSource,'grouped-eob-services');
  assert.equal(p.bundleResolution.feeSource,'covered-expense');
  assert.equal(source.feeCents,null);assert.equal(source.date,null);
});
test('explicit Fee Charged, including zero, precedes Covered Expense; absent values use $150',()=>{
  for(const [overrides,expected,feeSource] of [
    [{feeCents:9000},9000,'fee-charged'],[{feeCents:0},0,'fee-charged'],
    [{coveredCents:0},0,'covered-expense'],[{coveredCents:null},15000,'clinic-default']
  ]){
    const [p]=resolveMetlifeAllowableProcedures([{...source,...overrides},grouped]);
    assert.equal(p.feeCents,expected);assert.equal(p.bundleResolution.feeSource,feeSource);
  }
});
test('only relevant grouped X-rays supply dates; missing or ambiguous dates still stop',()=>{
  for(const rows of [[],[{...grouped,code:'D0150'}],[{...grouped,code:'D0120'}],[{...grouped,evidence:'Denied M'}],
    [grouped,{...grouped,date:'2025-09-20'}],[{...grouped,date:null}],[{...grouped,date:'0001-01-01'}]]){
    assert.throws(()=>resolveMetlifeAllowableProcedures([source,...rows]),{code:'EOB_REVIEW_REQUIRED'});
  }
  const [p]=resolveMetlifeAllowableProcedures([source,grouped,{...grouped,code:'D0274',date:grouped.date}]);
  assert.equal(p.date,grouped.date);
});
test('explicit D0210 date is retained; other codes and non-bundled rows remain unchanged',()=>{
  assert.equal(resolveMetlifeAllowableProcedures([{...source,date:'2025-09-18'}])[0].date,'2025-09-18');
  for(const p of [{...source,code:'D0150'},{...source,bundled:false}])assert.equal(resolveMetlifeAllowableProcedures([p])[0],p);
  for(const value of [-1,NaN,1.2])assert.throws(()=>resolveMetlifeAllowableProcedures([{...source,coveredCents:value},grouped]),{code:'EOB_REVIEW_REQUIRED'});
});

export function allowableFixtureText(){
  const original=row([[10,'09/20/2026'],[28,'Approved'],[45,'( D4341 )'],[75,'UR'],[90,'$100.00'],[110,'$0.00'],[130,'$100.00'],[150,'$0.00'],[170,'$80.00']]);
  const replacement=row([[10,'Allowable'],[28,'Approved'],[45,'( D0210 )'],[75,'-'],[90,'-'],[110,'$0.00'],[130,'$100.00'],[150,'$0.00'],[170,'$80.00']]);
  const xray=row([[10,'09/20/2026'],[28,'Denied'],[45,'( D0220 )'],[75,'8'],[90,'$10.00'],[110,'$0.00'],[130,'$0.00'],[150,'$0.00'],[170,'$0.00'],[190,'65, J']]);
  return metlifeText.replace(original,xray+'\n'+replacement);
}

for(const initiallyMissing of [false,true])test(`D0210 ${initiallyMissing?'creation':'reuse'} and PDF/TXT replay follow confirmed EOB fee/date (simulated DB)`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-allowable-'));
  try{
    const text=allowableFixtureText();
    const p=parseMetlife(readInsuranceTextDocument(Buffer.from(text)).extracted,{clinicConfirmedPaid:true});
    assert.deepEqual(p.errors,[]);
    const ledger=await insuranceLedger(root,[{patNum:690,firstName:'TEST',lastName:'PERSON',claimNumber:p.claimRaw,procedures:p.procedures,serviceDate:'2026-09-20'}]);
    const proc=ledger.procs.find(r=>r.ProcCode==='D0210');proc.ProcFee=123.45;
    if(initiallyMissing){ledger.procs.splice(ledger.procs.indexOf(proc),1);ledger.claimprocs.splice(ledger.claimprocs.findIndex(r=>r.ProcNum===proc.ProcNum),1);}
    const d0120={...proc,ProcNum:30000,ProcCode:'D0120',ProcFee:74};ledger.procs.push(d0120);
    for(const ext of ['pdf','txt']){
      const file=path.join(root,`690.${ext}`);await fs.writeFile(file,ext==='pdf'?'%PDF-synthetic':text);
      await processSinglePdf(ledger.pool,file,{convertPdf:async()=>text,hashSplits:ledger.hashes});
    }
    const saved=ledger.procs.filter(r=>r.ProcCode==='D0210');
    assert.equal(saved.length,1);assert.equal(Number(saved[0].ProcFee),100);assert.equal(saved[0].ProcDate,'2026-09-20');
    assert.equal(d0120.ProcFee,74);assert.equal(ledger.payments.length,1);assert.equal(Number(ledger.payments[0].PayAmt),80);
    assert.equal(ledger.splits.length,1);assert.equal(ledger.splits[0].ProcDate,'2026-09-20');
    assert.equal(ledger.addedAudit.length,initiallyMissing?1:0);
    const detail=JSON.parse(ledger.history[0].Details).procedures.find(r=>r.code==='D0210');
    assert.equal(detail.feeCents,null);assert.equal(detail.bundleResolution.feeCents,10000);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('legacy base-claim payment stops processing before any document, fee or service writes',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-legacy-'));
  try{
    const text=allowableFixtureText(),p=parseMetlife(readInsuranceTextDocument(Buffer.from(text)).extracted,{clinicConfirmedPaid:true});
    const ledger=await insuranceLedger(root,[{patNum:690,firstName:'TEST',lastName:'PERSON',claimNumber:p.claimRaw,procedures:p.procedures,serviceDate:'2026-09-20'}]);
    ledger.payments.push({PayNum:555,PatNum:690,PayDate:'2025-10-15',PayAmt:80,PayNote:'Insurance paid $80.00\nClaims #1234567890',ExternalId:'',CheckNum:''});
    const file=path.join(root,'690.txt');await fs.writeFile(file,text);
    await assert.rejects(processSinglePdf(ledger.pool,file),/PayNum: 555/);
    assert.equal(ledger.addedAudit.length,0);assert.equal(ledger.documents.length,0);assert.equal(ledger.payments.length,1);
    assert.equal(ledger.events.some(([sql])=>/^UPDATE|^INSERT/.test(sql)),false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
