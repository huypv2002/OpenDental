import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {readInsuranceDocument,isInsuranceFile,imagePdf,tsvLines} from './document.js';
import {parseLiberty} from './parser.js';
import {validateLibertyForPosting,matchLibertyProcedures} from './validation.js';
import {processLibertyPdf} from './processor.js';
import {scanIncomingFolder,getHistoryPdf,autoPopulateProcedureFees} from '../metlife/autoProcessor.js';

function syntheticImage(){
 const c=createCanvas(2400,1150),ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='black';ctx.font='24px Arial';
 const text=(x,y,s)=>ctx.fillText(s,x,y);
 text(40,50,'LIBERTY Dental Plan');text(40,90,'PAYMENT DETAILS');text(40,130,'Check Number: TEST123');text(1300,130,'Check Date: 10/02/2026');
 const columns=[['DateOf',100],['Code',300],['Tooth',450],['Surface',550],['Procedure',650],['Submitted',1200],['Allowed',1370],['CoPay',1520],['Deductible',1680],['CoIns',1850],['Total',2020],['PlanPaid',2180]];
 for(const [label,x] of columns)text(x,210,label);
 for(let i=0;i<2;i++){
  const y=300+i*300,paid=i===0?'38.00':'42.00';
  text(40,y,`Patient: TEST, PERSON${i+1} - TEST-00${i+1} Plan: TEST Group: TESTGROUP`);
  text(40,y+45,`CLAIM: ${7001+i} (Original)`);
  text(40,y+90,'1');text(100,y+90,'09/17/26');text(300,y+90,'D0150');text(650,y+90,'Comprehensive oral evaluation');
  ['100.00',paid,'0.00','0.00','0.00','0.00',paid].forEach((value,j)=>text([1200,1370,1520,1680,1850,2020,2180][j],y+90,value));
  text(40,y+145,`CLAIM TOTALS: 100.00 ${paid} 0.00 0.00 0.00 0.00 ${paid}`);
  text(40,y+190,`NET PAYMENT FOR PATIENT: ${paid}`);
 }
 text(40,1010,'NET PAYMENT: 80.00');return c.toBuffer('image/png');
}

test('supported EOB files and TSV word order',()=>{
 for(const file of ['A.pdf','A.JPG','a.JPEG','a.png'])assert.equal(isInsuranceFile(file),true);
 assert.equal(isInsuranceFile('a.exe'),false);
 const lines=tsvLines('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t2\t80\t10\t50\t15\t90\tDETAILS\n5\t1\t1\t1\t1\t1\t10\t10\t60\t15\t90\tPAYMENT');
 assert.equal(lines[0].words.map(w=>w.text).join(' '),'PAYMENT DETAILS');
});

