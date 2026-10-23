import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {parseCigna} from './parser.js';
import {processCignaPdf} from './processor.js';
import {extractPdf} from '../metlife/parser.js';
import {matchLibertyProcedures} from '../liberty/validation.js';
import {scanIncomingFolder,getProcessorStatus,getHistoryPdf} from '../metlife/autoProcessor.js';
import {appendDailyWorkbook} from '../metlife/dailyExcel.js';

function sample(){
 const line=(y,words)=>({y,items:words.map(([str,x])=>({str,x,width:20,y})),text:words.map(w=>w[0]).join(' ')});
 const headers=[['Charged',214],['Allowed',278],['Applied',342],['Balance',402],['Contracted',466],['Coinsurance',530],['Tooth',147]];
 const proc=(y,code,tooth)=>[
  line(y,[['10/11/2026-',41],[`${code} -`,101],[tooth,144],[code==='D2392'?'$150.00':'$0.00',211],[code==='D2392'?'$150.00':'-$71.00',275],['$0.00',339],[code==='D2392'?'$0.00':'$71.00',398],['$0.00',462],[code==='D2392'?'0%=':'80%=',526]]),
  line(y+12,[['10/11/2026',41],['Filling, 2',101],[code==='D2392'?'$0.00':'$56.80',526]]),line(y+24,[['surfaces',101]])];
 const totals=y=>line(y,[['Totals',41],['$300.00',211],['$158.00',275],['$0.00',339],['$142.00',398],['$0.00',462],['$0.00',526]]);
 return {sha256:'c'.repeat(64),pages:[{page:1,width:612,height:792,lines:[line(10,[['Claim/Reference Number: E262868007800',36]]),line(25,[['Patient Name: PERSON TEST | View Coverage',36]]),line(40,[['Date Processed: 10/15/2026',36]]),line(55,[['Claim Amount Paid: $0.00',36]]),line(65,[['Claim Status: PROCESSED',36]]),line(80,headers),...proc(120,'D2392','30'),...proc(180,'D2150','30'),...proc(240,'D2392','31'),totals(290)]},{page:2,width:612,height:792,lines:[line(80,headers),...proc(120,'D2150','31'),totals(180)]}]};
}

test('CIGNA normalizes alternate benefits across two pages to the common payment payload',()=>{
 const p=parseCigna(sample());assert.deepEqual(p.errors,[]);assert.equal(p.check.netPaymentCents,11360);
 const c=p.claims[0];assert.equal(c.rawProcedures.length,4);assert.equal(c.headerPaidCents,0);assert.equal(c.rawProcedures[1].notAllowedCents,-7100);
 assert.deepEqual(c.procedures.map(p=>[p.code,p.tooth,p.feeCents,p.benefitCents,p.alternateCode]),[['D2392','30',15000,5680,'D2150'],['D2392','31',15000,5680,'D2150']]);
 assert.equal(c.paymentPayload.payDate,'2026-10-15');assert.equal(c.paymentPayload.amount,'113.60');assert.equal(c.paymentPayload.checkNum,'');assert.equal(c.paymentPayload.payNote,'Claim number: E262868007800');
 assert.ok(p.warnings.length);assert.equal(matchLibertyProcedures([{ProcNum:1,ProcCode:'D2392',ProcDate:'2026-10-11',ToothNum:'31'},{ProcNum:2,ProcCode:'D2392',ProcDate:'2026-10-11',ToothNum:'30'}],c).size,2);
});

test('missing continuation pages, conflicting totals and ambiguous replacement rows stop before DB queries',async()=>{
 const missing=sample();missing.pages.pop();
 const wrong=sample();wrong.pages[0].lines[3].text='Claim Amount Paid: $114.00';
 const ambiguous=sample();for(const l of ambiguous.pages[1].lines)for(const i of l.items)if(i.str==='31')i.str='30';
 const pending=sample();pending.pages[0].lines[4].text='Claim Status: PENDING';
 for(const extracted of [missing,wrong,ambiguous,pending]){
  assert.ok(parseCigna(extracted).errors.length);let queries=0;
  await assert.rejects(processCignaPdf({execute:async()=>{queries++;throw Error('must not query');}},{extracted}),e=>e.code==='EOB_REVIEW_REQUIRED');assert.equal(queries,0);
 }
});

