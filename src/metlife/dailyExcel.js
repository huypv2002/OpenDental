import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import lockfile from 'proper-lockfile';
import {cents} from './parser.js';

export const REPORT_HEADERS=['DATE','PT NUM','PATIENT NAME','CODE','TREATMENT PLAN','CHARGE','PAYMENT','CREDIT','BALANCE','TOTAL','INSUR BILL','INSUR PAY','STATUS','INSURANCE','INSUR PAID DAY'];
const META='_EXPORT_LOG';
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const moneyFormat='#,##0.00';
export function localReportDay(now=new Date()){
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
export function excelOutputDir(incomingDir,paths=path){
  return paths.join(paths.dirname(incomingDir),'EXCEL');
}
function dateValue(value){
  const day=String(value||'').slice(0,10);
  if(!DATE.test(day))return null;
  const result=new Date(`${day}T00:00:00Z`);
  return Number.isFinite(+result)&&result.toISOString().slice(0,10)===day?result:null;
}
function nextDay(day){return new Date(+dateValue(day)+86400000).toISOString().slice(0,10);}
function isoDay(value){return value instanceof Date?localReportDay(value):String(value||'').slice(0,10);}
function amount(value){return value===null||value===undefined||value===''?null:cents(value);}
const fill=argb=>({type:'pattern',pattern:'solid',fgColor:{argb}});
export function normalizeHistoryRow(row){
  const normalized={};
  for(const key of ['Id','FileName','FileHash','PatNum','PatientName','ClaimNumber','PayNum','TotalAmount','Status','Details']){
    const actual=Object.keys(row).find(k=>k.toLowerCase()===key.toLowerCase());normalized[key]=row[actual];
  }
  return normalized;
}
function historyDetails(row){
  let details=row.Details||{};
  if(Buffer.isBuffer(details))details=details.toString('utf8');
  // mysql2 can return JSON columns as objects, whereas TEXT columns return strings.
  for(let i=0;i<2&&typeof details==='string';i++)details=JSON.parse(details);
  if(!details||typeof details!=='object'||Array.isArray(details))throw new Error(`Hồ sơ ${row.Id} thiếu thông tin chi tiết trong lịch sử.`);
  return details;
}

async function recoverReportDetails(pool,row,details){
  const [payments]=await pool.execute('SELECT PayNum AS PayNum,PatNum AS PatNum,PayDate AS PayDate,PayAmt AS PayAmt FROM payment WHERE PayNum=? LIMIT 1',[row.PayNum]);
  const payment=payments[0];
  if(!payment||String(payment.PatNum)!==String(row.PatNum)||amount(payment.PayAmt)!==amount(row.TotalAmount)||!dateValue(isoDay(payment.PayDate)))throw new Error(`Hồ sơ ${row.Id} thiếu ngày hoặc dịch vụ và chưa đối chiếu được khoản thanh toán đã lưu.`);
  const recovered={...details,paymentDate:isoDay(payment.PayDate),carrier:details.carrier||(details.eobPayment?'MetLife':'Chưa xác định')};
  if(Array.isArray(details.procedures)&&details.procedures.length)return recovered;
  const [splits]=await pool.execute(
    `SELECT ps.PatNum AS PatNum,ps.ProcNum AS ProcNum,ps.SplitAmt AS SplitAmt,
            pl.ProcDate AS ProcDate,pl.ProcFee AS ProcFee,pl.ToothNum AS ToothNum,pl.Surf AS Surf,
            pc.ProcCode AS ProcCode,pc.Descript AS Descript
     FROM paysplit ps LEFT JOIN procedurelog pl ON pl.ProcNum=ps.ProcNum
     LEFT JOIN procedurecode pc ON pc.CodeNum=pl.CodeNum WHERE ps.PayNum=? ORDER BY ps.SplitNum`,[row.PayNum]);
  const grouped=new Map();let total=0;
  for(const s of splits){
    const value=amount(s.SplitAmt);
    if(String(s.PatNum)!==String(row.PatNum)||!Number(s.ProcNum)||!s.ProcCode||!dateValue(isoDay(s.ProcDate))||!Number.isSafeInteger(value)||value<0)throw new Error(`Hồ sơ ${row.Id} thiếu dữ liệu dịch vụ liên kết với khoản thanh toán.`);
    total+=value;
    const key=String(s.ProcNum),p=grouped.get(key)||{code:s.ProcCode,date:isoDay(s.ProcDate),tooth:s.ToothNum||'',surface:s.Surf||'',description:s.Descript||'',feeCents:null,benefitCents:0};
    p.benefitCents+=value;grouped.set(key,p);
  }
  if(!grouped.size||total!==amount(payment.PayAmt))throw new Error(`Hồ sơ ${row.Id} thiếu dữ liệu hoặc lệch tổng phân bổ đã lưu.`);
  // The original submitted EOB fee is unknown in a ledger-only recovery. Leave it blank.
  return {...recovered,procedures:[...grouped.values()],ledgerRecovery:true};
}

export function historyIdentity(row,details){
  const carrier=details.carrier||'MetLife';
  const fileKey=row.FileHash?`hash:${row.FileHash}`:`file:${String(row.FileName).toLowerCase()}`;
  const claimKey=JSON.stringify([carrier.toUpperCase(),String(row.PatNum),String(row.ClaimNumber).replace(/\s+/g,' ').trim(),details.paymentDate,amount(row.TotalAmount)]);
  return {paymentKey:`pay:${row.PayNum}`,claimKey,fileKey,sourceKey:JSON.stringify([fileKey,String(row.PatNum),String(row.ClaimNumber)])};
}
function sourceIdentity(row){
  const fileKey=row.FileHash?`hash:${row.FileHash}`:`file:${String(row.FileName).toLowerCase()}`;
  return JSON.stringify([fileKey,String(row.PatNum),String(row.ClaimNumber)]);
}

export async function reportEntry(pool,row){
  row=normalizeHistoryRow(row);
  if(row.Status!=='SUCCESS'||!Number(row.PayNum))throw new Error('Chỉ xuất hồ sơ đã lưu thành công.');
  let details;
  try{details=historyDetails(row);}catch(e){if(!(e instanceof SyntaxError)&&!/^Hồ sơ /.test(e.message))throw e;details={};}
  if(!dateValue(details.paymentDate)||!Array.isArray(details.procedures)||!details.procedures.length)details=await recoverReportDetails(pool,row,details);
  const [procs]=await pool.execute(
    `SELECT pl.ProcNum,pl.ProcDate,pl.ProcFee,pl.ToothNum,pc.ProcCode,pc.Descript
     FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum=pl.CodeNum
     WHERE pl.PatNum=? AND pl.ProcStatus=2`,[row.PatNum]);
  let linked=(details.splits||[]).map(s=>String(s.procNum)).filter(id=>id!=='undefined'&&id!=='0');
  if(details.procedures.some(p=>!dateValue(p.date))&&!linked.length){
    const [savedSplits]=await pool.execute('SELECT ProcNum AS ProcNum FROM paysplit WHERE PayNum=? AND PatNum=?',[row.PayNum,row.PatNum]);
    linked=savedSplits.map(s=>String(s.ProcNum));
  }
  const linkedIds=new Set(linked);
  const procedures=details.procedures.map(p=>{
    const split=(details.splits||[]).filter(s=>s.code===p.code);
    const hasDate=!!dateValue(p.date);
    let candidates=procs.filter(r=>r.ProcCode===p.code&&(hasDate?isoDay(r.ProcDate)===p.date:linkedIds.has(String(r.ProcNum)))&&(p.procNum?String(r.ProcNum)===String(p.procNum):!p.tooth||String(r.ToothNum)===p.tooth||(/^\d+$/.test(String(r.ToothNum))&&/^\d+$/.test(p.tooth)&&Number(r.ToothNum)===Number(p.tooth))||/^Q0[1-4]$/.test(p.tooth)));
    if(candidates.length>1&&split.length)candidates=candidates.filter(r=>split.some(s=>String(s.procNum)===String(r.ProcNum)));
    const match=candidates.length===1?candidates[0]:null;
    return {date:hasDate?p.date:match?isoDay(match.ProcDate):null,code:p.code,treatment:[p.tooth,p.surface,match?.Descript||p.description].filter(Boolean).join(' '),chargeCents:match?amount(match.ProcFee):null,billedCents:p.feeCents??null,paidCents:p.benefitCents??null};
  });
  const paidCents=amount(row.TotalAmount);
  const missingDates=procedures.filter(p=>!dateValue(p.date)).map(p=>p.code);
  if(missingDates.length)throw new Error(`Hồ sơ ${row.Id} chưa xác định được ngày dịch vụ của ${missingDates.join(', ')} từ dịch vụ liên kết với khoản thanh toán.`);
  if(!Number.isSafeInteger(paidCents)||paidCents<=0||procedures.some(p=>!dateValue(p.date)||!Number.isSafeInteger(p.paidCents)||!(Number.isSafeInteger(p.billedCents)||p.billedCents===null))||procedures.reduce((n,p)=>n+p.paidCents,0)!==paidCents)throw new Error(`Hồ sơ ${row.Id} thiếu dữ liệu hoặc lệch tổng tiền; chưa xuất Excel.`);
  return {...historyIdentity(row,details),id:String(row.Id),patNum:row.PatNum,patientName:row.PatientName,carrier:details.carrier||'MetLife',paymentDate:details.paymentDate,paidCents,procedures};
}

function newWorkbook(){
  const wb=new ExcelJS.Workbook();wb.creator='LUK Dental';wb.calcProperties.fullCalcOnLoad=true;
  const sheet=wb.addWorksheet('PAYMENTS',{views:[{state:'frozen',ySplit:1}],pageSetup:{orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0}});
  sheet.columns=[12,10,30,10,44,12,12,13,13,13,13,13,16,26,18].map(width=>({width}));
  sheet.addRow(REPORT_HEADERS);sheet.getRow(1).height=25;
  sheet.getRow(1).eachCell(cell=>{cell.font={name:'Arial',size:10,color:{argb:'FFFF0000'}};cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};cell.border={top:{style:'thin'},bottom:{style:'thin'},left:{style:'thin'},right:{style:'thin'}};});
  sheet.pageSetup.printTitlesRow='1:1';
  wb.addWorksheet('TONG HOP');
  const meta=wb.addWorksheet(META,{state:'veryHidden'});
  meta.addRow(['HistoryId','PaymentKey','ClaimKey','FileKey','SourceKey','PaidCents']);
  return wb;
}

