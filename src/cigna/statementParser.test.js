import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseCigna} from './parser.js';
import {readInsuranceTextDocument} from '../metlife/textDocument.js';
import {processSinglePdf} from '../metlife/autoProcessor.js';
import {insuranceLedger} from '../metlife/testSupport/insuranceLedger.js';
import {convertPdfBytesToText} from '../metlife/pdfToText.js';
import {cignaText} from '../metlife/testSupport/insuranceTextFixtures.js';

const header=`PATIENT NAME: TEST PERSON SUBSCRIBER NAME: TEST PERSON PATIENT'S RELATIONSHIP TO SUBSCRIBER: SUBSCRIBER PATIENT ID: TEST-ID*01
GROUP NAME: TEST GROUP GROUP #: 123 DOCUMENT #: D123456789000 CLAIMANT #: 01 CLAIM #: 002 PAYMENT #: 001
RECEIVED DATE: Oct 20, 2026 PROCESSED DATE: Oct 22, 2026
YOUR AMOUNT ELIGIBLE
THE PLAN COVERED
AMOUNT YOU CONTRACTED FOR COVERAGE PATIENT COPAY/ REMAINING PATIENT
CHARGED ($) AMOUNT ($) BY THE PLAN ($) DEDUCTIBLE ($) BALANCE ($) COINSURANCE ($) (%) ($)`;
const rows=[['D0120','80.00'],['D0220','25.00'],['D0230','38.00'],['D0274','80.00'],['D1110','120.00'],['D1208','50.00']];
const services=items=>items.map(([code,amount])=>`For service on Oct 20, 2026: ${code}*\n${amount} 0.00 ${amount} 0.00 ${amount} 0.00 100% ${amount}`).join('\n');
const source=`Cigna Dental\nExplanation of dental payment\nPayment amount: $393.00\nPayment date: OCT 28, 2026\n${header}\n${services(rows.slice(0,3))}\nContinued\fDefinitions and appeal instructions\fClaim details - continued\n${header}\n${services(rows.slice(3))}\n$393.00 $0.00 $393.00 $0.00 $393.00 $0.00 $393.00\nAmount paid by the plan $393.00\nCustomer's responsibility $0.00\f`;
const parse=text=>parseCigna(readInsuranceTextDocument(Buffer.from(text)).extracted);

test('CIGNA supports both portal and payment-statement templates without mixing them',()=>{
 const old=parse(cignaText),p=parse(source);assert.deepEqual(old.errors,[]);assert.deepEqual(p.errors,[]);
 assert.equal(old.claims[0].claimNumber,'E262868007800');assert.equal(old.check.netPaymentCents,5680);
 assert.equal(p.sourceTemplate,'payment-statement');assert.equal(p.claims.length,1);
 const c=p.claims[0];assert.equal(c.claimNumber,'D123456789000');assert.equal(c.sourceClaimNumber,'002');
 assert.equal(c.paymentPayload.claimNum,'D123456789000');assert.equal(c.paymentPayload.payNote,'Claim number: D123456789000');
 assert.equal(c.date,'2026-10-22');assert.equal(c.paymentPayload.payDate,'2026-10-22'); // Not deposit date Oct 28.
 assert.equal(c.totals.planPaidCents,39300);assert.equal(c.paymentPayload.checkNum,'');
 assert.deepEqual(c.procedures.map(p=>[p.code,p.feeCents,p.benefitCents]),rows.map(([code,amount])=>[code,Math.round(Number(amount)*100),Math.round(Number(amount)*100)]));
 assert.ok(parse(source+'\f'+cignaText).errors.length);
});

