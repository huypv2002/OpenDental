import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {appendDailyWorkbook,exportDailyReports,excelOutputDir,localReportDay,REPORT_HEADERS} from './dailyExcel.js';
import {scanIncomingFolder} from './autoProcessor.js';
import {extractPdf,parseMetlife} from './parser.js';

const day='2026-10-22',now=new Date(2026,9,22,23,59);
export function sampleRows(){
  return [0,1].map((i)=>({Id:i+1,Status:'SUCCESS',PayNum:101+i,PatNum:99+i,PatientName:i?'TEST, PERSON TWO':'TEST, PERSON ONE',ClaimNumber:`TEST${i+1}`,FileName:'sample.jpg',FileHash:'a'.repeat(64),TotalAmount:i?'250.00':'1483.00',Details:JSON.stringify({carrier:'LIBERTY Dental Plan',paymentDate:'2026-10-02',procedures:i?[{code:'D0150',date:'2026-09-17',feeCents:30000,benefitCents:25000}]:[{code:'D5110',date:'2026-09-17',tooth:'Q01',feeCents:95000,benefitCents:74300},{code:'D5120',date:'2026-09-17',tooth:'Q02',feeCents:95000,benefitCents:74000}]})}));
}
export function samplePool(rows=sampleRows()){
  return {execute:async(sql,args)=>{
    assert.match(sql,/^\s*SELECT/,'Excel only reads the clinical DB');
    if(sql.includes('luk_metlife_history'))return [args[0].startsWith(day)?rows:[]];
    if(sql.includes('FROM payment WHERE'))return [[]];
    if(sql.includes('procedurelog'))return [[{ProcNum:1,ProcDate:'2026-09-17',ProcCode:'D5110',ToothNum:'',ProcFee:'743.00',Descript:'Complete denture, maxillary'},{ProcNum:2,ProcDate:'2026-09-17',ProcCode:'D5120',ToothNum:'',ProcFee:'740.00',Descript:'Complete denture, mandibular'},{ProcNum:3,ProcDate:'2026-09-17',ProcCode:'D0150',ToothNum:'',ProcFee:'250.00',Descript:'Comprehensive oral evaluation'}]];
    throw Error('unexpected query');
  }};
}
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'daily-excel-'));return {root,file:path.join(root,`${day}.xlsx`)};}
async function load(file){const w=new ExcelJS.Workbook();await w.xlsx.readFile(file);return w;}

test('report directory sits beside METLIFE and LIBERTY; dates use the server calendar',()=>{
  assert.equal(excelOutputDir('D:\\SHARE\\INSURANCE CLAIM\\METLIFE',path.win32),'D:\\SHARE\\INSURANCE CLAIM\\EXCEL');
  assert.equal(excelOutputDir('D:\\SHARE\\INSURANCE CLAIM\\LIBERTY',path.win32),'D:\\SHARE\\INSURANCE CLAIM\\EXCEL');
  assert.equal(localReportDay(now),day);
});

