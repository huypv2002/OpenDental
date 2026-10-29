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

const source={code:'D0210',bundled:true,benefitCents:3920,feeCents:null,date:null};
const od={ProcNum:99,ProcCode:'D0210',ProcDate:'2025-09-19',ProcFee:'123.45',ToothNum:''};
test('Allowable D0210 preserves unique OD fee/date and original source fields',()=>{
  const [p]=resolveMetlifeAllowableProcedures([source],[od]);
  assert.equal(p.date,'2025-09-19');assert.equal(p.feeCents,12345);
  assert.equal(p.benefitCents,3920);assert.equal(p.preserveExistingFee,true);
  assert.deepEqual(p.odFallback,{procNum:99,sourceDate:null,sourceFeeCents:null,date:'2025-09-19',feeCents:12345});
  assert.equal(source.feeCents,null);assert.equal(source.date,null);
});
test('no match, multiple dates, or invalid OD fee/date stop instead of adding a procedure',()=>{
  for(const rows of [[],[od,{...od,ProcNum:100,ProcDate:'2025-09-20'}],[{...od,ProcFee:null}],[{...od,ProcFee:'-1'}],[{...od,ProcDate:'0001-01-01'}]]){
    assert.throws(()=>resolveMetlifeAllowableProcedures([source],rows),{code:'EOB_REVIEW_REQUIRED'});
  }
  assert.equal(resolveMetlifeAllowableProcedures([source],[{...od,ProcFee:'0'}])[0].feeCents,0);
});
test('complete rows and other codes retain their existing fee rules',()=>{
  const complete={...source,date:'2025-09-19',feeCents:7500};
  assert.equal(resolveMetlifeAllowableProcedures([complete],[od])[0],complete);
  const other={...source,code:'D0150'};
  assert.equal(resolveMetlifeAllowableProcedures([other],[od])[0],other);
});

test('folder replay preserves existing procedure charge/date and creates one payment (simulated DB)',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-allowable-'));
  try{
    const original=row([[10,'09/20/2026'],[28,'Approved'],[45,'( D4341 )'],[75,'UR'],[90,'$100.00'],[110,'$0.00'],[130,'$100.00'],[150,'$0.00'],[170,'$80.00']]);
    const replacement=row([[10,'Allowable'],[28,'Approved'],[45,'( D0210 )'],[75,'-'],[90,'-'],[110,'$0.00'],[130,'$100.00'],[150,'$0.00'],[170,'$80.00']]);
    const text=metlifeText.replace(original,replacement);
    const p=parseMetlife(readInsuranceTextDocument(Buffer.from(text)).extracted,{clinicConfirmedPaid:true});
    assert.deepEqual(p.errors,[]);assert.equal(p.procedures[0].feeCents,null);assert.equal(p.procedures[0].date,null);
    const ledger=await insuranceLedger(root,[{patNum:690,firstName:'TEST',lastName:'PERSON',claimNumber:p.claimRaw,procedures:p.procedures,serviceDate:'2025-09-19'}]);
    const proc=ledger.procs.find(r=>r.ProcCode==='D0210');proc.ProcFee=123.45;
    const cp=ledger.claimprocs.find(r=>r.ProcNum===proc.ProcNum);cp.FeeBilled=123.45;
    for(const ext of ['pdf','txt']){
      const file=path.join(root,`690.${ext}`);await fs.writeFile(file,ext==='pdf'?'%PDF-synthetic':text);
      await processSinglePdf(ledger.pool,file,{convertPdf:async()=>text,hashSplits:ledger.hashes});
    }
    assert.equal(ledger.payments.length,1);assert.equal(Number(ledger.payments[0].PayAmt),80);
    assert.equal(ledger.splits.length,1);assert.equal(ledger.splits[0].ProcDate,'2025-09-19');
    assert.equal(proc.ProcDate,'2025-09-19');assert.equal(proc.ProcFee,123.45);assert.equal(cp.FeeBilled,123.45);
    assert.equal(ledger.addedAudit.length,0);
    const detail=JSON.parse(ledger.history[0].Details).procedures[0];
    assert.equal(detail.feeCents,null);assert.equal(detail.date,'');assert.equal(detail.odFallback.feeCents,12345);
    assert.equal(ledger.events.some(([sql,args])=>sql.startsWith('UPDATE procedurelog SET ProcFee')&&args[1]===proc.ProcNum),false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
