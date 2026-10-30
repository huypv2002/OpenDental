import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseMetlifeClaims,normalizedMetlifeBatch,resolveMetlifeBatchPatient} from './multiClaim.js';
import {readInsuranceTextDocument} from './textDocument.js';
import {selectConvertedText} from './pdfToText.js';
import {processSinglePdf} from './autoProcessor.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';
import {metlifeText} from './testSupport/insuranceTextFixtures.js';
const text=metlifeText+'\f'+metlifeText.replaceAll('1234567890','1234567891').replaceAll('TEST PERSON','OTHER PATIENT');
const extract=source=>readInsuranceTextDocument(Buffer.from(source)).extracted;
test('MetLife batch splits each summary with its payment continuation and reconciles PDF conversion',()=>{
 const p=parseMetlifeClaims(extract(text),{clinicConfirmedPaid:true});
 assert.deepEqual(p.errors,[]);assert.equal(p.claims.length,2);
 assert.deepEqual(p.claims.map(c=>c.benefitCents),[8000,8000]);
 const n=normalizedMetlifeBatch(p);assert.equal(n.check.netPaymentCents,16000);
 assert.equal(selectConvertedText({candidates:[{text}],native:true},{clinicConfirmedPaid:true}),text);
 assert.ok(parseMetlifeClaims(extract(metlifeText+'\f'+metlifeText),{clinicConfirmedPaid:true}).errors.length);
 assert.throws(()=>selectConvertedText({candidates:[{text:text.replace('1234567891 99','')}],native:true},{clinicConfirmedPaid:true}));
});
for(const invalid of [false,true])test(`MetLife batch ${invalid?'preflights all claims before writes':'posts per-patient claims and replays idempotently'} (simulated DB)`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-batch-'));
 try{
  const n=normalizedMetlifeBatch(parseMetlifeClaims(extract(text),{clinicConfirmedPaid:true}));
  const f=await insuranceLedger(root,n.claims.map((c,i)=>({patNum:500+i,firstName:c.patient.firstName,lastName:c.patient.lastName,claimNumber:c.claimNumber,procedures:c.procedures,serviceDate:c.procedures[0].date})));
  if(invalid)f.patients[1].FName='MISMATCH';
  for(const ext of ['pdf','txt']){
   const file=path.join(root,`batch.${ext}`);await fs.writeFile(file,ext==='pdf'?'%PDF-synthetic':text);
   const run=()=>processSinglePdf(f.pool,file,{convertPdf:async()=>text,hashSplits:f.hashes});
   if(invalid)await assert.rejects(run(),/khớp duy nhất/);else await run();
  }
  if(invalid){assert.equal(f.payments.length,0);assert.equal(f.documents.length,0);assert.equal(f.events.some(([s])=>/^INSERT|^UPDATE/.test(s)),false);}
  else {assert.equal(f.payments.length,2);assert.equal(f.splits.length,2);assert.deepEqual(f.payments.map(p=>p.PatNum),[500,501]);assert.ok(f.splits.every(s=>s.PatNum===f.payments.find(p=>p.PayNum===s.PayNum).PatNum));}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('MetLife exact-name/group matching rejects same-name ambiguity without mutation',async()=>{
 const pool={execute:async(sql,args)=>{assert(sql.startsWith('SELECT'));assert.deepEqual(args,['12345','TEST','PERSON']);return [[{PatNum:1},{PatNum:2}]];}};
 await assert.rejects(resolveMetlifeBatchPatient(pool,{claim:{claimNumber:'123',plan:{group:'12345'},patient:{firstName:'TEST',lastName:'PERSON'}}}),/khớp duy nhất/);
});