test('separate CIGNA claims retain their own processed dates',()=>{
 const a=sample(),b=sample();b.pages[0].lines[0].text='Claim/Reference Number: E262868007801';b.pages[0].lines[1].text='Patient Name: SECOND PERSON | View Coverage';b.pages[0].lines[2].text='Date Processed: 10/16/2026';
 const p=parseCigna({sha256:'d'.repeat(64),pages:[...a.pages,...b.pages]});
 assert.deepEqual(p.errors,[]);assert.equal(p.claimsCount,2);assert.equal(p.check.netPaymentCents,22720);assert.deepEqual(p.claims.map(c=>c.check.date),['2026-10-15','2026-10-16']);
});

test('missing CIGNA tooth match blocks import and payment before writes',async()=>{
 let writes=0;
 const pool={execute:async(sql)=>{
  if(!/^\s*SELECT/.test(sql)){writes++;throw Error('must not write');}
  if(sql.includes('FROM patient p'))return [[{PatNum:1275}]];
  return [[{ProcNum:1,ProcCode:'D2392',ProcDate:'2026-10-11',ToothNum:'30'}]];
 }};
 await assert.rejects(processCignaPdf(pool,{fileName:'1275.pdf',extracted:sample()}),e=>e.code==='EOB_REVIEW_REQUIRED');assert.equal(writes,0);
});

