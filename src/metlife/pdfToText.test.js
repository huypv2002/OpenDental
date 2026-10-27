import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPdfAsText,convertPdfBytesToText,selectConvertedText} from './pdfToText.js';
import {scribePagesToText} from './pdfToTextLayout.js';
import {readInsuranceTextDocument} from './textDocument.js';
import {parseMetlife} from './parser.js';
import {parseLiberty} from '../liberty/parser.js';
import {parseCigna} from '../cigna/parser.js';
import {parseDelta} from '../delta/parser.js';
import {processSinglePdf,scanIncomingFolder} from './autoProcessor.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';
const delta=`DELTA DENTAL Provider Tools | Fee for service
Claim 20262965110923
TEST PERSON
Patient date of birth Relationship to policy holder/subscriber
06/06/1981 Dependent
Policy holder/subscriber name Subscriber ID Employer or group name
OTHER PERSON 115084523301 GROUP
Payment status
Outstanding Paid to
Amount Payment status updated Payee address
$542.40 10/28/2026
Date payment sent
10/28/2026
10/22/2026 D2393 04 D.M.O $170.00 $170.00 $170.00 $50.00 80% $96.00 $74.00
10/22/2026 D2393 19 L.M.O $170.00 $170.00 $170.00 $0.00 80% $136.00 $34.00
Claim total
$340.00 $340.00 $340.00 $50.00 - $232.00 $108.00`;

