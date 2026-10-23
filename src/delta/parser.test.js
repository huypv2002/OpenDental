import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {parseDelta} from './parser.js';
import {processDeltaPdf,resolveDeltaPatient} from './processor.js';
import {readDeltaDocument} from './document.js';
import {scanIncomingFolder,getHistoryPdf,insuranceIncomingDirs} from '../metlife/autoProcessor.js';
import {appendDailyWorkbook} from '../metlife/dailyExcel.js';

function sample(){
 const p=(code,fee,paid)=>`06/11/2026 ${code} - $${fee} $${paid} $${paid} $0.00 100% $${paid} $0.00`;
 const lines=text=>text.map(text=>({text}));
 return {sha256:'d'.repeat(64),ocr:true,sourceFormat:'scanned-pdf',pages:[{lines:lines(['DELTA DENTAL Provider Tools | Fee for service','Claim 20261625116008','PERSON TEST','Patient date of birth Relationship to policy holder/subscriber','09/14/1998 Self (Subscriber)','Policy holder/subscriber name Subscriber ID Employer or group name','PERSON TEST 123456789012 EXAMPLE GROUP','Payment status','Cleared','Amount Payment status updated Payee address','$187.00 06/22/2026','Date payment sent','06/17/2026','Procedures',p('D0120','80.00','30.00'),p('D0220','25.00','0.00'),p('D0230','38.00','0.00'),p('D1110','120.00','61.00')])},{lines:lines([p('D1110','120.00','61.00'),p('D0220','3.12','3.12'),p('D0230','59.88','59.88'),'Claim total $263.00 $154.00 $154.00 $0.00 $154.00 $0.00'])}]};
}

test('Delta uses claim total, sent date, exact page overlap and modified service benefits',()=>{
 const p=parseDelta(sample());assert.deepEqual(p.errors,[]);assert.equal(p.check.netPaymentCents,15400);
 const c=p.claims[0];assert.equal(c.rawProcedures.length,6);assert.equal(c.headerPaidCents,18700);assert.equal(c.date,'2026-06-17');
 assert.deepEqual(c.procedures.map(p=>[p.code,p.feeCents,p.benefitCents]),[['D0120',8000,3000],['D0220',2500,312],['D0230',3800,5988],['D1110',12000,6100]]);
 assert.equal(c.paymentPayload.checkNum,'');assert.equal(c.paymentPayload.payNote,'Claim number: 20261625116008');assert.equal(c.paymentPayload.amount,'154.00');assert.equal(p.warnings.length,2);
});

test('Delta incomplete scans, wrong totals, invalid dates and ambiguous repeated rows stop before DB access',async()=>{
 const missing=sample();missing.pages.pop();
 const wrong=sample();wrong.pages[1].lines.at(-1).text=wrong.pages[1].lines.at(-1).text.replaceAll('$154.00','$155.00');
 const date=sample();date.pages[0].lines[12].text='02/30/2026';
 const badRatio=sample();badRatio.pages[1].lines[2].text=badRatio.pages[1].lines[2].text.replace('100%','80%');
 const ambiguous=sample();ambiguous.pages[1].lines.splice(2,0,{...ambiguous.pages[1].lines[2]});
 const negative=sample();negative.pages[1].lines[1].text=negative.pages[1].lines[1].text.replace('$3.12','-$3.12');
 const noMember=sample();noMember.pages[0].lines[6].text='PERSON TEST EXAMPLE GROUP';
 for(const extracted of [missing,wrong,date,badRatio,ambiguous,noMember,negative]){let queries=0;assert.ok(parseDelta(extracted).errors.length);await assert.rejects(processDeltaPdf({execute:async()=>{queries++;}},{extracted}),e=>e.code==='EOB_REVIEW_REQUIRED');assert.equal(queries,0);}
});

test('Delta resolves exact patient, DOB, subscriber and carrier; rejects multiple matches',async()=>{
 const claim=parseDelta(sample()).claims[0];
 await assert.rejects(resolveDeltaPatient({execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];assert.match(sql,/%DELTA%/);assert.match(sql,/SubscriberID=\?/);assert.deepEqual(args,['PERSON','TEST','1998-09-14','280','123456789012']);return [[{PatNum:280},{PatNum:281}]];}},{claim,fileName:'280.pdf',claimsCount:1}),/duy nhất/);
});

