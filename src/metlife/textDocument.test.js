import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readInsuranceTextDocument} from './textDocument.js';
import {parseMetlife,extractPdf} from './parser.js';
import {parseLiberty} from '../liberty/parser.js';
import {parseCigna} from '../cigna/parser.js';
import {validateLibertyForPosting} from '../liberty/validation.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';
import {processSinglePdf} from './autoProcessor.js';
import {appendDailyWorkbook} from './dailyExcel.js';
import ExcelJS from 'exceljs';
const row=parts=>{let s='';for(const [x,value] of parts)s=s.padEnd(Math.max(x,s.length+1),' ')+value;return s;};
const mHeader=[['(Code)',45],['Tooth',75],['Charged',90],['Negotiated',110],['Expense',130],['Applied',150],['Plan',170]];
const cHeader=[['Tooth',40],['Charged',60],['Allowed',80],['Applied',100],['Balance',120],['Contracted',140],['Coinsurance',160]];
const makeHeader=p=>row(p.map(([label,x])=>[x,label]));
const mMoney=['$100.00','$0.00','$100.00','$0.00','$80.00'];
export const metlifeText=[
 'Claim Summary','Claim Number: 1234567890 99','Patient Name: TEST PERSON','Relationship to Subscriber: Self','Subscriber Name: TEST PERSON','Group Number: 12345','PROCESSED on 09/29/2026','Date Received: 09/22/2026','Claim Detail',makeHeader(mHeader),
 row([[10,'09/20/2026'],[28,'Approved'],[45,'( D4341 )'],[75,'UR'],...mMoney.map((s,i)=>[90+20*i,s])]),
 row([[10,'Total'],...mMoney.map((s,i)=>[90+20*i,s])]),
 '\f','Payment Detail',row([[10,'Status'],[30,'Date'],[50,'Paid'],[130,'Method'],[155,'ID']]),
 row([[10,'Paid /'],[30,'09/24/2026'],[50,'$80.00'],[130,'EFT'],[155,'123456789']]),'          Settled','Notes to Claimant','D4341 appears here only in a note.'
].join('\n');
export const libertyText=`LIBERTY Dental Plan
PAYMENT DETAILS
VENDOR NAME: EXAMPLE
VENDOR NUMBER: 12345
Check Number: 109119
Check Date: 10/02/2026
Patient: PERSON, TEST - MEMBER01
Plan: EXAMPLE Group: GROUP01
CLAIM: 77361505 (Original)
1 09/17/26 D5110 Q01 Complete denture, maxillary 950.00 743.00 0.00 0.00 0.00 0.00 743.00
CLAIM TOTALS: 950.00 743.00 0.00 0.00 0.00 0.00 743.00
NET PAYMENT FOR PATIENT: 743.00
NET PAYMENT: 743.00`;
export const cignaText=[
 'Claim/Reference Number: E262868007800','Patient Name: TEST PERSON | View Coverage','Date Processed: 10/15/2026','Claim Amount Paid: $56.80','Claim Status: PROCESSED',makeHeader(cHeader),
 row([[3,'10/11/2026-'],[25,'D2392 -'],[40,'03'],[60,'$150.00'],[80,'$79.00'],[100,'$0.00'],[120,'$71.00'],[140,'$0.00'],[160,'80%=']]),
 row([[3,'10/11/2026'],[25,'Filling, 2'],[160,'$56.80']]),
 row([[3,'Totals'],[60,'$150.00'],[80,'$79.00'],[100,'$0.00'],[120,'$71.00'],[140,'$0.00'],[160,'$56.80']])
].join('\n');
const parse=(carrier,e)=>carrier==='METLIFE'?parseMetlife(e):carrier==='CIGNA'?parseCigna(e):validateLibertyForPosting(parseLiberty(e),e);
const samples=[['METLIFE',metlifeText,8000],['LIBERTY',libertyText,74300],['CIGNA',cignaText,5680]];

test('all new TXT carriers reuse PDF parsers and preserve benefit, date and anatomy',()=>{
 for(const [carrier,text,amount] of samples){
  const d=readInsuranceTextDocument(Buffer.from('\ufeff'+text.replaceAll('\n','\r\n'))),p=parse(carrier,d.extracted);
  assert.equal(d.extracted.textCarrier,carrier);assert.equal(d.extracted.ocr,false);assert.deepEqual(p.errors,[]);
  assert.equal(p.benefitCents??p.check.netPaymentCents,amount);
  if(carrier==='METLIFE'){assert.equal(p.processed,'2026-09-29');assert.equal(p.procedures.length,1);assert.equal(p.procedures[0].surface,'UR');assert.equal(p.procedures[0].feeCents,10000);}
  if(carrier==='LIBERTY')assert.equal(p.claims[0].procedures[0].tooth,'Q01');
  if(carrier==='CIGNA')assert.equal(p.claims[0].procedures[0].tooth,'3');
 }
});