function verifyWorkbook(wb){
  const sheet=wb.getWorksheet('PAYMENTS'),meta=wb.getWorksheet(META);
  if(!sheet||!meta||!wb.getWorksheet('TONG HOP')||meta.getCell('A1').value!=='HistoryId'||REPORT_HEADERS.some((name,i)=>sheet.getRow(1).getCell(i+1).value!==name))throw new Error('File Excel đang có khác mẫu của tool; giữ nguyên file, chưa ghi thêm.');
  return {sheet,meta};
}

function appendEntry(sheet,entry,index){
  const start=sheet.rowCount+1,end=start+entry.procedures.length-1;
  const complete=entry.procedures.every(p=>Number.isSafeInteger(p.chargeCents));
  const charges=complete?entry.procedures.reduce((n,p)=>n+p.chargeCents,0):null;
  entry.procedures.forEach(p=>{
    const row=sheet.addRow([dateValue(p.date),String(entry.patNum),entry.patientName,p.code,p.treatment,p.chargeCents===null?null:p.chargeCents/100,'CREDIT',null,null,null,p.billedCents===null?null:p.billedCents/100,p.paidCents/100,'Đã lưu',entry.carrier,dateValue(entry.paymentDate)]);
    row.height=32;
    for(let col=1;col<=15;col++){
      const cell=row.getCell(col);cell.font={name:'Arial',size:10};cell.alignment={vertical:'middle',wrapText:true,horizontal:[6,8,9,10,11,12].includes(col)?'right':'left'};
      cell.border={bottom:{style:'hair',color:{argb:'FFD0D0D0'}},right:{style:'hair',color:{argb:'FFD0D0D0'}}};
      if(index%2===0)cell.fill=fill(col>=4&&col<=12?'FF00B0E0':'FFFFFF00');
      if([6,8,9,10,11,12].includes(col))cell.numFmt=moneyFormat;
      if([1,15].includes(col))cell.numFmt='mm/dd/yyyy';
    }
  });
  const sameDate=new Set(entry.procedures.map(p=>p.date)).size===1;
  for(const col of [2,3,8,9,10,13,14,15,...(sameDate?[1]:[])]){
    if(end>start)sheet.mergeCells(start,col,end,col);
    sheet.getCell(start,col).alignment={...sheet.getCell(start,col).alignment,vertical:'top'};
  }
  sheet.getCell(start,8).value=entry.paidCents/100;
  sheet.getCell(start,10).value=complete?{formula:`SUM(F${start}:F${end})`,result:charges/100}:null;
  sheet.getCell(start,9).value=complete?{formula:`J${start}-H${start}`,result:(charges-entry.paidCents)/100}:null;
  sheet.getCell(start,10).font={name:'Arial',size:10,bold:true};
  for(let col=1;col<=15;col++)sheet.getCell(end,col).border={...sheet.getCell(end,col).border,bottom:{style:'thin',color:{argb:'FF000000'}}};
  sheet.autoFilter=`A1:O${end}`;sheet.pageSetup.printArea=`A1:O${end}`;
}

