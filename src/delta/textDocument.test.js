import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readDeltaTextDocument,decodeClaimText} from './textDocument.js';
import {parseDelta} from './parser.js';
import {deltaPatientFileNumber} from './processor.js';
import {processSinglePdf,getHistoryPdf,scanIncomingFolder} from '../metlife/autoProcessor.js';
import {insuranceLedger} from '../metlife/testSupport/insuranceLedger.js';
import {isInsuranceFile} from '../liberty/document.js';
const source=`DELTA DENTAL Provider Tools I Fee for service
Claim 20262965110923
TEST PERSON
Patient date of birth Relationship to policy holder/subscriber
06/06/1981 Self (Subscriber)
Policy holder/subscriber name Subscriber ID Employer or group name
TEST PERSON 115084523301 GROUP
Payment status
Outstanding Paid to
Amount Payment status updated Payee address
$542.40 10/28/2026
Date payment sent
10/28/2026
- 10/22/2026 D2393 04 D.M.O $170.00 $170.00 $170.00 $50.00 80% $96.00 $74.00
- 10/22/2026 D2393 19 L.M.O $170.00 $170.00 $170.00 $0.00 80% $136.00 $34 00
Claim total $340.00 $340.00 $340.00 $50.00 $232.00 $108.00`;

test('Delta user TXT supports BOM, CRLF, UTF-16 and currency cents separated by a space without conversion',()=>{
 for(const bytes of [Buffer.from(source),Buffer.from('\ufeff'+source.replaceAll('\n','\r\n')),Buffer.concat([Buffer.from([255,254]),Buffer.from(source,'utf16le')])]){
  const d=readDeltaTextDocument(bytes),p=parseDelta(d.extracted);
  assert.equal(d.pdfBytes,bytes);assert.equal(d.extracted.ocr,false);assert.equal(d.extracted.sourceFormat,'text');
  assert.deepEqual(p.errors,[]);assert.equal(p.claims[0].paymentPayload.amount,'232.00');
  assert.deepEqual(p.claims[0].paymentPayload.splits.map(s=>[s.tooth,s.amount]),[['4','96.00'],['19','136.00']]);
 }
 assert.equal(deltaPatientFileNumber('1793111377468_1279.txt'),'1279');assert.equal(isInsuranceFile('1279.TXT'),true);
});

test('Delta TXT rejects invalid encoding, unrelated formats, missing monetary cells and wrong totals',()=>{
 assert.throws(()=>decodeClaimText(Buffer.from([255])),/UTF/);
 assert.throws(()=>readDeltaTextDocument(Buffer.from('LIBERTY test')),/Delta/);
 for(const s of [source.replace('$34 00','$34 ?0'),source.replace('$232.00','$233.00'),source.replace('$170.00','')])assert.ok(parseDelta(readDeltaTextDocument(Buffer.from(s)).extracted).errors.length);
});

test('TXT scanner posts once, reuses payment after rename and archives original TXT bytes (simulated DB)',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'delta-txt-'));
 try{
  const dir=path.join(root,'DELTA DENTAL');await fs.mkdir(dir);
  const c=parseDelta(readDeltaTextDocument(Buffer.from(source)).extracted).claims[0];
  const f=await insuranceLedger(root,[{patNum:1279,firstName:c.patient.firstName,lastName:c.patient.lastName,memberId:c.patient.memberId,claimNumber:c.claimNumber,procedures:c.procedures,serviceDate:'2026-10-22'}]);
  const originalExecute=f.pool.execute;f.pool.execute=async(sql,args)=>sql.includes('CREATE TABLE IF NOT EXISTS luk_metlife_history')?[[]]:originalExecute(sql,args);
  const bytes=Buffer.from(source);
  for(const name of ['1279.txt','1793111377468_1279.txt']){
   const file=path.join(dir,name);await fs.writeFile(file,bytes);await fs.utimes(file,new Date(0),new Date(0));
   const result=await scanIncomingFolder(f.pool,path.join(root,'METLIFE'),{processFile:async(_pool,p)=>processSinglePdf(f.pool,p,{hashSplits:f.hashes,extract:()=>{throw Error('TXT must not use PDF extraction');}}),exportReports:async()=>({status:'ok'})});
   assert.equal(result.count,1);assert.equal(result.results[0].success,true);
  }
  assert.equal(f.payments.length,1);assert.equal(f.splits.length,2);assert.equal(f.documents.length,1);
  const rows=f.events.filter(([s])=>s.includes('INSERT INTO document'));
  assert.ok(rows.some(([,args])=>args.some(a=>typeof a==='string'&&/^DELTA_.*\.txt$/.test(a))));
  const archived=await getHistoryPdf({execute:async()=>[[{FileName:'1279.txt',DocNum:0,Details:''}]]},1,path.join(root,'METLIFE'));
  assert.match(archived.filename,/\.txt$/);assert.deepEqual(archived.bytes,bytes);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('actual user-converted Delta TXT imports 232.00 (optional private fixture)',{skip:!process.env.DELTA_TEXT_TEST_FILE},async()=>{
 const bytes=await fs.readFile(process.env.DELTA_TEXT_TEST_FILE),p=parseDelta(readDeltaTextDocument(bytes).extracted);
 assert.deepEqual(p.errors,[]);assert.equal(p.claims[0].claimNumber,'20262965110923');assert.equal(p.claims[0].paymentPayload.amount,'232.00');
 assert.equal(p.claims[0].date,'2026-10-28');
});