test('TXT carriers reject missing cells, lost column layout, conflicting identity and changed totals',async()=>{
 const corrupt=[
  metlifeText.replace('Charged','CHANGED'),metlifeText.replace('Method','CHANGED'),
  metlifeText.replaceAll(/ {2,}/g,' '),cignaText.replaceAll(/ {2,}/g,' '),
  metlifeText.replace('$80.00','$81.00'),cignaText.replace('$56.80','$56.81'),
  libertyText.replace('950.00 743.00 0.00','950.00 744.00 0.00'),
  cignaText.replace('$150.00',''),libertyText.replace('1 09/17/26 D5110','1 09/17/26 BROKEN'),
  metlifeText+'\n'+cignaText,'unrelated invoice'
 ];
 for(const text of corrupt){
  let calls=0;const root=await fs.mkdtemp(path.join(os.tmpdir(),'bad-txt-'));
  try{const file=path.join(root,'123.txt');await fs.writeFile(file,text);
   await assert.rejects(processSinglePdf({execute:async()=>{calls++;throw Error('Unexpected DB query');}},file),e=>!e.message.includes('Unexpected DB query'));
   assert.equal(calls,0);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});

for(const [carrier,text,amount] of samples)test(`${carrier} TXT full processing reuses payment after rename and retains TXT bytes (simulated DB)`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'carrier-txt-'));
 try{
  const extracted=readInsuranceTextDocument(Buffer.from(text)).extracted,p=parse(carrier,extracted),claim=p.claims?.[0];
  const procs=p.procedures||claim.procedures,claimNumber=p.claimRaw||claim.claimNumber;
  const f=await insuranceLedger(root,[{patNum:123,firstName:'TEST',lastName:'PERSON',memberId:claim?.patient.memberId,claimNumber,procedures:procs,serviceDate:procs[0].date}]);
  // Deliberately put TXT under an unrelated folder: recognized content decides its carrier.
  const dir=path.join(root,'OTHER');await fs.mkdir(dir);
  for(const fileName of ['123.txt','1793111377468_123.txt','123.pdf']){
   const file=path.join(dir,fileName);await fs.writeFile(file,fileName.endsWith('.pdf')?'%PDF-test-only':text);
   await processSinglePdf(f.pool,file,{hashSplits:f.hashes,extract:()=>{if(!fileName.endsWith('.pdf'))throw Error('TXT cannot call PDF extraction');const e=structuredClone(extracted);delete e.textCarrier;delete e.sourceFormat;return e;}});
  }
  assert.equal(f.payments.length,1);assert.equal(f.splits.length,1);assert.equal(f.documents.length,2);assert.equal(f.addedAudit.length,0);
  assert.equal(Number(f.payments[0].PayAmt)*100,amount);
  const report=path.join(root,'EXCEL','2026-10-27.xlsx');
  const exportPool={execute:async(sql,args)=>sql.includes('FROM procedurelog pl JOIN procedurecode pc')?[f.procs.filter(p=>p.PatNum===args[0])]:f.pool.execute(sql,args)};
  await appendDailyWorkbook(exportPool,f.history,report,'2026-10-27');
  await appendDailyWorkbook(exportPool,f.history,report,'2026-10-27');
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(report);
  assert.equal(wb.getWorksheet('PAYMENTS').getCell('H2').value,amount/100);
  assert.equal(wb.getWorksheet('PAYMENTS').rowCount,2);
  const files=await fs.readdir(path.join(root,'images','T','Test0'));assert.ok(files.some(f=>f.endsWith('.txt')));
  assert.deepEqual(await fs.readFile(path.join(root,'images','T','Test0',files.find(f=>f.endsWith('.txt')))),Buffer.from(text));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

// Test-only layout export to compare the same private PDF's structured result
// with plain-text input. Production never performs this conversion.
const toLayout=e=>e.pages.map(p=>p.lines.map(l=>row(l.items.map(i=>[Math.round(i.x/3),i.str]))).join('\n')).join('\f');
const shape=p=>p.claims?p.claims.map(c=>[c.claimNumber,c.date,c.paymentPayload.amountCents,c.paymentPayload.splits.map(s=>[s.code,s.tooth??'',s.date,s.amountCents])]):[p.claimRaw,p.processed,p.benefitCents,p.procedures.map(s=>[s.code,s.date,s.tooth,s.surface,s.feeCents,s.benefitCents])];
for(const [carrier,name] of [['METLIFE','1307.pdf'],['LIBERTY','1041.pdf'],['CIGNA','1275.pdf'],['METLIFE','1792775940841_621.pdf'],['METLIFE','584.pdf']])test(`${carrier} private ${name} TXT/PDF parser equivalence`,{skip:!process.env.INSURANCE_TXT_PDF_DIR},async()=>{
 const e=await extractPdf(await fs.readFile(path.join(process.env.INSURANCE_TXT_PDF_DIR,name))),pdf=parse(carrier,e);
 for(const text of [toLayout(e),toLayout(e).replaceAll('\f','\n'),toLayout(e).split('\n').map(l=>'    '+l).join('\n')]){
  const txt=parse(carrier,readInsuranceTextDocument(Buffer.from(text)).extracted);
  assert.deepEqual(txt.errors,[]);assert.deepEqual(shape(txt),shape(pdf));
 }
});