function syncReviews(wb,reviews){
  let sheet=wb.getWorksheet('CAN DOI CHIEU');
  if(!sheet&&!reviews.length)return false;
  const values=reviews.map(r=>[String(r.PatNum),r.PatientName||'',r.ClaimNumber||'',r.credit,r.FileName||'',r.reason]);
  const existing=[];sheet?.eachRow((row,i)=>{if(i>1)existing.push(row.values.slice(1,7));});
  if(JSON.stringify(existing)===JSON.stringify(values))return false;
  // Replacing this generated sheet also repairs old files containing repeated headers.
  // ExcelJS spliceRows does not reliably reset the append position of a cleared sheet.
  if(sheet)wb.removeWorksheet(sheet.id);
  sheet=wb.addWorksheet('CAN DOI CHIEU');
  sheet.state=reviews.length?'visible':'hidden';
  sheet.columns=[12,30,24,16,32,65].map(width=>({width}));
  sheet.addRow(['PT NUM','PATIENT NAME','CLAIM','CREDIT','FILE','CẦN ĐỐI CHIẾU']);
  for(const value of values)sheet.addRow(value);
  sheet.eachRow((row,i)=>{row.height=32;row.eachCell(cell=>{cell.font={name:'Arial',size:10,bold:i===1};cell.alignment={vertical:'middle',wrapText:true};});if(i>1)row.getCell(4).numFmt=moneyFormat;});
  return true;
}