test('Delta sibling folder is scanned and archived documents can be found',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'delta-folder-')),metlife=path.join(root,'METLIFE'),delta=path.join(root,'DELTA DENTAL');
 try{await fs.mkdir(metlife);await fs.mkdir(delta);const file=path.join(delta,'280.pdf');await fs.writeFile(file,'%PDF-synthetic');await fs.utimes(file,new Date(0),new Date(0));
 assert.ok(insuranceIncomingDirs(metlife).includes(delta));
 const pool={execute:async()=>[[]]};const r=await scanIncomingFolder(pool,metlife,{processFile:async()=>({success:true}),exportReports:async()=>({status:'ok'})});assert.equal(r.count,1);
 await fs.mkdir(path.join(delta,'PROCESSED'));await fs.rename(file,path.join(delta,'PROCESSED','123_280.pdf'));
 const pdf=await getHistoryPdf({execute:async()=>[[{FileName:'280.pdf',DocNum:0,Details:''}]]},1,metlife);assert.equal(pdf.bytes.toString(),'%PDF-synthetic');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Delta patient/procedure preflight rejects mismatched services before any write',async()=>{
 let writes=0;const pool={execute:async sql=>{if(!/^\s*SELECT/.test(sql)){writes++;throw Error('unexpected write');}return sql.includes('FROM patient p')?[[{PatNum:280}]]:[[]];}};
 await assert.rejects(processDeltaPdf(pool,{fileName:'280.pdf',extracted:sample()}),e=>e.code==='EOB_REVIEW_REQUIRED');assert.equal(writes,0);
});

test('supplied scanned Delta PDF regression (optional private fixture)',{skip:!process.env.DELTA_TEST_PDF},async()=>{
 const {extracted}=await readDeltaDocument(await fs.readFile(process.env.DELTA_TEST_PDF),'280.pdf');const p=parseDelta(extracted);
 assert.deepEqual(p.errors,[]);assert.equal(p.claimsCount,1);assert.equal(p.claims[0].claimNumber,'20261625116008');assert.equal(p.claims[0].date,'2026-06-17');assert.equal(p.check.netPaymentCents,15400);assert.equal(p.claims[0].headerPaidCents,18700);assert.deepEqual(p.claims[0].procedures.map(p=>[p.code,p.benefitCents]),[['D0120',3000],['D0220',312],['D0230',5988],['D1110',6100]]);
});

