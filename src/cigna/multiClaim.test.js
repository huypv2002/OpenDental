import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseCigna} from './parser.js';
import {resolveCignaSubscriber} from './processor.js';
import {cignaHistoryDisplay} from './claimDisplay.js';
import {readInsuranceTextDocument} from '../metlife/textDocument.js';
import {convertPdfBytesToText} from '../metlife/pdfToText.js';
import {processSinglePdf} from '../metlife/autoProcessor.js';
import {insuranceLedger} from '../metlife/testSupport/insuranceLedger.js';
import {cignaText} from '../metlife/testSupport/insuranceTextFixtures.js';

const cols=`YOUR AMOUNT ELIGIBLE
THE PLAN COVERED
AMOUNT YOU CONTRACTED FOR COVERAGE PATIENT COPAY/ REMAINING PATIENT
CHARGED ($) AMOUNT ($) BY THE PLAN ($) DEDUCTIBLE ($) BALANCE ($) COINSURANCE ($) (%) ($)`;
const head=(doc,member,claimant,processed)=>`PATIENT NAME: TEST PERSON SUBSCRIBER NAME: TEST PERSON PATIENT ID: ${member}
GROUP #: 123 DOCUMENT #: ${doc} CLAIMANT #: ${claimant} CLAIM #: 003 PAYMENT #: 001
PROCESSED DATE: Oct ${processed}, 2026
${cols}`;
const service=(code,tooth,note,amounts)=>`For service on Oct 11, 2026: ${code}* for Tooth#/Quad/Arch:${tooth} (see note ${note})\n${amounts}`;
const original=(tooth,note)=>service('D2392',tooth,note,'150.00 0.00 0.00 0.00 0.00 0.00 0% 0.00');
const alternate=(tooth,note)=>service('D2150',tooth,note,'0.00 0.00 71.00 0.00 71.00 14.20 80% 56.80');
const first=head('E900000000001','TEST-A','01','15'),second=head('E900000000002','TEST-B','02','21');
const source=`Cigna Dental\nExplanation of dental payment\nPayment amount: $140.00\n${first}
${original('30','AA')}\n${alternate('30','AB')}\n${original('31','AC')}\fDefinitions\f${first}
${alternate('31','AD')}
$300.00 $0.00 $142.00 $0.00 $142.00 $28.40 $113.60
Amount paid by the plan $113.60
Customer's responsibility $186.40
${second}
${service('D2391','05','DB','140.00 0.00 83.00 50.00 33.00 6.60 80% 26.40')}
$140.00 $0.00 $83.00 $50.00 $33.00 $6.60 $26.40
Amount paid by the plan $26.40
Customer's responsibility $113.60
Notes
AA - An alternate benefit allowance has been applied.
AB - This is the benefit allowance under the alternate benefit provision.
AC - An alternate benefit allowance has been applied.
AD - This is the benefit allowance under the alternate benefit provision.
DB - Benefits applied to deductible.`;
const parse=text=>parseCigna(readInsuranceTextDocument(Buffer.from(text)).extracted);

test('CIGNA splits multiple patients on one page, continuation rows, teeth and alternate benefits before posting',()=>{
 const p=parse(source);assert.deepEqual(p.errors,[]);assert.equal(p.check.netPaymentCents,14000);
 assert.deepEqual(p.claims.map(c=>[c.claimNumber,c.date,c.totals.planPaidCents]),[['E900000000001','2026-10-15',11360],['E900000000002','2026-10-21',2640]]);
 assert.deepEqual(p.claims[0].procedures.map(p=>[p.code,p.tooth,p.feeCents,p.benefitCents,p.alternateCode]),[['D2392','30',15000,5680,'D2150'],['D2392','31',15000,5680,'D2150']]);
 assert.deepEqual(p.claims[1].procedures.map(p=>[p.code,p.tooth,p.feeCents,p.benefitCents]),[['D2391','5',14000,2640]]);
 assert.ok(!p.claims.some(c=>c.claimNumber.includes('-01-003')));
});