function updateSummary(wb,meta,day,reviewCount=0){
  const rows=[];meta.eachRow((row,i)=>{if(i>1)rows.push(row.values);});
  const sheet=wb.getWorksheet('TONG HOP');sheet.columns=[{width:36},{width:24}];
  const values=[['NGÀY QUÉT',dateValue(day)],['SỐ FILE KHÔNG TRÙNG',new Set(rows.map(r=>r[4])).size],['SỐ HỒ SƠ ĐÃ XUẤT',rows.length],['TỔNG THANH TOÁN ĐÃ XUẤT',rows.reduce((n,r)=>n+Number(r[6]),0)/100],['HỒ SƠ CHỜ ĐỐI CHIẾU',reviewCount]];
  for(let i=0;i<values.length;i++){
    const row=sheet.getRow(i+1);row.values=values[i];row.height=26;
    row.eachCell(cell=>{cell.font={name:'Arial',size:11};cell.alignment={vertical:'middle'};});row.getCell(1).font={name:'Arial',size:11,bold:true};
  }
  sheet.getCell('B1').numFmt='mm/dd/yyyy';sheet.getCell('B4').numFmt=moneyFormat;
}

// Read/append/rename as one locked operation. Never delete the previous workbook on failure.
export async function appendDailyWorkbook(pool,rows,filePath,day,{replace=fs.rename}={}){
  await fs.mkdir(path.dirname(filePath),{recursive:true});
  const release=await lockfile.lock(filePath,{realpath:false,retries:0,stale:30000,update:10000});
  let tmp;
  try{
    let original=null,wb;
    try{original=await fs.stat(filePath);wb=new ExcelJS.Workbook();await wb.xlsx.readFile(filePath);}catch(e){if(e.code!=='ENOENT')throw e;wb=newWorkbook();}
    const {sheet,meta}=verifyWorkbook(wb),known=new Set();
    meta.eachRow((r,i)=>{if(i>1)for(const c of [2,3,5])known.add(String(r.getCell(c).value));});
    let appended=0;const reviews=[];
    for(const raw of rows){
      const row=normalizeHistoryRow(raw);
      if(row.Status!=='SUCCESS'||!Number(row.PayNum))continue;
      if(known.has(`pay:${row.PayNum}`))continue;
      let entry;
      try{
        let stored={};try{stored=historyDetails(row);}catch(e){if(!(e instanceof SyntaxError)&&!/^Hồ sơ /.test(e.message))throw e;}
        const identity=historyIdentity(row,stored);
        if([identity.paymentKey,identity.claimKey,identity.sourceKey].some(k=>known.has(k)))continue;
        entry=await reportEntry(pool,row);
        if([entry.paymentKey,entry.claimKey,entry.sourceKey].some(k=>known.has(k)))continue;
      }catch(e){
        // Only record/data errors are isolated. DB/filesystem failures still retry the export.
        if(!(e instanceof SyntaxError)&&!/^Hồ sơ |^Invalid money:|^Money exceeds supported range/.test(e.message))throw e;
        let credit=null;try{const value=amount(row.TotalAmount);if(value!==null)credit=value/100;}catch{}
        reviews.push({...row,credit,reason:e instanceof SyntaxError?'Lịch sử lưu thiếu thông tin chi tiết.':/^Hồ sơ /.test(e.message)?e.message.replace(/^Hồ sơ \S+ /,''):'Thông tin số tiền chưa hợp lệ; cần đối chiếu hồ sơ gốc.'});
        continue;
      }
      appendEntry(sheet,entry,meta.rowCount-1);
      meta.addRow([entry.id,entry.paymentKey,entry.claimKey,entry.fileKey,entry.sourceKey,entry.paidCents]);
      for(const key of [entry.paymentKey,entry.claimKey,entry.sourceKey])known.add(key);
      appended++;
    }
    const reviewSources=new Set();
    const unresolved=reviews.filter(row=>{
      const source=sourceIdentity(row);
      const group=JSON.stringify([String(row.PatNum),String(row.ClaimNumber),row.credit]);
      if(known.has(`pay:${row.PayNum}`)||known.has(source)||reviewSources.has(group))return false;
      reviewSources.add(group);return true;
    });
    const reviewChanged=syncReviews(wb,unresolved);
    if(!appended&&!reviewChanged)return {filePath,appended:0,reviewCount:unresolved.length};
    updateSummary(wb,meta,day,unresolved.length);
    tmp=path.join(path.dirname(filePath),`.${day}.${randomUUID()}.tmp`);
    await fs.writeFile(tmp,Buffer.from(await wb.xlsx.writeBuffer()),{flag:'wx',mode:0o600});
    const current=await fs.stat(filePath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(original?.mtimeMs!==current?.mtimeMs||original?.size!==current?.size)throw new Error('File Excel vừa được thay đổi; sẽ thử ghi lại ở lượt quét sau.');
    await replace(tmp,filePath);tmp=null;
    return {filePath,appended,reviewCount:unresolved.length};
  }finally{if(tmp)await fs.rm(tmp,{force:true}).catch(()=>{});await release();}
}

export async function exportDailyReports(pool,incomingDir,{now=new Date(),startedAt=now,writeWorkbook=appendDailyWorkbook,outputDir=process.env.INSURANCE_EXCEL_DIR||excelOutputDir(incomingDir)}={}){
  const dir=outputDir,pendingDir=path.join(dir,'.pending');
  const days=new Set([localReportDay(now),localReportDay(startedAt)]);
  try{for(const name of await fs.readdir(pendingDir))if(DATE.test(name)&&dateValue(name))days.add(name);}catch(e){if(e.code!=='ENOENT')throw e;}
  const reports=[],errors=[],reviews=[];
  for(const day of [...days].sort()){
    try{
      await fs.mkdir(pendingDir,{recursive:true});
      const marker=path.join(pendingDir,day);await fs.writeFile(marker,'',{mode:0o600});
      const [rows]=await pool.execute(
        `SELECT Id,FileName,FileHash,PatNum,PatientName,ClaimNumber,PayNum,TotalAmount,Status,Details
         FROM luk_metlife_history WHERE Status='SUCCESS' AND PayNum>0 AND ProcessedAt>=? AND ProcessedAt<? ORDER BY Id`,
        [`${day} 00:00:00`,`${nextDay(day)} 00:00:00`]);
      if(!Array.isArray(rows))throw new Error('Không đọc được lịch sử xuất Excel.');
      if(rows.length){
        const result=await writeWorkbook(pool,rows,path.join(dir,`${day}.xlsx`),day);reports.push(result);
        const saved=await fs.stat(result.filePath);
        if(!saved.isFile()||saved.size===0)throw new Error(`Chưa tạo được file Excel: ${result.filePath}`);
        if(result.appended||result.reviewCount)console.log(`[Excel] Đã cập nhật báo cáo: ${path.resolve(result.filePath)} (${saved.size} bytes) | Thêm ${result.appended} hồ sơ | ${result.reviewCount||0} hồ sơ cần đối chiếu.`);
        if(result.reviewCount){
          reviews.push({day,count:result.reviewCount});
          console.warn(`[Excel] Báo cáo ${day}: ${result.reviewCount} hồ sơ thiếu dữ liệu nằm trong tab CAN DOI CHIEU. Các hồ sơ đủ dữ liệu vẫn được xuất; không chạy lại thanh toán.`);
          continue;
        }
      }
      await fs.rm(path.join(pendingDir,day),{force:true});
    }catch(e){
      const message=['EPERM','EACCES','EBUSY'].includes(e.code)
        ?`Windows chưa cho ghi file ${day}.xlsx (${e.code}). Hãy đóng file này trên các máy đang mở Excel; nếu vẫn lỗi, kiểm tra quyền ghi thư mục EXCEL`
        :e.message;
      errors.push({day,message});console.warn(`[Excel] Chưa cập nhật báo cáo ${day}: ${message}. Sẽ thử lại; không chạy lại thanh toán.`);
    }
  }
  return {status:errors.length?'pending':reviews.length?'review':'ok',reports,errors,reviews};
}
