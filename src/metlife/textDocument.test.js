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
import {row,metlifeText,libertyText,cignaText} from './testSupport/insuranceTextFixtures.js';
const parse=(carrier,e)=>carrier==='METLIFE'?parseMetlife(e):carrier==='CIGNA'?parseCigna(e):validateLibertyForPosting(parseLiberty(e),e);
const samples=[['METLIFE',metlifeText,8000],['LIBERTY',libertyText,74300],['CIGNA',cignaText,5680]];

test('MetLife TXT carries a trailing Payment Detail title onto the next page without changing payment columns',()=>{
 const base=parseMetlife(readInsuranceTextDocument(Buffer.from(metlifeText)).extracted);
 const split=metlifeText.replace('\f\nPayment Detail','Payment Detail\f');
 const result=parseMetlife(readInsuranceTextDocument(Buffer.from(split)).extracted);
 assert.deepEqual(result.errors,[]);assert.equal(result.processed,base.processed);
 assert.equal(result.benefitCents,base.benefitCents);assert.deepEqual(result.payment,base.payment);
 assert.equal(result.procedures.length,base.procedures.length);
});

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