test('PDF-to-TXT keeps source hash and PDF bytes, persists text outside the scanner input',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pdftext-'));
 try{
  const bytes=Buffer.from('%PDF-synthetic');let calls=0;
  const d=await readPdfAsText(bytes,path.join(root,'1279.pdf'),{convert:async input=>{calls++;assert.equal(input,bytes);return delta;},log:()=>{}});
  assert.equal(calls,1);assert.equal(d.pdfBytes,bytes);assert.equal(d.extracted.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(d.extracted.textCarrier,'DELTA DENTAL');assert.equal(d.extracted.sourceFormat,'pdf-to-text');
  assert.equal(await fs.readFile(d.extracted.generatedTextPath,'utf8'),delta);
  assert.deepEqual(parseDelta(d.extracted).errors,[]);assert.equal(parseDelta(d.extracted).claims[0].paymentPayload.amount,'232.00');
  const scan=await scanIncomingFolder({execute:async()=>[[]]},path.join(root,'METLIFE'),{processFile:()=>{throw Error('Must not scan generated text');},exportReports:async()=>({status:'ok'})});
  assert.equal(scan.count,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('invalid conversion stops before DB queries and leaves text available for review',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pdftext-bad-'));
 try{
  const file=path.join(root,'1279.pdf');await fs.writeFile(file,'%PDF-synthetic');let queries=0;
  for(const text of ['unrecognized invoice',delta.replace('$232.00','$233.00')]){
   await assert.rejects(processSinglePdf({execute:async()=>{queries++;throw Error('unexpected DB');}},file,{convertPdf:async()=>text}));
  }
  assert.equal(queries,0);assert.equal((await fs.readdir(path.join(root,'TEXT'))).length,1);
  await assert.rejects(convertPdfBytesToText(Buffer.from('not pdf')),/không phải PDF/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('automatic PDF conversion posts once across PDF/TXT replay and keeps original PDF attachment (simulated DB)',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pdftext-post-'));
 try{
  const parsed=parseDelta(readInsuranceTextDocument(Buffer.from(delta)).extracted),c=parsed.claims[0];
  const f=await insuranceLedger(root,[{patNum:1279,firstName:c.patient.firstName,lastName:c.patient.lastName,memberId:c.patient.memberId,claimNumber:c.claimNumber,procedures:c.procedures,serviceDate:'2026-10-22'}]);
  for(const fileName of ['1279.pdf','1793111377468_1279.txt']){
   const file=path.join(root,fileName);await fs.writeFile(file,fileName.endsWith('.pdf')?'%PDF-synthetic':delta);
   await processSinglePdf(f.pool,file,{convertPdf:async()=>delta,hashSplits:f.hashes});
  }
  assert.equal(f.payments.length,1);assert.equal(f.splits.length,2);assert.equal(f.addedAudit.length,0);
  assert.ok(f.documents.some(d=>d.FileName.endsWith('.pdf')));
  const pdf=f.documents.find(d=>d.FileName.endsWith('.pdf'));
  assert.equal((await fs.readFile(path.join(root,'images','T','Test0',pdf.FileName))).toString(),'%PDF-synthetic');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('word coordinates rebuild visual rows and page boundaries rather than column reading order',()=>{
 const word=(text,x,y)=>({text,bbox:{left:x,right:x+20,top:y,bottom:y+10}});
 const text=scribePagesToText([{lines:[{words:[word('right',200,10)]},{words:[word('left',20,10)]}]}],[{dims:{width:400}}]);
 assert.match(text,/left\s+right/);assert.equal(text.split('\n').length,1);
 assert.throws(()=>scribePagesToText([null],[{dims:{width:400}}]),/đủ trang/);
});

const fixtures=[
 ['1793111377468_1279.pdf',parseDelta,23200],['1793110627097_423.pdf',parseDelta,31040],
 ['1307.pdf',parseMetlife,43920],['1041.pdf',parseLiberty,173300],['1275.pdf',parseCigna,11360],
 ['1792775940841_621.pdf',parseMetlife,46880],['584.pdf',parseMetlife,59100],['1283.pdf',parseDelta,20560],['280.pdf',parseDelta,15400]
];
for(const [file,parse,expected] of fixtures)test(`Scribe library converts real ${file} into reconciled claim TXT`,{skip:!process.env.EOB_PDF_TO_TEXT_DIR,timeout:130000},async()=>{
 const bytes=await fs.readFile(path.join(process.env.EOB_PDF_TO_TEXT_DIR,file));
 const text=await convertPdfBytesToText(bytes),p=parse(readInsuranceTextDocument(Buffer.from(text)).extracted);
 assert.deepEqual(p.errors,[]);assert.equal(p.benefitCents??p.check.netPaymentCents,expected);
 const expectedIds={'1793111377468_1279.pdf':'20262965110923','1793110627097_423.pdf':'20262965111086','1283.pdf':'20262635105590','280.pdf':'20261625116008','1792771310824_1012.pdf':'20261165105694'};
 if(expectedIds[file])assert.equal(p.claims[0].claimNumber,expectedIds[file]);
 if(file.includes('1279'))assert.deepEqual(p.claims[0].paymentPayload.splits.map(s=>[s.code,s.tooth,s.amount]),[['D2393','4','96.00'],['D2393','19','136.00']]);
});


test('conversion never accepts conflicting valid claims or an uncorroborated scanned claim ID',()=>{
 assert.equal(selectConvertedText({candidates:[{text:delta},{text:delta}]}),delta);
 assert.equal(selectConvertedText({candidates:[{text:delta}],native:true}),delta);
 assert.throws(()=>selectConvertedText({candidates:[{text:delta}]}),/hai kết quả/);
 assert.throws(()=>selectConvertedText({candidates:[{text:delta},{text:delta.replace('20262965110923','20262965110924')}]}),/khác nhau/);
 assert.throws(()=>selectConvertedText({candidates:[{text:delta.replace('$232.00','$233.00')}],native:true}),/PDF -> TXT/);
});


test('converted TXT is retained when financial validation rejects an ambiguous scan',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pdftext-review-'));
 try{
  const bytes=Buffer.from('%PDF-synthetic'),file=path.join(root,'scan.pdf');
  const partial='DELTA DENTAL Provider Tools\nClaim 20262965110923\nUnclear service columns';
  const error=Object.assign(new Error('PDF -> TXT: chưa đọc rõ mã dịch vụ.'),{code:'EOB_REVIEW_REQUIRED',convertedText:partial});
  await assert.rejects(readPdfAsText(bytes,file,{convert:async()=>{throw error;},log:()=>{}}),/TXT đã lưu/);
  const files=await fs.readdir(path.join(root,'TEXT'));assert.equal(files.length,1);
  assert.equal(await fs.readFile(path.join(root,'TEXT',files[0]),'utf8'),partial);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('known scanned Delta 1012 converts to TXT but refuses payment when service codes remain ambiguous',{skip:!process.env.EOB_PDF_TO_TEXT_DIR,timeout:130000},async()=>{
 const bytes=await fs.readFile(path.join(process.env.EOB_PDF_TO_TEXT_DIR,'1792771310824_1012.pdf'));
 await assert.rejects(convertPdfBytesToText(bytes),e=>e.code==='EOB_REVIEW_REQUIRED'&&typeof e.convertedText==='string'&&e.convertedText.includes('DELTA')&&e.convertedText.includes('$115.00'));
});