test('CIGNA folder is scanned, counted and used for archived PDF lookup',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cigna-folder-')),metlife=path.join(root,'METLIFE'),cigna=path.join(root,'CIGNA');
 await fs.mkdir(cigna);await fs.mkdir(metlife);const source=path.join(cigna,'1275.pdf');await fs.writeFile(source,'%PDF-synthetic');await fs.utimes(source,new Date(0),new Date(0));
 const pool={execute:async()=>[[]]};
 try{
  const res=await scanIncomingFolder(pool,metlife,{processFile:async filePool=>{assert.equal(filePool,pool);return {success:true};},exportReports:async()=>({status:'ok'})});assert.equal(res.count,1);
  assert.equal((await getProcessorStatus(pool,metlife)).counts.incoming,1);
  await fs.mkdir(path.join(cigna,'PROCESSED'));await fs.rename(source,path.join(cigna,'PROCESSED','123_1275.pdf'));
  const pdf=await getHistoryPdf({execute:async()=>[[{FileName:'1275.pdf',DocNum:0,Details:''}]]},1,metlife);assert.equal(pdf.bytes.toString(),'%PDF-synthetic');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('CIGNA reuses payment/doc/history/Excel workflow and keeps the same-code teeth isolated (simulated DB)',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cigna-post-')),filePath=path.join(root,'1275.pdf'),fileBytes=Buffer.from('%PDF-synthetic');await fs.writeFile(filePath,fileBytes);await fs.mkdir(path.join(root,'images'));
 const documents=[],history=[],payments=[],splits=[],logs=[];
 const procs=['30','31'].map((ToothNum,i)=>({ProcNum:501+i,ProcCode:'D2392',ProcDate:'2026-10-11',ToothNum,ProcFee:'56.80',Descript:'Composite filling',ProvNum:1,ClinicNum:0}));
 const conn={query:async()=>[[]],release(){},execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];
  if(sql.includes('SELECT PayNum'))return [[]];
  if(sql.includes('INSERT INTO payment')){payments.push(args);return [{insertId:1841}];}
  if(sql.includes('INSERT INTO paysplit'))splits.push(args);
  if(sql.includes('INSERT INTO securitylog '))return [{insertId:55}];
  if(sql.includes('AS LogDateTime'))return [[{PermType:15,UserNum:0,LogDateTime:'2026-10-15 12:00:00',LogText:'Synthetic',PatNum:1275,DateTPrevious:'0001-01-01 00:00:00'}]];
  return [{affectedRows:1}];
 }};
 const pool={getConnection:async()=>conn,execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];
  if(sql.includes('FROM patient p')){assert.match(sql,/%CIGNA%/);assert.deepEqual(args,['PERSON','TEST','1275']);return [[{PatNum:1275,FName:'PERSON',LName:'TEST',ImageFolder:'Test1275',PriProv:1,ClinicNum:0}]];}
  if(sql.includes('procedurecode.ProcCode')||sql.includes('FROM procedurelog pl'))return [procs];
  if(sql.includes('FROM preference'))return [[{PrefName:'DocPath',ValueString:path.join(root,'images')},{PrefName:'AtoZfolderUsed',ValueString:'1'}]];
  if(sql.includes('Category = 18'))return [[{DefNum:18}]];
  if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [[{COLUMN_NAME:'DocNum',EXTRA:'auto_increment'},...['DocCategory','PatNum','FileName','Description','DateCreated','ImgType','MountItemNum','ExternalSource','RawBase64'].map(COLUMN_NAME=>({COLUMN_NAME,IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:''}))]];
  if(sql.includes('INSERT INTO document')){documents.push(args);return [{insertId:3575}];}
  if(sql.includes('Category = 10'))return [[{DefNum:10,ItemName:'Insurance Paid'}]];
  if(sql.includes('SUM(ProcFee)'))return [[{TotalCharges:113.6}]];
  if(sql.includes('SUM(SplitAmt)'))return [[{TotalPaid:113.6}]];
  if(sql.includes('INSERT INTO luk_metlife_history'))history.push(args);
  return [{affectedRows:1}];
 }};
 try{
  const result=await processCignaPdf(pool,{filePath,fileName:'1275.pdf',fileBytes,extracted:sample()},{log:s=>logs.push(s),preparePayload:async(_,{claim})=>({updatedFees:[],splits:claim.procedures.map((p,i)=>({ProcNum:501+i,ProvNum:1,ClinicNum:0,date:p.date,code:p.code,amount:(p.benefitCents/100).toFixed(2),SecurityHash:'synthetic-only'}))})});
  assert.equal(result.carrier,'CIGNA');assert.equal(payments.length,1);assert.deepEqual(payments[0].slice(1,5),['2026-10-15','113.60','','Claim number: E262868007800']);assert.equal(payments[0].at(-1),'E262868007800');assert.deepEqual(splits.map(s=>s[4]),[501,502]);
  assert.match(documents[0][2],/^CIGNA_/);assert.equal(documents[0][3],'Claim E262868007800  113.60');assert.equal(documents[0][4],'2026-10-15 00:00:00');assert.deepEqual(await fs.readFile(result.archivePath),fileBytes);assert.match(logs.at(-1),/Cigna Auto-Processor.*HOÀN THÀNH/);
  const h=history[0];assert.equal(JSON.parse(h[12]).carrier,'CIGNA');
  const report=path.join(root,'EXCEL','2026-10-22.xlsx');await appendDailyWorkbook(pool,[{Id:1,FileName:h[0],FileHash:h[1],PatNum:h[2],PatientName:h[3],ClaimNumber:h[4],TotalAmount:h[6],PayNum:h[9],Status:'SUCCESS',Details:h[12]}],report,'2026-10-22');
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(report);assert.equal(wb.getWorksheet('PAYMENTS').getCell('N2').value,'CIGNA');assert.equal(wb.getWorksheet('PAYMENTS').getCell('H2').value,113.6);assert.equal(wb.getWorksheet('PAYMENTS').rowCount,3);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('actual supplied CIGNA PDF regression (optional local fixture)',{skip:!process.env.CIGNA_TEST_PDF},async()=>{
 const p=parseCigna(await extractPdf(await fs.readFile(process.env.CIGNA_TEST_PDF)));assert.deepEqual(p.errors,[]);assert.equal(p.claimsCount,1);assert.equal(p.claims[0].claimNumber,'E262868007800');assert.equal(p.claims[0].date,'2026-10-15');assert.equal(p.check.netPaymentCents,11360);assert.deepEqual(p.claims[0].procedures.map(p=>[p.code,p.tooth,p.benefitCents]),[['D2392','30',5680],['D2392','31',5680]]);
});

test('CIGNA leading-zero tooth is retained through alternate-benefit normalization and matching',()=>{
 const source=sample();for(const page of source.pages)for(const row of page.lines)for(const item of row.items)if(item.str==='30')item.str='03';
 const p=parseCigna(source);assert.deepEqual(p.errors,[]);assert.deepEqual(p.claims[0].procedures.map(r=>r.tooth),['3','31']);
 const matches=matchLibertyProcedures([{ProcNum:1,ProcCode:'D2392',ProcDate:'2026-10-11',ToothNum:'03'},{ProcNum:2,ProcCode:'D2392',ProcDate:'2026-10-11',ToothNum:'31'}],p.claims[0]);assert.equal(matches.size,2);
});