test('DELTA DENTAL reuses payment/doc/history/Excel workflow and keeps the claim benefits reconciled (simulated DB)',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'delta-post-')),filePath=path.join(root,'280.pdf'),fileBytes=Buffer.from('%PDF-synthetic');await fs.writeFile(filePath,fileBytes);await fs.mkdir(path.join(root,'images'));
 const documents=[],history=[],payments=[],splits=[],logs=[];
 const procs=[['D0120','30.00'],['D0220','3.12'],['D0230','59.88'],['D1110','61.00']].map(([ProcCode,ProcFee],i)=>({ProcNum:501+i,ProcCode,ProcDate:'2026-06-11',ToothNum:'',ProcFee,Descript:'Synthetic service',ProvNum:1,ClinicNum:0}));
 const conn={query:async()=>[[]],release(){},execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];
  if(sql.includes('SELECT PayNum'))return [[]];
  if(sql.includes('INSERT INTO payment')){payments.push(args);return [{insertId:1841}];}
  if(sql.includes('INSERT INTO paysplit'))splits.push(args);
  if(sql.includes('INSERT INTO securitylog '))return [{insertId:55}];
  if(sql.includes('AS LogDateTime'))return [[{PermType:15,UserNum:0,LogDateTime:'2026-06-17 12:00:00',LogText:'Synthetic',PatNum:280,DateTPrevious:'0001-01-01 00:00:00'}]];
  return [{affectedRows:1}];
 }};
 const pool={getConnection:async()=>conn,execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];
  if(sql.includes('FROM patient p')){assert.match(sql,/%DELTA%/);assert.deepEqual(args,['PERSON','TEST','1998-09-14','280','123456789012']);return [[{PatNum:280,FName:'PERSON',LName:'TEST',ImageFolder:'Test280',PriProv:1,ClinicNum:0}]];}
  if(sql.includes('procedurecode.ProcCode')||sql.includes('FROM procedurelog pl'))return [procs];
  if(sql.includes('FROM preference'))return [[{PrefName:'DocPath',ValueString:path.join(root,'images')},{PrefName:'AtoZfolderUsed',ValueString:'1'}]];
  if(sql.includes('Category = 18'))return [[{DefNum:18}]];
  if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [[{COLUMN_NAME:'DocNum',EXTRA:'auto_increment'},...['DocCategory','PatNum','FileName','Description','DateCreated','ImgType','MountItemNum','ExternalSource','RawBase64'].map(COLUMN_NAME=>({COLUMN_NAME,IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:''}))]];
  if(sql.includes('INSERT INTO document')){documents.push(args);return [{insertId:3575}];}
  if(sql.includes('Category = 10'))return [[{DefNum:10,ItemName:'Insurance Paid'}]];
  if(sql.includes('SUM(ProcFee)'))return [[{TotalCharges:154}]];
  if(sql.includes('SUM(SplitAmt)'))return [[{TotalPaid:154}]];
  if(sql.includes('INSERT INTO luk_metlife_history'))history.push(args);
  return [{affectedRows:1}];
 }};
 try{
  const result=await processDeltaPdf(pool,{filePath,fileName:'280.pdf',fileBytes,extracted:sample()},{log:s=>logs.push(s),preparePayload:async(_,{claim})=>({updatedFees:[],splits:claim.procedures.map((p,i)=>({ProcNum:501+i,ProvNum:1,ClinicNum:0,date:p.date,code:p.code,amount:(p.benefitCents/100).toFixed(2),SecurityHash:'synthetic-only'}))})});
  assert.equal(result.carrier,'DELTA DENTAL');assert.equal(payments.length,1);assert.deepEqual(payments[0].slice(1,5),['2026-06-17','154.00','','Claim number: 20261625116008']);assert.equal(payments[0].at(-1),'20261625116008');assert.deepEqual(splits.map(s=>s[4]),[501,502,503,504]);
  assert.match(documents[0][2],/^DELTA_/);assert.equal(documents[0][3],'Claim 20261625116008  154.00');assert.equal(documents[0][4],'2026-06-17 00:00:00');assert.deepEqual(await fs.readFile(result.archivePath),fileBytes);assert.match(logs.at(-1),/Delta Dental Auto-Processor.*HOÀN THÀNH/);
  const h=history[0];assert.equal(JSON.parse(h[12]).carrier,'DELTA DENTAL');
  const report=path.join(root,'EXCEL','2026-10-22.xlsx');await appendDailyWorkbook(pool,[{Id:1,FileName:h[0],FileHash:h[1],PatNum:h[2],PatientName:h[3],ClaimNumber:h[4],TotalAmount:h[6],PayNum:h[9],Status:'SUCCESS',Details:h[12]}],report,'2026-10-22');
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(report);assert.equal(wb.getWorksheet('PAYMENTS').getCell('N2').value,'DELTA DENTAL');assert.equal(wb.getWorksheet('PAYMENTS').getCell('H2').value,154);assert.equal(wb.getWorksheet('PAYMENTS').rowCount,5);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});


test('Delta multi-patient documents keep each claim payment and date separate',()=>{
 const a=sample(),b=sample();b.pages[0].lines[1].text='Claim 20261625116009';b.pages[0].lines[2].text='SECOND PERSON';b.pages[0].lines[12].text='06/18/2026';
 const p=parseDelta({...a,pages:[...a.pages,...b.pages]});assert.deepEqual(p.errors,[]);assert.equal(p.claimsCount,2);assert.equal(p.check.netPaymentCents,30800);assert.deepEqual(p.claims.map(c=>c.paymentPayload.payDate),['2026-06-17','2026-06-18']);
});