test('daily workbook matches columns, amounts, service/payment dates, grouping and unique file summary',async()=>{
  const f=await fixture();
  try{
    const result=await appendDailyWorkbook(samplePool(),sampleRows(),f.file,day);assert.equal(result.appended,2);
    const wb=await load(f.file),sheet=wb.getWorksheet('PAYMENTS');
    assert.deepEqual(sheet.getRow(1).values.slice(1),REPORT_HEADERS);assert.equal(sheet.rowCount,4);
    assert.equal(sheet.getCell('D2').value,'D5110');assert.equal(sheet.getCell('F2').value,743);assert.equal(sheet.getCell('K2').value,950);assert.equal(sheet.getCell('L2').value,743);
    assert.equal(sheet.getCell('H2').value,1483);assert.equal(sheet.getCell('J2').formula,'SUM(F2:F3)');assert.equal(sheet.getCell('J2').result,1483);assert.equal(sheet.getCell('I2').result,0);
    assert.equal(sheet.getCell('A2').value.toISOString().slice(0,10),'2026-09-17');assert.equal(sheet.getCell('O2').value.toISOString().slice(0,10),'2026-10-02');
    assert.equal(sheet.getCell('B2').value,'99');assert.ok(sheet.getCell('B3').isMerged);assert.equal(sheet.getCell('C2').fill.fgColor.argb,'FFFFFF00');assert.equal(sheet.getCell('D2').fill.fgColor.argb,'FF00B0E0');
    assert.equal(wb.getWorksheet('TONG HOP').getCell('B2').value,1);assert.equal(wb.getWorksheet('TONG HOP').getCell('B3').value,2);assert.equal(wb.getWorksheet('TONG HOP').getCell('B4').value,1733);
    assert.equal(wb.getWorksheet('_EXPORT_LOG').state,'veryHidden');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('duplicate scans/copies/payment history do not append; later appends preserve staff edits',async()=>{
  const f=await fixture();
  try{
    const rows=sampleRows();await appendDailyWorkbook(samplePool(),rows,f.file,day);
    const before=await fs.readFile(f.file);
    const copy={...rows[0],Id:9,PayNum:999,FileHash:'b'.repeat(64),FileName:'renamed-copy.pdf'};
    const repeated=await appendDailyWorkbook({execute:()=>{throw Error('duplicates must not query procedures');}},[...rows,copy],f.file,day);
    assert.equal(repeated.appended,0);assert.deepEqual(await fs.readFile(f.file),before);
    const manual=await load(f.file);manual.getWorksheet('PAYMENTS').getCell('M2').value='Đã đối chiếu';await manual.xlsx.writeFile(f.file);
    const next={...rows[1],Id:3,PayNum:103,ClaimNumber:'TEST3',FileHash:'c'.repeat(64),FileName:'other.pdf',PatientName:'=HYPERLINK("test")',Details:JSON.stringify({...JSON.parse(rows[1].Details),carrier:'MetLife'})};
    await appendDailyWorkbook(samplePool(),[...rows,next],f.file,day);
    const wb=await load(f.file);assert.equal(wb.getWorksheet('PAYMENTS').getCell('M2').value,'Đã đối chiếu');assert.equal(wb.getWorksheet('PAYMENTS').getCell('C5').value,next.PatientName);assert.equal(wb.getWorksheet('TONG HOP').getCell('B2').value,2);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('an open/locked Excel workbook keeps the old file and retries its original day after restart/midnight',async()=>{
  const f=await fixture(),incoming=path.join(f.root,'METLIFE');
  try{
    const rows=sampleRows();await appendDailyWorkbook(samplePool(),[rows[0]],f.file,day);const before=await fs.readFile(f.file);
    const failed=await exportDailyReports(samplePool(),incoming,{now,outputDir:f.root,writeWorkbook:(pool,r,file,d)=>appendDailyWorkbook(pool,r,file,d,{replace:async()=>{throw Object.assign(Error('Excel is open'),{code:'EBUSY'});}})});
    assert.equal(failed.status,'pending');assert.match(failed.errors[0].message,/đóng file.*Excel/);assert.deepEqual(await fs.readFile(f.file),before);assert.equal((await fs.readdir(path.join(f.root,'.pending')))[0],day);
    const recovered=await exportDailyReports(samplePool(),incoming,{now:new Date(2026,9,23,1),outputDir:f.root});
    assert.equal(recovered.status,'ok');assert.equal((await load(f.file)).getWorksheet('PAYMENTS').rowCount,4);assert.deepEqual(await fs.readdir(path.join(f.root,'.pending')),[]);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('unknown charges stay blank; a bad history record is isolated without blocking valid records',async()=>{
  const f=await fixture();
  try{
    const pool={execute:async()=>[[]]};await appendDailyWorkbook(pool,[sampleRows()[0]],f.file,day);
    const s=(await load(f.file)).getWorksheet('PAYMENTS');for(const cell of ['F2','I2','J2'])assert.equal(s.getCell(cell).value,null);
    const row=sampleRows()[1];row.Details=JSON.stringify({...JSON.parse(row.Details),procedures:[{code:'D0150',date:'2026-09-17',feeCents:30000,benefitCents:1}]});
    const result=await appendDailyWorkbook(samplePool(),[row],f.file,day);assert.equal(result.reviewCount,1);
    const wb=await load(f.file);assert.equal(wb.getWorksheet('CAN DOI CHIEU').getCell('C2').value,row.ClaimNumber);assert.equal(wb.getWorksheet('PAYMENTS').getCell('H2').value,1483);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('legacy history with missing date/services no longer rolls back the new successful payment report',async()=>{
  const f=await fixture(),incoming=path.join(f.root,'METLIFE');
  try{
    const valid=sampleRows()[0],legacy={...sampleRows()[1],Id:18,Details:'{}'};
    const pool=samplePool([legacy,valid]);
    const result=await exportDailyReports(pool,incoming,{now,outputDir:f.root});
    assert.equal(result.status,'review');assert.equal(result.reports[0].appended,1);
    let wb=await load(f.file);assert.equal(wb.getWorksheet('PAYMENTS').getCell('H2').value,1483);assert.equal(wb.getWorksheet('CAN DOI CHIEU').getCell('D2').value,250);assert.equal(wb.getWorksheet('TONG HOP').getCell('B5').value,1);
    const before=await fs.readFile(f.file);await exportDailyReports(pool,incoming,{now,outputDir:f.root});assert.deepEqual(await fs.readFile(f.file),before);
    const fixed=sampleRows()[1];fixed.Id=18;
    await exportDailyReports(samplePool([fixed,valid]),incoming,{now,outputDir:f.root});
    wb=await load(f.file);assert.equal(wb.getWorksheet('TONG HOP').getCell('B3').value,2);assert.equal(wb.getWorksheet('TONG HOP').getCell('B5').value,0);assert.equal(wb.getWorksheet('CAN DOI CHIEU').state,'hidden');
    assert.deepEqual(await fs.readdir(path.join(f.root,'.pending')),[]);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('database failures still preserve the previous report rather than being called missing data',async()=>{
  const f=await fixture();
  try{
    await appendDailyWorkbook(samplePool(),[sampleRows()[0]],f.file,day);const before=await fs.readFile(f.file);
    await assert.rejects(appendDailyWorkbook({execute:async()=>{throw Error('DB unavailable');}},[sampleRows()[1]],f.file,day),/DB unavailable/);
    assert.deepEqual(await fs.readFile(f.file),before);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('null/malformed legacy details are listed for review without inventing an unknown payment amount',async()=>{
  const f=await fixture();
  try{
    const valid=sampleRows()[0],bad=['null','{bad','[]'].map((Details,i)=>({...sampleRows()[1],Id:18+i,PayNum:200+i,Details,TotalAmount:null}));
    const result=await appendDailyWorkbook(samplePool(),[...bad,valid],f.file,day);
    assert.equal(result.appended,1);assert.equal(result.reviewCount,1);
    const wb=await load(f.file);assert.equal(wb.getWorksheet('CAN DOI CHIEU').getCell('D2').value,null);assert.equal(wb.getWorksheet('PAYMENTS').getCell('H2').value,1483);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('failed/review documents never become report entries; preexisting non-tool files are preserved',async()=>{
  const f=await fixture();
  try{
    await appendDailyWorkbook(samplePool(),sampleRows().map(r=>({...r,Status:'REVIEW'})),f.file,day);await assert.rejects(fs.access(f.file),{code:'ENOENT'});
    await fs.writeFile(f.file,'preserve customer file');await assert.rejects(appendDailyWorkbook(samplePool(),sampleRows(),f.file,day));assert.equal(await fs.readFile(f.file,'utf8'),'preserve customer file');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('concurrent writers cannot create duplicate groups',async()=>{
  const f=await fixture();
  try{
    await Promise.allSettled([appendDailyWorkbook(samplePool(),sampleRows(),f.file,day),appendDailyWorkbook(samplePool(),sampleRows(),f.file,day)]);
    await appendDailyWorkbook(samplePool(),sampleRows(),f.file,day);
    assert.equal((await load(f.file)).getWorksheet('TONG HOP').getCell('B3').value,2);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('scanner exports after processing, and Excel failure does not retry or reclassify a successful payment',async()=>{
  const f=await fixture(),incoming=path.join(f.root,'METLIFE');await fs.mkdir(incoming);await fs.writeFile(path.join(incoming,'sample.pdf'),'test');await fs.utimes(path.join(incoming,'sample.pdf'),new Date(0),new Date(0));
  let processed=0,exports=0;
  try{
    const result=await scanIncomingFolder({execute:async()=>[[]]},incoming,{processFile:async()=>{processed++;return {success:true};},exportReports:async()=>{exports++;assert.equal(processed,1);throw Error('Excel is open');}});
    assert.equal(processed,1);assert.equal(exports,1);assert.equal(result.results[0].success,true);await assert.rejects(fs.access(path.join(incoming,'ERRORS')),{code:'ENOENT'});
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('mysql JSON objects, buffers, double-encoded details and lowercase columns export as real files',async()=>{
  for(const format of ['object','buffer','double','lowercase']){
    const f=await fixture();
    try{
      let row=sampleRows()[0];
      if(format==='object')row.Details=JSON.parse(row.Details);
      if(format==='buffer')row.Details=Buffer.from(row.Details);
      if(format==='double')row.Details=JSON.stringify(row.Details);
      if(format==='lowercase')row=Object.fromEntries(Object.entries(row).map(([k,v])=>[k.toLowerCase(),v]));
      const result=await exportDailyReports(samplePool([row]),path.join(f.root,'METLIFE'),{now,outputDir:f.root});
      assert.equal(result.status,'ok');assert.equal(result.reports[0].appended,1);assert.ok((await fs.stat(f.file)).size>0);
    }finally{await fs.rm(f.root,{recursive:true,force:true});}
  }
});

test('five copies of one legacy claim recover actual posted payment/services and produce one file/claim',async()=>{
  const f=await fixture();
  try{
    const base=sampleRows()[0],rows=Array.from({length:5},(_,i)=>({...base,Id:18+i,PayNum:1836+i,Details:'{}'}));
    const pool={execute:async(sql,args)=>{
      assert.match(sql,/^\s*SELECT/);
      if(sql.includes('luk_metlife_history'))return [rows];
      if(sql.includes('FROM payment WHERE'))return [[{PayNum:args[0],PatNum:99,PayDate:'2026-09-29',PayAmt:'1483.00'}]];
      if(sql.includes('FROM paysplit ps'))return [[{PatNum:99,ProcNum:1,SplitAmt:'743.00',ProcDate:'2026-09-17',ProcCode:'D5110',ToothNum:'Q01'},{PatNum:99,ProcNum:2,SplitAmt:'740.00',ProcDate:'2026-09-17',ProcCode:'D5120',ToothNum:'Q02'}]];
      return samplePool().execute(sql,args);
    }};
    const result=await exportDailyReports(pool,path.join(f.root,'METLIFE'),{now,outputDir:f.root});
    assert.equal(result.status,'ok');assert.equal(result.reports[0].appended,1);assert.ok((await fs.stat(f.file)).size>0);
    const wb=await load(f.file),s=wb.getWorksheet('PAYMENTS');
    assert.equal(s.getCell('H2').value,1483);assert.equal(s.getCell('O2').value.toISOString().slice(0,10),'2026-09-29');assert.equal(s.getCell('K2').value,null);
    assert.equal(wb.getWorksheet('TONG HOP').getCell('B2').value,1);assert.equal(wb.getWorksheet('TONG HOP').getCell('B3').value,1);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('legacy recovery rejects a payment belonging to a different patient',async()=>{
  const f=await fixture();
  try{
    const pool={execute:async(sql)=>{assert.match(sql,/^\s*SELECT/);assert.match(sql,/FROM payment WHERE/);return [[{PatNum:123,PayDate:'2026-09-29',PayAmt:'1483.00'}]];}};
    const result=await appendDailyWorkbook(pool,[{...sampleRows()[0],Details:'{}'}],f.file,day);
    assert.equal(result.appended,0);assert.equal(result.reviewCount,1);assert.equal((await load(f.file)).getWorksheet('PAYMENTS').rowCount,1);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('Allowable service dates come only from uniquely linked OD procedures',async()=>{
  const f=await fixture();
  try{
    const row=sampleRows()[0],details=JSON.parse(row.Details);
    details.procedures[0].date=null;details.procedures[0].feeCents=null;
    details.splits=[{code:'D5110',procNum:1}];row.Details=JSON.stringify(details);
    const pool={execute:async(sql,args)=>{
      const [procs]=await samplePool().execute(sql,args);
      return [[...procs,{ProcNum:999,ProcCode:'D5110',ProcDate:'2025-01-01',ProcFee:'999.00'}]];
    }};
    const result=await appendDailyWorkbook(pool,[row],f.file,day);assert.equal(result.appended,1);assert.equal(result.reviewCount,0);
    let wb=await load(f.file);assert.equal(wb.getWorksheet('PAYMENTS').getCell('A2').value.toISOString().slice(0,10),'2026-09-17');assert.equal(wb.getWorksheet('PAYMENTS').getCell('K2').value,null);
    const missing={...row,Id:55,PayNum:555,ClaimNumber:'NOLINK',FileHash:'different'};const bad=JSON.parse(missing.Details);bad.splits=[];missing.Details=JSON.stringify(bad);
    const noLinkPool={execute:async(sql,args)=>sql.includes('FROM paysplit WHERE')?[[]]:pool.execute(sql,args)};
    const blocked=await appendDailyWorkbook(noLinkPool,[missing],f.file,day);assert.equal(blocked.reviewCount,1);
    wb=await load(f.file);assert.match(wb.getWorksheet('CAN DOI CHIEU').getCell('F2').value,/ngày dịch vụ của D5110/);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('review tab repair removes repeated headers and duplicate claims without touching exported payments',async()=>{
  const f=await fixture();
  try{
    const valid=sampleRows()[0],bad={...sampleRows()[1],Details:'{}'};
    await appendDailyWorkbook(samplePool(),[valid,bad],f.file,day);
    const old=await load(f.file),r=old.getWorksheet('CAN DOI CHIEU');
    for(let i=0;i<3;i++){r.addRow(['PT NUM','PATIENT NAME','CLAIM','CREDIT','FILE','CẦN ĐỐI CHIẾU']);r.addRow(['100','TEST, PERSON TWO',bad.ClaimNumber,250,bad.FileName,'old reason']);}
    old.getWorksheet('PAYMENTS').getCell('M2').value='Staff note';await old.xlsx.writeFile(f.file);
    for(let i=0;i<3;i++){
      const duplicates=Array.from({length:5},(_,n)=>({...bad,Id:100+n,PayNum:200+n,FileHash:`copy-${n}`}));
      await appendDailyWorkbook(samplePool(),[valid,...duplicates],f.file,day);
      const wb=await load(f.file),sheet=wb.getWorksheet('CAN DOI CHIEU');
      assert.equal(sheet.rowCount,2);assert.equal(sheet.getCell('A1').value,'PT NUM');assert.equal(sheet.getCell('A2').value,'100');assert.equal(wb.getWorksheet('PAYMENTS').getCell('M2').value,'Staff note');
    }
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('actual MetLife PDF Allowable rows export after linked-date resolution (optional local fixture)',{skip:!process.env.METLIFE_TEST_PDF},async()=>{
  const f=await fixture();
  try{
    const parsed=parseMetlife(await extractPdf(await fs.readFile(process.env.METLIFE_TEST_PDF)));
    assert.equal(parsed.benefitCents,43920);assert.deepEqual(parsed.procedures.filter(p=>!p.date).map(p=>p.code),['D1110','D0210']);
    const serviceDay=parsed.procedures.find(p=>p.date).date;
    const procs=parsed.procedures.map((p,i)=>({ProcNum:500+i,ProcCode:p.code,ProcDate:serviceDay,ProcFee:(p.benefitCents/100).toFixed(2),ToothNum:p.tooth||'',Descript:'Synthetic linked procedure'}));
    const details={paymentDate:parsed.processed,procedures:parsed.procedures,splits:parsed.procedures.map((p,i)=>({code:p.code,procNum:500+i}))};
    const row={...sampleRows()[0],Details:JSON.stringify(details),TotalAmount:'439.20'};
    const pool={execute:async sql=>{assert.match(sql,/^\s*SELECT/);return [procs];}};
    const result=await appendDailyWorkbook(pool,[row],f.file,day);assert.equal(result.appended,1);assert.equal(result.reviewCount,0);
    const sheet=(await load(f.file)).getWorksheet('PAYMENTS');assert.equal(sheet.getCell('H2').value,439.2);assert.equal(sheet.rowCount,parsed.procedures.length+1);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
