import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {agreeDeltaMoneyCell,alignDeltaTotalRows,readDeltaDocument} from './document.js';
import {parseDelta} from './parser.js';
import {processDeltaPdf} from './processor.js';
import {insuranceLedger} from '../metlife/testSupport/insuranceLedger.js';

const word=(text,extra={})=>({text,x:910,width:55,confidence:95,...extra});
const agree=(reads,words=[word('$0.71')])=>agreeDeltaMoneyCell(reads,words,1000,.908,.975);

test('Delta aligns a large total label with its six monetary boxes without guessing values or merging service rows',()=>{
 const label={cy:100,words:[{text:'Claim',x:1,width:40,y:85,height:30},{text:'total',x:45,width:30,y:85,height:30}],text:'Claim total'};
 const amounts=['$263.00','$154.00','$154.00','$0.00','$154.00','$0.00'];
 const money={cy:115,words:amounts.map((text,i)=>({text,x:[378,470,550,650,820,910][i],width:50,y:110,height:10})),text:amounts.join(' ')};
 const joined=alignDeltaTotalRows([label,money],1000);
 assert.equal(joined.length,1);assert.equal(joined[0].cy,115);
 assert.deepEqual(joined[0].words.filter(w=>w.text.startsWith('$')).map(w=>w.text),amounts);
 for(const words of [money.words.slice(1),[...money.words,{text:'06/11/2026',x:120,width:60,y:110,height:10}],money.words.map(w=>({...w,x:400}))]){
  assert.equal(alignDeltaTotalRows([label,{...money,words}],1000).length,2);
 }
});

for(const [key,extension] of [['DELTA_TEST_IMAGE_JPEG','jpg'],['DELTA_TEST_IMAGE_PNG','png']])test(`actual Delta ${extension.toUpperCase()} source image preserves all six claim totals and posts once after rename (simulated DB)`,{skip:!process.env[key],timeout:120000},async()=>{
 const bytes=await fs.readFile(process.env[key]),{extracted,pdfBytes}=await readDeltaDocument(bytes,'280.'+extension),p=parseDelta(extracted);
 assert.deepEqual(p.errors,[]);assert.equal(p.claims.length,1);assert.equal(p.claims[0].claimNumber,'20261625116008');
 assert.equal(p.claims[0].date,'2026-06-17');assert.equal(p.check.netPaymentCents,15400);
 assert.deepEqual(p.claims[0].printedTotals,[26300,15400,15400,0,15400,0]);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'delta-image-post-')),c=p.claims[0];
 try{
  const f=await insuranceLedger(root,[{patNum:280,firstName:c.patient.firstName,lastName:c.patient.lastName,memberId:c.patient.memberId,claimNumber:c.claimNumber,procedures:c.procedures,serviceDate:c.procedures[0].date}]);
  for(const fileName of [`280.${extension}`,`1793111377468_280.${extension}`]){
   const filePath=path.join(root,fileName);await fs.writeFile(filePath,bytes);
   const result=await processDeltaPdf(f.pool,{filePath,fileName,fileBytes:pdfBytes,extracted},{hashSplits:f.hashes,log:()=>{}});
   assert.equal(result.success,true);assert.deepEqual(await fs.readFile(result.archivePath),bytes);
  }
  assert.equal(f.payments.length,1);assert.equal(Number(f.payments[0].PayAmt),154);assert.equal(f.splits.length,4);
  assert.equal(f.documents.length,1);assert.equal(f.addedAudit.length,0);
  assert.ok(pdfBytes.subarray(0,20).includes(Buffer.from('%PDF-')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Delta money cell accepts a complete crop corroborated by the independent whole-page word',()=>{
 assert.equal(agree(['$0.','$0.71','0']),'$0.71');
 assert.equal(agree(['0.71','','0']),'0.71');
 assert.equal(agree(['$0.00','','0'],[word('$0.00')]),'$0.00');
});

test('Delta money cell never guesses missing digits or ignores conflicting valid readings',()=>{
 for(const reads of [['$0.','0',''],['$0.71','$0.77',''],['$0.17','',''],['-$0.71','','']])assert.equal(agree(reads),null);
 for(const words of [[],[word('$0.71',{confidence:89})],[word('$0.71',{confidence:undefined})],[word('$0.71',{x:900})],[word('$0.71',{width:70})],[word('$0.71'),word('$0.71')],[word('$0.')],[word('$0.77')]])assert.equal(agree(['$0.71','','0'],words),null);
});

test('supplied Delta 423 scanned PDF reads small patient-pay cells and reconciles claim totals (optional private fixture)',{skip:!process.env.DELTA_CELL_TEST_PDF},async()=>{
 const {extracted}=await readDeltaDocument(await fs.readFile(process.env.DELTA_CELL_TEST_PDF),'423.pdf');
 const p=parseDelta(extracted);assert.deepEqual(p.errors,[]);assert.equal(p.pageCount,2);assert.equal(p.claimsCount,1);
 const c=p.claims[0];assert.equal(c.claimNumber,'20261515105668');assert.equal(c.date,'2026-06-10');assert.equal(c.headerPaidCents,55420);
 assert.deepEqual(c.printedTotals,[6300,6300,6300,0,5040,1260]);assert.equal(c.rawProcedures.length,4);
 assert.equal(c.paymentPayload.amount,'50.40');assert.equal(c.paymentPayload.checkNum,'');
 assert.deepEqual(c.paymentPayload.splits.map(s=>[s.code,s.date,s.amount]),[['D0220','2026-02-08','2.86'],['D0230','2026-02-08','47.54']]);
 assert.deepEqual(c.procedures.map(s=>[s.code,s.feeCents,s.patientDueCents]),[['D0220',2500,71],['D0230',3800,1189]]);
 assert.ok(p.warnings.some(s=>s.includes('554.20')));
});