test('CIGNA statement missing pages, swapped columns, bad rows, dates, amounts and duplicates stop before any database access',async()=>{
 const invalid=[source.replace(services(rows.slice(0,3)),''),source.replace('$393.00 $0.00','$394.00 $0.00'),source.replace('100% 80.00','80% 80.00'),source.replace('80.00 0.00 80.00 0.00 80.00 0.00 100% 80.00','80.00 0.00 80.00 0.00 80.00 100% 80.00'),source.replaceAll('Oct 20, 2026:','Oct 32, 2026:'),source.replaceAll('CHARGED ($) AMOUNT ($)','AMOUNT ($) CHARGED ($)'),source.replaceAll('DOCUMENT #: D123456789000','DOCUMENT #: '),source.replace('PROCESSED DATE: Oct 22, 2026','PROCESSED DATE: Oct 23, 2026'),source.replace(services(rows.slice(0,3)),services(rows.slice(0,3))+'\n'+services(rows.slice(0,1))),source.replace('Payment amount: $393.00','Payment amount: $400.00'),source.replace("Customer's responsibility $0.00","Customer's responsibility $1.00")];
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'statement-review-'));
 try{for(const text of invalid){
  let queries=0;const file=path.join(root,'140.txt');await fs.writeFile(file,text);
  await assert.rejects(processSinglePdf({execute:async()=>{queries++;throw Error('must not query');}},file));
  assert.equal(queries,0);
 }}finally{await fs.rm(root,{recursive:true,force:true});}
});

async function posting(text,{pdfBytes}={}){
 const p=parse(text);assert.deepEqual(p.errors,[]);const c=p.claims[0],root=await fs.mkdtemp(path.join(os.tmpdir(),'statement-post-'));
 try{
  const f=await insuranceLedger(root,[{patNum:140,firstName:'DIFFERENT',lastName:'NAME',claimNumber:c.claimNumber,procedures:c.procedures,serviceDate:'2026-10-20'}]);
  for(const [i,name] of ['140','1793288482937_140','1793288482938_140'].entries()){
   const file=path.join(root,name+(pdfBytes?'.pdf':'.txt'));await fs.writeFile(file,pdfBytes||text);
   // Actual private PDF takes the production Scribe conversion path.
   await processSinglePdf(f.pool,file,{hashSplits:f.hashes});
   assert.equal(f.payments[0].PayNote,`Claim number: ${c.documentNumber}`);
   // Model an older saved compound note, then an OD-cleared ExternalId with
   // the new short note. Both must resolve to the same existing payment.
   f.payments[0].ExternalId='';
   if(i===0){
    const legacy=c.legacyClaimNumbers[0];f.payments[0].PayNote=`Claim number: ${legacy}`;f.payments[0].ExternalId=legacy;
    f.documents[0].Description=f.documents[0].Description.replace(c.claimNumber,legacy);
    const d=JSON.parse(f.history[0].Details);d.claimNumber=legacy;d.paymentNote=`Claim number: ${legacy}`;delete d.displayClaimNumber;
    f.history[0].ClaimNumber=legacy;f.history[0].Details=JSON.stringify(d);
   }
  }
  assert.equal(f.payments.length,1);assert.equal(f.payments[0].PatNum,140);assert.equal(f.payments[0].PayDate,'2026-10-22');
  assert.equal(Number(f.payments[0].PayAmt),393);assert.equal(f.splits.length,6);assert.equal(f.documents.length,1);assert.equal(f.history.length,1);assert.equal(f.addedAudit.length,0);
  assert.equal(f.splits.reduce((s,p)=>s+Number(p.SplitAmt),0),393);
  assert.equal(f.history[0].ClaimNumber,c.claimNumber);assert.ok(!f.documents[0].Description.includes('-01-002'));
  const saved=JSON.parse(f.history[0].Details);assert.equal(saved.displayClaimNumber,c.documentNumber);assert.equal(saved.paymentNote,`Claim number: ${c.documentNumber}`);
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('CIGNA statement posts all six services across continuation pages and replays without duplicates (simulated DB)',()=>posting(source));
test('private CIGNA 140 PDF converts with Scribe and processes/replays in simulated DB',{skip:!process.env.CIGNA_STATEMENT_TEST_PDF,timeout:130000},async()=>{
 const bytes=await fs.readFile(process.env.CIGNA_STATEMENT_TEST_PDF),text=await convertPdfBytesToText(bytes);
 await posting(text,{pdfBytes:bytes});
});