test('local OCR handles an image and its scanned PDF; check/claim totals remain exact',{timeout:120000},async()=>{
 const bytes=syntheticImage();
 const result=await readInsuranceDocument(bytes,'test.png');
 const p=validateLibertyForPosting(parseLiberty(result.extracted),result.extracted);
 assert.equal(p.claimsCount,2);assert.deepEqual(p.claims.map(c=>c.totals.planPaidCents),[3800,4200]);assert.equal(p.check.netPaymentCents,8000);
 assert.equal(result.extracted.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.ok(result.pdfBytes.subarray(0,100).includes(Buffer.from('%PDF-')));
 const scan=await readInsuranceDocument(result.pdfBytes,'scan.pdf');const s=validateLibertyForPosting(parseLiberty(scan.extracted),scan.extracted);
 assert.equal(scan.extracted.sourceFormat,'scanned-pdf');assert.deepEqual(s.claims.map(c=>c.claimNumber),['7001','7002']);
});

test('corrupt and oversized image inputs stop before OCR',async()=>{
 await assert.rejects(readInsuranceDocument(Buffer.from('not an image'),'bad.jpg'),/Nội dung ảnh/);
 await assert.rejects(readInsuranceDocument(Buffer.alloc(30*1024*1024+1),'large.png'),/30 MB/);
});

test('table row loss and wrong patient/procedure data stop before clinical queries',async()=>{
 const extracted={ocr:true,pages:[{ocrRows:2,lines:['LIBERTY Dental Plan','PAYMENT DETAILS','Check Number: TEST123','Check Date: 10/02/2026','Patient: TEST, PERSON - TEST-001','Plan: TEST Group: TEST','CLAIM: 7001 (Original)','1 09/17/26 D0150 Exam 100.00 38.00 0.00 0.00 0.00 0.00 38.00','CLAIM TOTALS: 100.00 38.00 0.00 0.00 0.00 0.00 38.00','NET PAYMENT: 38.00'].map(text=>({text}))}]};
 let queries=0;
 await assert.rejects(processLibertyPdf({execute:async()=>{queries++;throw Error('must not query');}},{extracted}),e=>e.code==='EOB_REVIEW_REQUIRED');assert.equal(queries,0);
 const claim={procedures:[{code:'D0220',date:'2026-09-17',tooth:'13',benefitCents:1400}]};
 const proc={ProcNum:1,ProcCode:'D0220',ProcDate:'2026-09-17',ToothNum:'13'};
 assert.equal(matchLibertyProcedures([proc],claim).size,1);
 for(const rows of [[{...proc,ProcDate:'2026-09-18'}],[{...proc,ToothNum:'8'}],[proc,{...proc,ProcNum:2}]])assert.throws(()=>matchLibertyProcedures(rows,claim),/khớp duy nhất/);
});

test('scanner finds image files and parks unclear documents in REVIEW without retrying',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'liberty-scan-images-')),dir=path.join(root,'METLIFE'),liberty=path.join(root,'LIBERTY');
 await fs.mkdir(dir);await fs.mkdir(liberty);const input=path.join(liberty,'test.JPG');await fs.writeFile(input,'synthetic');await fs.utimes(input,new Date(0),new Date(0));
 let attempts=0;const pool={execute:async()=>[[]]};
 try{
  const opts={processFile:async()=>{attempts++;throw Object.assign(new Error('synthetic unreadable image'),{code:'EOB_REVIEW_REQUIRED'});}};
  const first=await scanIncomingFolder(pool,dir,opts);assert.equal(first.count,1);
  const second=await scanIncomingFolder(pool,dir,opts);assert.equal(second.status,'idle');assert.equal(attempts,1);
  assert.equal((await fs.readdir(path.join(liberty,'REVIEW'))).length,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('matched procedure IDs keep repeated codes on different teeth separate during fee updates',async()=>{
 const updates=[];
 const pool={execute:async(sql,args)=>{
  if(sql.startsWith('UPDATE procedurelog SET ProcFee = ?'))updates.push(args);
  if(sql.includes('SELECT ClaimNum'))return [[]];
  if(sql.includes('SUM('))return [[{TotalCharges:26,TotalPaid:0}]];
  return [{affectedRows:1}];
 }};
 await autoPopulateProcedureFees(pool,{patNum:99,dbProcs:[{ProcNum:1,ProcCode:'D0220',ProcDate:'2026-09-17'},{ProcNum:2,ProcCode:'D0220',ProcDate:'2026-09-17'}],eobProcedures:[{procNum:2,code:'D0220',date:'2026-09-17',benefitCents:1400},{procNum:1,code:'D0220',date:'2026-09-17',benefitCents:1200}]});
 assert.deepEqual(updates,[['14.00',2],['12.00',1]]);
});

test('OCR preflights every claim before the first import or payment',async()=>{
 const extracted={ocr:true,pages:[{ocrRows:2,lines:['LIBERTY Dental Plan','PAYMENT DETAILS','Check Number: TEST','Check Date: 10/02/2026','NET PAYMENT: 80.00',
 ...[1,2].flatMap(i=>[`Patient: TEST, PERSON${i} - TEST-00${i}`,`CLAIM: ${7000+i} (Original)`,`1 09/17/26 D0150 Exam 100.00 ${i===1?'38.00':'42.00'} 0.00 0.00 0.00 0.00 ${i===1?'38.00':'42.00'}`,`CLAIM TOTALS: 100.00 ${i===1?'38.00':'42.00'} 0.00 0.00 0.00 0.00 ${i===1?'38.00':'42.00'}`])].map(text=>({text}))}]};
 let writes=0;
 const pool={execute:async(sql,args)=>{
  if(!sql.trim().startsWith('SELECT')){writes++;throw Error('must not write');}
  if(sql.includes('FROM patient p'))return args.includes('PERSON1')?[[{PatNum:99}]]:[[]];
  if(sql.includes('FROM procedurelog'))return [[{ProcNum:1,ProcCode:'D0150',ProcDate:'2026-09-17'}]];
  throw Error('unexpected query');
 }};
 await assert.rejects(processLibertyPdf(pool,{extracted}),e=>e.code==='EOB_REVIEW_REQUIRED'&&/7002/.test(e.message));
 assert.equal(writes,0);
});

test('history image fallback returns a real PDF for the existing viewer',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'liberty-history-image-')),source=path.join(root,'source.png');await fs.writeFile(source,syntheticImage());
 const pool={execute:async()=>[[{Id:1,FileName:'source.png',PatNum:99,DocNum:0,Details:JSON.stringify({archivePath:source})}]]};
 try{const result=await getHistoryPdf(pool,1,root);assert.equal(result.filename,'source.pdf');assert.ok(result.bytes.subarray(0,100).includes(Buffer.from('%PDF-')));}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('supplied Liberty image regression (optional local fixture)',{skip:!process.env.LIBERTY_TEST_IMAGE,timeout:120000},async()=>{
 const bytes=await fs.readFile(process.env.LIBERTY_TEST_IMAGE),r=await readInsuranceDocument(bytes,path.basename(process.env.LIBERTY_TEST_IMAGE)),p=validateLibertyForPosting(parseLiberty(r.extracted),r.extracted);
 assert.equal(p.check.number,'109119');assert.equal(p.check.date,'2026-10-02');assert.equal(p.check.netPaymentCents,173300);
 assert.deepEqual(p.claims.map(c=>c.claimNumber),['77361505','77362477']);assert.deepEqual(p.claims.map(c=>c.totals.planPaidCents),[148300,25000]);
 assert.deepEqual(p.claims[0].procedures.map(p=>[p.code,p.tooth,p.benefitCents]),[['D5110','Q01',74300],['D5120','Q02',74000]]);
 assert.deepEqual(p.claims[1].procedures.map(p=>p.benefitCents),[3800,1400,1200,3500,6800,6300,2000]);
 const scan=await readInsuranceDocument(await imagePdf(bytes),'sample-scan.pdf');
 const scanned=validateLibertyForPosting(parseLiberty(scan.extracted),scan.extracted);
 assert.equal(scan.extracted.sourceFormat,'scanned-pdf');
 assert.deepEqual(scanned.claims.map(c=>[c.claimNumber,c.totals.planPaidCents]),p.claims.map(c=>[c.claimNumber,c.totals.planPaidCents]));
});