test('CIGNA rejects missing alternate evidence, wrong teeth, altered totals and incomplete patient blocks',()=>{
 for(const bad of [source.replace('AA - An alternate benefit allowance has been applied.','AA - unrelated.'),source.replace('AD - This is the benefit allowance under the alternate benefit provision.','AD - unrelated.'),source.replace('D2150* for Tooth#/Quad/Arch:30','D2150* for Tooth#/Quad/Arch:29'),source.replace('$113.60\nCustomer', '$113.61\nCustomer'),source.replace('$140.00 $0.00 $83.00','$141.00 $0.00 $83.00'),source.replace(second,cols),source.replaceAll('150.00','60.00').replace('$300.00','$120.00').replace('$186.40','$6.40')])assert.ok(parse(bad).errors.length);
});

async function fixture(text){
 const parsed=parse(text);assert.deepEqual(parsed.errors,[]);const root=await fs.mkdtemp(path.join(os.tmpdir(),'cigna-multi-'));
 const f=await insuranceLedger(root,parsed.claims.map((c,i)=>({patNum:[1275,1317][i],firstName:'DIFFERENT',lastName:'NAME',memberId:i===1?c.patient.memberId+' 02':c.patient.memberId,claimNumber:c.claimNumber,procedures:c.procedures,serviceDate:c.procedures[0].date})));
 return {parsed,root,f};
}
async function posting(text,pdfBytes){
 const {parsed,root,f}=await fixture(text);
 try{
  const run=async name=>{const file=path.join(root,name+(pdfBytes?'.pdf':'.txt'));await fs.writeFile(file,pdfBytes||text);return processSinglePdf(f.pool,file,{hashSplits:f.hashes});};
  await run('1317');await run('1793296122013_1317');
  assert.equal(f.payments.length,2);assert.equal(f.documents.length,2);assert.equal(f.history.length,2);assert.equal(f.addedAudit.length,0);
  assert.deepEqual(f.payments.map(p=>[p.PatNum,Number(p.PayAmt),p.PayDate]),[[1275,113.6,'2026-10-15'],[1317,26.4,'2026-10-21']]);
  assert.deepEqual(f.splits.map(s=>[s.PatNum,s.SplitAmt]),[[1275,'56.80'],[1275,'56.80'],[1317,'26.40']]);
  assert.deepEqual(f.procs.filter(p=>p.ProcNum!==99998).map(p=>[p.ProcCode,p.ToothNum,p.ProcFee]),[['D2392','30','150.00'],['D2392','31','150.00'],['D2391','5','140.00']]);
  for(const [i,c] of parsed.claims.entries())assert.equal(f.payments[i].PayNote,`Claim number: ${c.claimNumber}`);
  const baseline={p:f.payments.length,d:f.documents.length,s:f.splits.length,fees:f.fees.length};
  // An ambiguous subscriber for the second claim blocks the whole batch.
  f.patients.push({...f.patients[1],PatNum:999});
  await assert.rejects(run('batch-review'),e=>e.code==='EOB_REVIEW_REQUIRED'&&/nhiều bệnh nhân/.test(e.message));
  assert.deepEqual({p:f.payments.length,d:f.documents.length,s:f.splits.length,fees:f.fees.length},baseline);
 }finally{await fs.rm(root,{recursive:true,force:true});}
}

test('CIGNA multi-claim TXT keeps payments scoped by subscriber and ignores the filename patient (simulated DB)',()=>posting(source));
test('CIGNA legacy portal multi-claim TXT also resolves patients by the supplied Subscriber IDs',async()=>{
 const text=cignaText+'\nSubscriber ID: TEST-A\f'+cignaText.replaceAll('E262868007800','E262868007801')+'\nSubscriber ID: TEST-B';
 const {parsed,root,f}=await fixture(text);
 try{
  f.patients[1].memberId='TEST-B'; // Portal has no claimant/dependent suffix.
  const file=path.join(root,'batch.txt');await fs.writeFile(file,text);await processSinglePdf(f.pool,file,{hashSplits:f.hashes});
  assert.equal(parsed.claims.length,2);assert.deepEqual(f.payments.map(p=>[p.PatNum,Number(p.PayAmt)]),[[1275,56.8],[1317,56.8]]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('CIGNA second patient missing/ambiguous stops before the first document, fee or payment',async()=>{
 for(const mode of ['missing','ambiguous']){
  const {root,f}=await fixture(source);try{
   if(mode==='missing')f.patients[1].memberId='OTHER';else f.patients.push({...f.patients[1],PatNum:999});
   const file=path.join(root,'1317.txt');await fs.writeFile(file,source);
   await assert.rejects(processSinglePdf(f.pool,file,{hashSplits:f.hashes}),e=>e.code==='EOB_REVIEW_REQUIRED');
   assert.equal(f.payments.length,0);assert.equal(f.documents.length,0);assert.equal(f.addedAudit.length,0);assert.equal(f.fees.length,0);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});

test('CIGNA Subscriber ID lookup resolves dependent suffixes with SQL and never uses names or filename numbers',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE patient(PatNum INTEGER,FName TEXT,LName TEXT,Birthdate TEXT,ClinicNum INTEGER,PriProv INTEGER,ImageFolder TEXT,ChartNumber TEXT);CREATE TABLE patplan(PatNum INTEGER,InsSubNum INTEGER);CREATE TABLE inssub(InsSubNum INTEGER,SubscriberID TEXT);
 INSERT INTO patient VALUES(1,'WRONG','NAME','1970-01-01',0,1,'a',''),(2,'OTHER','NAME','1970-01-01',0,1,'b','');INSERT INTO patplan VALUES(1,1),(2,2);INSERT INTO inssub VALUES(1,'TEST-B 01'),(2,'TEST-B 02');`);
 const pool={execute:async(sql,args)=>{assert.match(sql,/^SELECT/);assert.ok(!sql.includes('FName='));return [db.prepare(sql).all(...args)];}};
 try{
  const c={claimNumber:'E900000000002',patient:{memberId:'TEST-B'},claimantNumber:'02'};
  assert.equal((await resolveCignaSubscriber(pool,c)).PatNum,2);
  assert.equal((await resolveCignaSubscriber(pool,{...c,patient:{memberId:'TEST-B*02'}})).PatNum,2);
  await assert.rejects(resolveCignaSubscriber(pool,{...c,claimantNumber:''}),e=>e.code==='EOB_REVIEW_REQUIRED');
  db.exec("INSERT INTO patient VALUES(3,'THIRD','PERSON','1970-01-01',0,1,'c','');INSERT INTO patplan VALUES(3,3);INSERT INTO inssub VALUES(3,'TEST-B-02');");
  await assert.rejects(resolveCignaSubscriber(pool,c),/nhiều bệnh nhân/);
 }finally{db.close();}
});

test('CIGNA old compound history displays only the document in claim, note and document description',()=>{
 for(const prefix of ['D','E']){
  const id=prefix+'123456789000',row={ClaimNumber:id+'-01-002',Details:JSON.stringify({carrier:'CIGNA',claimNumber:id+'-01-002',paymentNote:`Claim number: ${id}-01-002`,documentDescription:`Claim ${id}-01-002  393.00`})};
  const display=cignaHistoryDisplay(row),d=JSON.parse(display.Details);
  assert.equal(display.ClaimNumber,id);assert.equal(d.claimNumber,id);assert.equal(d.paymentNote,`Claim number: ${id}`);assert.equal(d.documentDescription,`Claim ${id}  393.00`);
  assert.equal(row.ClaimNumber,id+'-01-002');
 }
});

test('private CIGNA 1317 PDF: actual Scribe conversion, multiple patients, correct original procedure fees and replay',{skip:!process.env.CIGNA_MULTI_TEST_PDF,timeout:130000},async()=>{
 const bytes=await fs.readFile(process.env.CIGNA_MULTI_TEST_PDF),text=await convertPdfBytesToText(bytes);await posting(text,bytes);
});
