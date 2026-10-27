import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {prepareInsuranceSettlement,applyInsuranceSettlement,verifyInsuranceSettlement,verifiedInsurancePayment,recordInsuranceResult,reviewError,procedureDay} from './insuranceSettlement.js';
import { extractPdf, parseMetlife } from './parser.js';
import { nativeSplitHashes } from './nativeSplitHashes.js';
import {planMissingProcedures,createMissingProcedures} from './missingProcedures.js';
import {procedureCandidates} from './procedureIdentity.js';
import { odSecurityLogHash } from './directPayment.js';
import {metlifePaymentFields,claimDocumentFields} from './paymentFormat.js';
import {documentInsert} from './documentImport.js';
import {readInsuranceDocument,isInsuranceFile,isImageFile,imagePdf} from '../liberty/document.js';
import {exportDailyReports} from './dailyExcel.js';

let isScanning = false;
let autoScanIntervalId = null;
let lastScanTime = null;
let lastScanResult = null;

export function insuranceIncomingDirs(dir){
  const candidates=[dir,...['LIBERTY','CIGNA','DELTA DENTAL'].map(name=>path.join(path.dirname(dir),name))];
  return candidates.filter((candidate,i)=>candidates.findIndex(other=>other.toLowerCase()===candidate.toLowerCase())===i);
}

export async function ensureMetlifeHistoryTable(pool) {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS luk_metlife_history (
        Id INT AUTO_INCREMENT PRIMARY KEY,
        FileName VARCHAR(255) NOT NULL,
        FileHash VARCHAR(64) NOT NULL,
        PatNum INT NOT NULL,
        PatientName VARCHAR(255) NOT NULL,
        ClaimNumber VARCHAR(64) NOT NULL,
        CheckNumber VARCHAR(64) DEFAULT '',
        TotalAmount DECIMAL(10,2) NOT NULL,
        ProceduresCount INT DEFAULT 0,
        FeesUpdated VARCHAR(500) DEFAULT '',
        PayNum INT DEFAULT 0,
        DocNum INT DEFAULT 0,
        Status VARCHAR(32) NOT NULL,
        Message TEXT,
        Details TEXT,
        CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        ProcessedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_patnum (PatNum),
        INDEX idx_filehash (FileHash),
        INDEX idx_status (Status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (err) {
    console.warn('[MetLife Auto-Processor] Could not ensure history table:', err.message);
  }
}

export async function resolvePatient(pool, { fileName, parsed }) {
  // 1. Try matching PatNum directly from filename (e.g. 1307.pdf, 1307_eob.pdf)
  const patientFile = fileName.replace(/^\d{13}_(?=\d+(?:[_.]|$))/, '');
  const numMatch = patientFile.match(/^(\d+)/) || fileName.match(/[^\d](\d{3,7})[^\d]/) || fileName.match(/(\d{3,7})\.pdf$/i);
  if (numMatch) {
    const patNum = Number.parseInt(numMatch[1], 10);
    const [rows] = await pool.execute(
      'SELECT PatNum, FName, LName, ClinicNum, PriProv, ImageFolder FROM patient WHERE PatNum = ?',
      [patNum]
    );
    if (rows.length === 1) {
      return rows[0];
    }
  }

  // 2. Try matching from parsed EOB patient name
  if (parsed.patient) {
    const rawName = parsed.patient.trim();
    let fname = '', lname = '';
    if (rawName.includes(',')) {
      const parts = rawName.split(',').map((s) => s.trim());
      lname = parts[0];
      fname = parts[1]?.split(' ')[0] || '';
    } else {
      const parts = rawName.split(/\s+/);
      fname = parts[0] || '';
      lname = parts.slice(1).join(' ') || '';
    }

    if (fname && lname) {
      const [byName] = await pool.execute(
        `SELECT PatNum, FName, LName, ClinicNum, PriProv, ImageFolder FROM patient
         WHERE (LName LIKE ? AND FName LIKE ?) OR (LName LIKE ? AND FName LIKE ?)
         LIMIT 5`,
        [`%${lname}%`, `%${fname}%`, `%${fname}%`, `%${lname}%`]
      );
      if (byName.length === 1) {
        return byName[0];
      }
      if (byName.length > 1 && parsed.group) {
        // Disambiguate using group number
        const patIds = byName.map((r) => r.PatNum);
        const [matched] = await pool.execute(
          `SELECT p.PatNum, p.FName, p.LName, p.ClinicNum, p.PriProv, p.ImageFolder
           FROM patient p
           JOIN patplan pp ON pp.PatNum = p.PatNum
           JOIN inssub s ON s.InsSubNum = pp.InsSubNum
           JOIN insplan ip ON ip.PlanNum = s.PlanNum
           WHERE p.PatNum IN (${patIds.map(() => '?').join(',')}) AND ip.GroupNum LIKE ?
           LIMIT 1`,
          [...patIds, `%${parsed.group}%`]
        );
        if (matched.length === 1) {
          return matched[0];
        }
      }
    }
  }

  throw new Error(`Không xác định được bệnh nhân trong Open Dental cho file: ${fileName} (Tên: ${parsed.patient || 'N/A'})`);
}

export async function importPdfToAtoZ(pool, { patient, fileBytes, fileName, claimNumber, paymentDate, amountCents, carrier = 'MetLife' }) {
  const {description,dateCreated}=claimDocumentFields(claimNumber,paymentDate,amountCents);
  const [prefs]=await pool.execute("SELECT PrefName, ValueString FROM preference WHERE LOWER(PrefName) IN ('docpath','atozfolderused','atozfolder','imagestore')");
  const pref=name=>prefs.find(r=>r.PrefName.toLowerCase()===name)?.ValueString;
  const root=pref('docpath')||pref('atozfolder');
  if(String(pref('atozfolderused')??pref('imagestore')??'').trim()!=='1')throw new Error('Import Finished Claims cần chế độ LocalAtoZ (1).');
  if(!root)throw new Error('Chưa cấu hình thư mục AtoZ; chưa lưu PDF hoặc thanh toán.');
  // Never create a new image root from an invalid/misspelled shared path.
  const base=await fs.realpath(root);
  const [cats]=await pool.execute("SELECT DefNum FROM definition WHERE Category = 18 AND IsHidden = 0 AND UPPER(TRIM(ItemName)) IN ('FINISHED CLAM','FINISHED CLAIMS') ORDER BY ItemOrder,DefNum LIMIT 2");
  if(cats.length!==1)throw new Error('Cần đúng một thư mục FINISHED CLAM / FINISHED CLAIMS đang hiện trong Imaging.');
  const [columns]=await pool.execute("SELECT COLUMN_NAME,COLUMN_DEFAULT,IS_NULLABLE,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='document' ORDER BY ORDINAL_POSITION");
  // Validate schema before creating the patient directory or copying a PDF.
  documentInsert({DocCategory:cats[0].DefNum,PatNum:patient.PatNum,FileName:'pending.pdf',Description:description,DateCreated:dateCreated},columns);
  let folder=patient.ImageFolder;
  if(!folder){
    folder=`${(patient.LName||'PT').slice(0,5)}${(patient.FName||'').slice(0,3)}${patient.PatNum}`.replace(/[^a-zA-Z0-9]/g,'');
    await pool.execute('UPDATE patient SET ImageFolder = ? WHERE PatNum = ?',[folder,patient.PatNum]);
  }
  if(/[\\/]/.test(folder)||['.','..'].includes(folder))throw new Error('Thư mục ảnh bệnh nhân không hợp lệ.');
  const destDir=path.join(base,folder[0].toUpperCase(),folder);
  await fs.mkdir(destDir,{recursive:true});
  const resolvedDir=await fs.realpath(destDir),relative=path.relative(base,resolvedDir);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Thư mục ảnh bệnh nhân nằm ngoài AtoZ.');
  const sourceExtension=/\.txt$/i.test(fileName)?'txt':'pdf';
  const safeClaim=claimNumber.replace(/[^a-zA-Z0-9]/g,'_');
  const prefix=carrier==='DELTA DENTAL'?'DELTA':carrier==='CIGNA'?'CIGNA':carrier==='LIBERTY Dental Plan'?'LIBERTY':'METLIFE';
  const [existingDocs]=await pool.execute('SELECT DocNum,FileName FROM document WHERE PatNum=? AND DocCategory=? AND Description=? AND DateCreated=? AND FileName LIKE ? ORDER BY DocNum DESC LIMIT 5',[patient.PatNum,cats[0].DefNum,description,dateCreated,`${prefix}_%`]);
  for(const doc of existingDocs){
    if(!doc.FileName||/[\\/]/.test(doc.FileName))continue;
    const existingPath=path.join(resolvedDir,doc.FileName);
    try{
      const real=await fs.realpath(existingPath);if(path.dirname(real)!==resolvedDir)continue;
      if((await fs.readFile(real)).equals(fileBytes))return {docNum:doc.DocNum,savedPath:real,description,dateCreated,reused:true};
    }catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const destFileName=`${prefix}_${safeClaim}_${paymentDate}_${randomUUID()}.${sourceExtension}`;
  const fullDestPath=path.join(resolvedDir,destFileName);
  await fs.writeFile(fullDestPath,fileBytes,{flag:'wx'});
  const statement=documentInsert({DocCategory:cats[0].DefNum,PatNum:patient.PatNum,FileName:destFileName,Description:description,DateCreated:dateCreated},columns);
  const [docRes]=await pool.execute(statement.sql,statement.values);
  if(!docRes.insertId)throw new Error('Không nhận được mã tài liệu Finished Claims; chưa ghi thanh toán.');
  return {docNum:docRes.insertId,savedPath:fullDestPath,description,dateCreated};
}

export async function autoPopulateProcedureFees(db, { patNum, eobProcedures, dbProcs, settlement }) {
  const procs = dbProcs || (await db.execute(
    `SELECT procedurelog.ProcNum, procedurelog.ProcDate, procedurelog.ProcFee, procedurecode.ProcCode, procedurelog.CodeNum
     FROM procedurelog
     JOIN procedurecode ON procedurecode.CodeNum = procedurelog.CodeNum
     WHERE procedurelog.PatNum = ? AND procedurelog.ProcStatus = 2`,
    [patNum]
  ))[0];

  const updatedFees = [];

  for (const item of eobProcedures) {
    if (!item.code || !item.benefitCents || item.benefitCents <= 0) continue;
    const splitFee = (item.benefitCents / 100).toFixed(2);

    // Find matching completed procedure
    let match = item.procNum ? procs.find(p=>p.ProcNum===item.procNum) : procs.find(
      (p) => p.ProcCode === item.code && (!item.date || (p.ProcDate?.toISOString?.()?.slice(0, 10) || String(p.ProcDate).slice(0, 10)) === item.date)
    );
    if (!match && !item.procNum) {
      match = procs.find((p) => p.ProcCode === item.code);
    }

    if (match) {
      await db.execute('UPDATE procedurelog SET ProcFee = ? WHERE ProcNum = ?', [splitFee, match.ProcNum]);
      if(settlement){
        const ids=settlement.rows.filter(r=>String(r.ProcNum)===String(match.ProcNum)).map(r=>r.ClaimProcNum);
        if(ids.length)await db.execute(`UPDATE claimproc SET FeeBilled=? WHERE PatNum=? AND ClaimProcNum IN (${ids.map(()=>'?').join(',')})`,[splitFee,patNum,...ids]);
      }else await db.execute('UPDATE claimproc SET FeeBilled = ? WHERE ProcNum = ?', [splitFee, match.ProcNum]);
      updatedFees.push(`${item.code}: $${splitFee}`);
      match.ProcFee = splitFee;
    }
  }

  // Any procedure not in EOB (or without benefit, like unsent bitewings/panoramic/periapicals): keep at 0.00
  for (const p of procs) {
    const isEob = eobProcedures.some((ep) => (ep.procNum ? ep.procNum===p.ProcNum : ep.code === p.ProcCode) && ep.benefitCents > 0);
    if (!isEob) {
      await db.execute('UPDATE procedurelog SET ProcFee = 0.00 WHERE ProcNum = ?', [p.ProcNum]);
      if(settlement){
        const ids=settlement.rows.filter(r=>String(r.ProcNum)===String(p.ProcNum)).map(r=>r.ClaimProcNum);
        if(ids.length)await db.execute(`UPDATE claimproc SET FeeBilled=0 WHERE PatNum=? AND ClaimProcNum IN (${ids.map(()=>'?').join(',')})`,[patNum,...ids]);
      }else await db.execute('UPDATE claimproc SET FeeBilled = 0.00 WHERE ProcNum = ?', [p.ProcNum]);
      p.ProcFee = '0.00';
    }
  }

  // Update claim.ClaimFee if claim exists
  const claims=settlement?settlement.claimIds.map(ClaimNum=>({ClaimNum})):(await db.execute('SELECT ClaimNum FROM claim WHERE PatNum = ?', [patNum]))[0];
  for (const c of claims) {
    const [sums] = await db.execute(
      'SELECT SUM(FeeBilled) AS TotalFee FROM claimproc WHERE ClaimNum = ?',
      [c.ClaimNum]
    );
    const totalFee = sums[0]?.TotalFee;
    if (totalFee !== null && totalFee !== undefined) {
      await db.execute('UPDATE claim SET ClaimFee = ? WHERE ClaimNum = ?', [totalFee, c.ClaimNum]);
    }
  }

  // Re-calculate patient balance (BalTotal)
  const [balRes] = await db.execute(
    'SELECT SUM(ProcFee) AS TotalCharges FROM procedurelog WHERE PatNum = ? AND ProcStatus = 2',
    [patNum]
  );
  const [payRes] = await db.execute(
    'SELECT SUM(SplitAmt) AS TotalPaid FROM paysplit WHERE PatNum = ?',
    [patNum]
  );
  const totalCharges = Number(balRes[0]?.TotalCharges || 0);
  const totalPaid = Number(payRes[0]?.TotalPaid || 0);
  const newBal = (totalCharges - totalPaid).toFixed(2);
  await db.execute('UPDATE patient SET BalTotal = ? WHERE PatNum = ?', [newBal, patNum]);

  return updatedFees;
}

export async function processSinglePdf(pool, filePath, {extract = extractPdf, hashSplits = nativeSplitHashes, convertPdf} = {}) {
  const fileName = path.basename(filePath);
  console.log(`\n[Auto-Processor] Bắt đầu xử lý: ${fileName}...`);
  if(path.basename(path.dirname(filePath)).toUpperCase()==='CIGNA'&&isImageFile(fileName))throw Object.assign(new Error('CIGNA hiện cần PDF có chữ theo mẫu đã hỗ trợ; chưa xử lý ảnh CIGNA.'),{code:'EOB_REVIEW_REQUIRED'});

  if((await fs.stat(filePath)).size>30*1024*1024)throw Object.assign(new Error('Tài liệu EOB vượt quá 30 MB.'),{code:'EOB_REVIEW_REQUIRED'});
  const sourceBytes = await fs.readFile(filePath);
  let document;
  try{
    if(/\.txt$/i.test(fileName)){
      const {readInsuranceTextDocument}=await import('./textDocument.js');
      document=readInsuranceTextDocument(sourceBytes);
    }else if(/\.pdf$/i.test(fileName)&&(convertPdf||extract===extractPdf)){
      const {readPdfAsText}=await import('./pdfToText.js');
      document=await readPdfAsText(sourceBytes,filePath,convertPdf?{convert:convertPdf}:{});
    }else if(path.basename(path.dirname(filePath)).toUpperCase()==='DELTA DENTAL'){
      const {readDeltaDocument}=await import('../delta/document.js');
      document=await readDeltaDocument(sourceBytes,fileName,{extract});
    }else document=await readInsuranceDocument(sourceBytes,fileName,{extract});
  }
  catch(e){if(isImageFile(fileName))e.code='EOB_REVIEW_REQUIRED';throw e;}
  const {extracted,pdfBytes:fileBytes}=document;
  const fullText = extracted.pages.map((p) => p.lines.map((r) => r.text).join('\n')).join('\n');

  if(extracted.textCarrier==='DELTA DENTAL'||(!extracted.textCarrier&&path.basename(path.dirname(filePath)).toUpperCase()==='DELTA DENTAL')){
    const {processDeltaPdf}=await import('../delta/processor.js');
    return processDeltaPdf(pool,{filePath,fileName,fileBytes,extracted},{hashSplits});
  }

  if(extracted.textCarrier==='CIGNA'||(!extracted.textCarrier&&path.basename(path.dirname(filePath)).toUpperCase()==='CIGNA')||(/Claim\/Reference Number:/.test(fullText)&&/Claim Amount Paid:/.test(fullText)&&/Date Processed:/.test(fullText))){
    const {processCignaPdf}=await import('../cigna/processor.js');
    return processCignaPdf(pool,{filePath,fileName,fileBytes,extracted},{hashSplits});
  }

  // Carrier auto-detection: Liberty vs MetLife
  const isLiberty = /LIBERTY Dental Plan/i.test(fullText) || /PAYMENT DETAILS/i.test(fullText);
  if (isLiberty) {
    const { processLibertyPdf } = await import('../liberty/processor.js');
    return await processLibertyPdf(pool, { filePath, fileName, fileBytes, extracted },{hashSplits});
  }

  if(extracted.ocr)throw Object.assign(new Error('Ảnh/PDF scan chưa xác nhận được là EOB Liberty; cần đối chiếu tài liệu gốc.'),{code:'EOB_REVIEW_REQUIRED'});
  const parsed = parseMetlife(extracted);

  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`Lỗi định dạng MetLife: ${parsed.errors.join('; ')}`);
  }

  // 1. Resolve Patient
  const patient = await resolvePatient(pool, { fileName, parsed });
  const patNum = patient.PatNum;
  const clinicNum = patient.ClinicNum || 0;
  const provNum = patient.PriProv || 1;
  const paymentFields = metlifePaymentFields(parsed);
  const claimNumber = paymentFields.claimNumber;
  const groupNum = parsed.group || '';
  const eobDate = paymentFields.date;
  const totalBenefit = (parsed.benefitCents / 100).toFixed(2);

  console.log(`[MetLife Auto-Processor] Bệnh nhân: ${patient.LName}, ${patient.FName} (#${patNum})`);
  console.log(`[MetLife Auto-Processor] Claim / Check: ${claimNumber} | Tổng tiền: $${totalBenefit}`);

  // 3. Find matching procedures in DB for splits
  const [completedProcs] = await pool.execute(
    `SELECT procedurelog.ProcNum, procedurelog.ProcDate, procedurelog.ProcFee, procedurelog.ProvNum, procedurelog.ClinicNum, procedurelog.ToothNum, procedurelog.Surf, procedurecode.ProcCode, procedurecode.Descript
     FROM procedurelog
     JOIN procedurecode ON procedurecode.CodeNum = procedurelog.CodeNum
     WHERE procedurelog.PatNum = ? AND procedurelog.ProcStatus = 2`,
    [patNum]
  );

  const missingPlan=planMissingProcedures(completedProcs,parsed.procedures,{metlife:true});
  const dbProcs=missingPlan.procs;

  const splitsPlan = [],matchedProcedures=new Map();
  for (const eobProc of parsed.procedures) {
    if (!eobProc.benefitCents || eobProc.benefitCents <= 0) continue;
    const splitAmount = (eobProc.benefitCents / 100).toFixed(2);

    const byDate=dbProcs.filter(p=>p.ProcCode===eobProc.code&&(!eobProc.date||procedureDay(p.ProcDate)===eobProc.date));
    const matches=procedureCandidates(byDate,eobProc,parsed.procedures,{metlife:true});
    if(matches.length!==1)throw reviewError(`${eobProc.code}: chưa khớp duy nhất dịch vụ hoàn tất theo ngày; cần đối chiếu.`);
    const match=matches[0];
    if([...matchedProcedures.values()].some(p=>String(p.ProcNum)===String(match.ProcNum)))throw reviewError(`${eobProc.code}: nhiều dòng đang khớp cùng một dịch vụ; cần đối chiếu vùng hàm.`);
    matchedProcedures.set(eobProc,match);
    splitsPlan.push({
      ProcNum: match ? match.ProcNum : 0,
      ProvNum: match?.ProvNum || provNum,
      ClinicNum: match?.ClinicNum || clinicNum,
      date: eobProc.date || eobDate,
      amount: splitAmount,
      amountCents: eobProc.benefitCents,
      code: eobProc.code,
      desc: match?.Descript || `MetLife ${eobProc.code}`
    });
  }

  let settlement=await prepareInsuranceSettlement(pool,{patNum,carrier:'MetLife',procedures:parsed.procedures,dbProcs,splits:splitsPlan});
  let existing=await verifiedInsurancePayment(pool,{patNum,claimNumber,date:eobDate,amountCents:parsed.benefitCents,splits:splitsPlan});
  const addedProcedures=await createMissingProcedures(pool,{plan:missingPlan,patient,claimNumber,carrier:'MetLife'});
  for(const p of addedProcedures)console.log(`[MetLife Auto-Processor] Claim #${claimNumber}: ${p.reused?'dùng lại':'đã thêm'} dịch vụ ${p.code}, ProcNum: ${p.procNum}${p.newCode?' (đã thêm mã vào danh mục)':''}.`);
  if(addedProcedures.length){
    for(const split of splitsPlan){const added=addedProcedures.find(p=>p.oldId===split.ProcNum);if(added){const row=dbProcs.find(p=>String(p.ProcNum)===String(added.procNum));Object.assign(split,{ProcNum:row.ProcNum,ProvNum:row.ProvNum,ClinicNum:row.ClinicNum||0});}}
    settlement=await prepareInsuranceSettlement(pool,{patNum,carrier:'MetLife',procedures:parsed.procedures,dbProcs,splits:splitsPlan});
    existing=await verifiedInsurancePayment(pool,{patNum,claimNumber,date:eobDate,amountCents:parsed.benefitCents,splits:splitsPlan});
  }
  // 2. Import PDF to AtoZ Finished Claims
  const aToZResult = await importPdfToAtoZ(pool, {
    patient,
    fileBytes,
    fileName,
    claimNumber,
    paymentDate: eobDate,
    amountCents: parsed.benefitCents
  });

  const updatedFees=existing?[]:await autoPopulateProcedureFees(pool,{patNum,eobProcedures:parsed.procedures.map(p=>({...p,procNum:matchedProcedures.get(p)?.ProcNum})),dbProcs:dbProcs.filter(p=>settlement.procIds.includes(String(p.ProcNum))),settlement});

  // 4. Generate SecurityHash for each split
  const hashPlan = {
    patNum,
    date: eobDate,
    splits: splitsPlan
  };
  const hashes = existing?[]:await hashSplits(hashPlan);
  hashes.forEach((h, idx) => {
    splitsPlan[idx].SecurityHash = h;
  });

  // 5. Select Payment Type (prefer Insurance Paid or Check)
  const [payTypes] = await pool.execute(
    'SELECT DefNum, ItemName FROM definition WHERE Category = 10 AND IsHidden = 0 ORDER BY ItemOrder'
  );
  const selectedPayType =
    payTypes.find((t) => /ins/i.test(t.ItemName)) ||
    payTypes.find((t) => /check/i.test(t.ItemName)) ||
    payTypes[0] ||
    { DefNum: 10, ItemName: 'Insurance Paid' };

  // 6. DB Transaction with LOCK TABLES for MariaDB MyISAM integrity
  const conn = await pool.getConnection();
  let payNum = 0;

  try {
    await conn.query(
      'LOCK TABLES payment WRITE, paysplit WRITE, securitylog WRITE, securityloghash WRITE, claimproc WRITE, claim WRITE, patient WRITE'
    );

    await verifyInsuranceSettlement(conn,settlement);
    const previous=await verifiedInsurancePayment(conn,{patNum,claimNumber,date:eobDate,amountCents:parsed.benefitCents,splits:splitsPlan});
    if(previous){payNum=previous.PayNum;console.log(`[MetLife Auto-Processor] Claim #${claimNumber}: đã xác minh Payment #${payNum}; giữ nguyên khoản đã lưu.`);}
    else {
     if(existing)throw reviewError('Khoản đã lưu thay đổi sau đối chiếu; chưa tạo lại thanh toán.');
    // Insert Payment
    const payNote = paymentFields.note;
    const [payRes] = await conn.execute(
      `INSERT INTO payment (
        PayType, PayDate, PayAmt, CheckNum, BankBranch, PayNote, IsSplit, PatNum,
        ClinicNum, DateEntry, DepositNum, Receipt, IsRecurringCC, SecUserNumEntry,
        PaymentSource, ProcessStatus, RecurringChargeDate, ExternalId, PaymentStatus,
        IsCcCompleted, MerchantFee
      ) VALUES (?, ?, ?, ?, '', ?, 1, ?, ?, CURDATE(), 0, '', 0, 0, 0, 0, '0001-01-01', ?, 0, 0, 0.00)`,
      [selectedPayType.DefNum, eobDate, totalBenefit, paymentFields.checkNum, payNote, patNum, clinicNum, claimNumber]
    );
    payNum = payRes.insertId;

    // Insert PaySplits
    for (const split of splitsPlan) {
      await conn.execute(
        `INSERT INTO paysplit (
          SplitAmt, PatNum, ProcDate, DatePay, ProcNum, ProvNum, ClinicNum, PayNum,
          DateEntry, SecUserNumEntry, SecurityHash, UnearnedType, IsDiscount, DiscountType,
          PayPlanNum, FSplitNum, AdjNum, PayPlanChargeNum, PayPlanDebitType
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), 0, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
        [split.amount, patNum, split.date, eobDate, split.ProcNum, split.ProvNum, split.ClinicNum, payNum, split.SecurityHash]
      );

    }

    // Audit SecurityLog & SecurityLogHash
    const logText = `Payment created for ${patient.LName}, ${patient.FName} with payment type '${selectedPayType.ItemName}', amount '$${totalBenefit}'`;
    const [logRes] = await conn.execute(
      `INSERT INTO securitylog (
        PermType, UserNum, LogText, PatNum, CompName, DateTPrevious
      ) VALUES (15, 0, ?, ?, ?, '0001-01-01 00:00:00')`,
      [logText, patNum, os.hostname().slice(0, 255)]
    );
    const securityLogNum = logRes.insertId;

    const [logRows] = await conn.execute(
      "SELECT PermType, UserNum, DATE_FORMAT(LogDateTime,'%Y-%m-%d %H:%i:%s') AS LogDateTime, LogText, PatNum, IFNULL(DATE_FORMAT(DateTPrevious,'%Y-%m-%d %H:%i:%s'),'') AS DateTPrevious FROM securitylog WHERE SecurityLogNum = ?",
      [securityLogNum]
    );
    if (logRows.length === 1) {
      const row = logRows[0];
      const logHash = odSecurityLogHash({
        permType: row.PermType,
        userNum: row.UserNum,
        logDateTime: row.LogDateTime,
        logText: row.LogText,
        patNum: row.PatNum,
        dateTPrevious: row.DateTPrevious
      });
      await conn.execute(
        'INSERT INTO securityloghash (SecurityLogNum, LogHash) VALUES (?, ?)',
        [securityLogNum, logHash]
      );
    }

    }
    await applyInsuranceSettlement(conn,settlement,eobDate);
    await conn.query('UNLOCK TABLES');
  } finally {
    try { await conn.query('UNLOCK TABLES'); } catch {}
    conn.release();
  }

  // 7. Move file to PROCESSED
  const incomingDir = path.dirname(filePath);
  const processedDir = path.join(incomingDir, 'PROCESSED');
  await fs.mkdir(processedDir, { recursive: true });
  const archivePath = path.join(processedDir, `${Date.now()}_${fileName}`);

  // 8. Record in luk_metlife_history
  const details = JSON.stringify({
    patient: `${patient.LName}, ${patient.FName}`,
    patNum,
    claimNumber,
    groupNum,
    payNum,
    docNum: aToZResult.docNum,
    totalBenefit,
    updatedFees,
    addedProcedures,
    insuranceDefaults:{estimate:0,writeOff:0,claimNums:settlement.claimIds,claimProcNums:settlement.rows.map(r=>r.ClaimProcNum)},
    splits: splitsPlan.map((s) => ({ code: s.code, amount: s.amount, procNum: s.ProcNum })),
    paymentDate: eobDate,
    paymentNote: paymentFields.note,
    paymentCheckNum: paymentFields.checkNum,
    sourceFormat:extracted.sourceFormat||'pdf',
    generatedTextPath:extracted.generatedTextPath,
    converter:extracted.converter,
    documentDescription: aToZResult.description,
    documentDate: aToZResult.dateCreated,
    eobPayment: parsed.payment || null,
    subscriber: parsed.subscriber || '',
    procedures: (parsed.procedures || []).map((p) => ({
      procNum:matchedProcedures.get(p)?.ProcNum,
      code: p.code,
      date: p.date || '',
      tooth: p.tooth || '',
      surface:p.surface||'',
      status: p.status || '',
      feeCents: p.feeCents ?? null,
      benefitCents: p.benefitCents || 0,
      remarks: p.remarks || []
    })),
    archivePath
  });

  const feesUpdatedStr = updatedFees.join(', ') || 'Không cần bù (đã có phí)';

  await recordInsuranceResult(pool,
    [
      fileName,
      extracted.sha256,
      patNum,
      `${patient.LName}, ${patient.FName}`,
      claimNumber,
      claimNumber,
      totalBenefit,
      splitsPlan.length,
      feesUpdatedStr,
      payNum,
      aToZResult.docNum,
      `Đã tự động import Finished Claims và ghi thanh toán $${totalBenefit} vào Open Dental.`,
      details
    ]
  );

  await fs.rename(filePath,archivePath);

  console.log(`[MetLife Auto-Processor] ✓ HOÀN THÀNH: ${fileName} -> PayNum: ${payNum}, DocNum: ${aToZResult.docNum}`);
  return {
    success: true,
    fileName,
    patNum,
    payNum,
    docNum: aToZResult.docNum,
    amount: totalBenefit,
    feesUpdated: feesUpdatedStr
  };
}

export async function scanIncomingFolder(pool, incomingDir, {processFile=processSinglePdf,exportReports=exportDailyReports}={}) {
  if (isScanning) {
    return { status: 'busy', message: 'Quá trình quét đang diễn ra.' };
  }

  isScanning = true;
  lastScanTime = new Date().toISOString();
  await ensureMetlifeHistoryTable(pool);

  try {
    const candidateDirs = insuranceIncomingDirs(incomingDir);

    const allPdfFiles = [];

    for (const cDir of candidateDirs) {
      try {
        await fs.access(cDir);
      } catch {
        try {
          await fs.mkdir(cDir, { recursive: true });
        } catch {}
      }

      let entries = [];
      try {
        entries = await fs.readdir(cDir, { withFileTypes: true });
      } catch {}

      let pdfs = entries.filter((e) => e.isFile() && isInsuranceFile(e.name));

      // ERRORS/REVIEW require an explicit retry. Replaying automatically can
      // repeatedly revisit the first successful claim in a multi-patient file.
      for (const p of pdfs) {
        const stat=await fs.stat(path.join(cDir,p.name));
        if(Date.now()-stat.mtimeMs<3000)continue;
        allPdfFiles.push({
          fullPath: path.join(cDir, p.name),
          fileName: p.name,
          dir: cDir
        });
      }
    }

    if (allPdfFiles.length === 0) {
      const emptyRes = { status: 'idle', count: 0, results: [] };
      lastScanResult = emptyRes;
      return emptyRes;
    }

    console.log(`[Auto-Processor] Phát hiện ${allPdfFiles.length} file EOB mới cần xử lý (MetLife / Liberty / CIGNA / Delta Dental)...`);
    const results = [];

    for (const file of allPdfFiles) {
      try {
        const res = await processFile(pool, file.fullPath);
        results.push(res);
      } catch (err) {
        console.error(`[Auto-Processor] ✗ Lỗi khi xử lý ${file.fileName}:`, err.message);

        // Move to ERRORS
        try {
          const errorsDir = path.join(file.dir, err.code==='EOB_REVIEW_REQUIRED'?'REVIEW':'ERRORS');
          await fs.mkdir(errorsDir, { recursive: true });
          await fs.rename(file.fullPath, path.join(errorsDir, `${Date.now()}_${file.fileName}`));
        } catch {}

        // Record failure
        try {
          await pool.execute(
            `INSERT INTO luk_metlife_history (
              FileName, FileHash, PatNum, PatientName, ClaimNumber, CheckNumber,
              TotalAmount, ProceduresCount, FeesUpdated, PayNum, DocNum, Status,
              Message, Details, ProcessedAt
            ) VALUES (?, '', 0, 'Chưa rõ', '', '', 0.00, 0, '', 0, 0, ?, ?, '', NOW())`,
            [file.fileName,err.code==='EOB_REVIEW_REQUIRED'?'REVIEW':'FAILED',`Lỗi xử lý tự động: ${err.message}`]
          );
        } catch {}

        results.push({
          success: false,
          fileName: file.fileName,
          error: err.message
        });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    console.log(`[Auto-Processor] ✓ QUÉT HOÀN TẤT: ${results.length} file, ${succeeded} thành công, ${results.length - succeeded} lỗi.`);
    const finalRes = { status: 'completed', count: results.length, results };
    lastScanResult = finalRes;
    return finalRes;
  } finally {
    try{
      const excel=await exportReports(pool,incomingDir,{startedAt:new Date(lastScanTime)});
      if(lastScanResult)lastScanResult.excel=excel;
    }catch(e){console.warn(`[Excel] Chưa cập nhật báo cáo: ${e.message}. Thanh toán đã lưu không bị chạy lại.`);}
    finally{isScanning = false;}
  }
}

export async function getProcessorStatus(pool, incomingDir) {
  const dir = incomingDir || process.env.METLIFE_INCOMING_DIR || 'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const candidateDirs = insuranceIncomingDirs(dir);

  let incomingCount = 0;
  let processedCount = 0;
  let errorsCount = 0;
  let reviewCount = 0;

  for (const cDir of candidateDirs) {
    try {
      const entries = await fs.readdir(cDir, { withFileTypes: true });
      incomingCount += entries.filter((e) => e.isFile() && isInsuranceFile(e.name)).length;
    } catch {}

    try {
      const pEntries = await fs.readdir(path.join(cDir, 'PROCESSED'), { withFileTypes: true });
      processedCount += pEntries.filter((e) => e.isFile() && isInsuranceFile(e.name)).length;
    } catch {}

    try {
      const eEntries = await fs.readdir(path.join(cDir, 'ERRORS'), { withFileTypes: true });
      errorsCount += eEntries.filter((e) => e.isFile() && isInsuranceFile(e.name)).length;
    } catch {}
    try{reviewCount+=(await fs.readdir(path.join(cDir,'REVIEW'),{withFileTypes:true})).filter(e=>e.isFile()&&isInsuranceFile(e.name)).length;}catch{}
  }

  let historyStats = { total: 0, success: 0, failed: 0, totalAmount: '0.00' };
  try {
    const [rows] = await pool.execute(`
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN Status = 'SUCCESS' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN Status != 'SUCCESS' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN Status = 'SUCCESS' THEN TotalAmount ELSE 0 END) AS totalAmount
      FROM luk_metlife_history
    `);
    if (rows && rows[0]) {
      historyStats = {
        total: Number(rows[0].total || 0),
        success: Number(rows[0].success || 0),
        failed: Number(rows[0].failed || 0),
        totalAmount: Number(rows[0].totalAmount || 0).toFixed(2)
      };
    }
  } catch {}

  return {
    incomingDir: dir,
    candidateDirs,
    isScanning,
    lastScanTime,
    lastScanResult,
    uptimeSeconds: Math.floor(process.uptime()),
    counts: {
      incoming: incomingCount,
      processed: processedCount,
      errors: errorsCount,
      review: reviewCount
    },
    historyStats,
    serverTime: new Date().toISOString()
  };
}

export async function retryErrorFiles(pool, incomingDir) {
  const dir=incomingDir||process.env.METLIFE_INCOMING_DIR||'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const {constants}=await import('node:fs');let moved=0;const conflicts=[];
  for(const cDir of insuranceIncomingDirs(dir))for(const category of ['ERRORS','REVIEW']){
    const errorsDir=path.join(cDir,category);let entries;
    try{entries=await fs.readdir(errorsDir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
    for(const file of entries.filter(e=>e.isFile()&&isInsuranceFile(e.name))){
      const cleanName=file.name.replace(/^\d{13}_/,''),src=path.join(errorsDir,file.name),dst=path.join(cDir,cleanName);
      try{await fs.copyFile(src,dst,constants.COPYFILE_EXCL);await fs.unlink(src);moved++;}
      catch(e){if(e.code==='EEXIST')conflicts.push({fileName:cleanName,message:'Thư mục chờ đã có file cùng tên; giữ nguyên cả hai file.'});else throw e;}
    }
  }
  return {movedCount:moved,conflicts,scanResult:await scanIncomingFolder(pool,dir)};
}

async function historyPdf(filename,bytes){
 if(isImageFile(filename))return {filename:filename.replace(/\.(jpe?g|png)$/i,'.pdf'),bytes:await imagePdf(bytes)};
 return {filename,bytes};
}
export async function getHistoryPdf(pool, historyId, incomingDir) {
  const dir = incomingDir || process.env.METLIFE_INCOMING_DIR || 'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const [rows] = await pool.execute(
    'SELECT Id, FileName, PatNum, DocNum, Details FROM luk_metlife_history WHERE Id = ?',
    [historyId]
  );
  if (!rows || !rows.length) {
    throw new Error(`Không tìm thấy bản ghi lịch sử #${historyId}.`);
  }
  const item = rows[0];

  // 1. Try reading from Open Dental AtoZ if DocNum > 0
  if (item.DocNum > 0 && item.PatNum > 0) {
    try {
      const [docs] = await pool.execute(
        'SELECT d.FileName, p.ImageFolder FROM document d JOIN patient p ON p.PatNum = d.PatNum WHERE d.DocNum = ?',
        [item.DocNum]
      );
      if (docs && docs.length) {
        const [prefs] = await pool.execute(
          "SELECT PrefName, ValueString FROM preference WHERE LOWER(PrefName) IN ('docpath','atozfolderused','atozfolder','imagestore')"
        );
        const pref = (name) => prefs.find((r) => r.PrefName.toLowerCase() === name)?.ValueString;
        const root = pref('docpath') || pref('atozfolder');
        if (root) {
          const folder = docs[0].ImageFolder;
          const fileName = docs[0].FileName;
          const firstLetter = (folder[0] || 'P').toUpperCase();
          const filePath = path.join(root, firstLetter, folder, fileName);
          const bytes = await fs.readFile(filePath);
          return await historyPdf(fileName,bytes);
        }
      }
    } catch (e) {
      console.warn('[getHistoryPdf] AtoZ read failed, falling back to local files:', e.message);
    }
  }

  // 2. Try Details archivePath
  let details = null;
  try { if (item.Details) details = JSON.parse(item.Details); } catch {}
  if (details?.archivePath) {
    try {
      const bytes = await fs.readFile(details.archivePath);
      return await historyPdf(item.FileName,bytes);
    } catch {}
  }

  // 3. Try checking PROCESSED, ERRORS, incomingDir
  const searchDirs = insuranceIncomingDirs(dir).flatMap(base=>['PROCESSED','ERRORS','REVIEW',''].map(name=>path.join(base,name)));
  for (const sDir of searchDirs) {
    try {
      const files = await fs.readdir(sDir);
      const match = files.find((f) => f === item.FileName || f.endsWith('_' + item.FileName) || f.endsWith(item.FileName));
      if (match) {
        const bytes = await fs.readFile(path.join(sDir, match));
        return await historyPdf(item.FileName,bytes);
      }
    } catch {}
  }

  throw new Error(`Không tìm thấy file PDF cho giao dịch #${historyId} (${item.FileName}).`);
}

export function startAutoProcessor({ pool, incomingDir, intervalMs = 30000 }) {
  const dir = incomingDir || process.env.METLIFE_INCOMING_DIR || 'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const parentDir = path.dirname(dir);
  const libertyDir = path.join(parentDir, 'LIBERTY');
  const cignaDir = path.join(parentDir,'CIGNA');
  const deltaDir=path.join(parentDir,'DELTA DENTAL');

  console.log(`[Insurance Auto-Processor] Khởi chạy bộ quét EOB tự động (MetLife / Liberty / CIGNA / Delta Dental)`);
  console.log(`[Insurance Auto-Processor] Thư mục theo dõi:`);
  console.log(`  - MetLife: ${dir} (PDF, TXT)`);
  console.log(`  - Liberty: ${libertyDir} (PDF, JPG, JPEG, PNG, TXT)`);
  console.log(`  - CIGNA: ${cignaDir} (PDF, TXT)`);
  console.log(`  - Delta Dental: ${deltaDir} (PDF, JPG, JPEG, PNG, TXT)`);
  console.log(`  - Chu kỳ quét: ${intervalMs / 1000}s/lần`);

  // Ensure folders exist so staff can easily see them in Explorer
  try { fs.mkdir(dir, { recursive: true }).catch(() => {}); } catch {}
  try { fs.mkdir(libertyDir, { recursive: true }).catch(() => {}); } catch {}
  try { fs.mkdir(cignaDir,{recursive:true}).catch(()=>{}); } catch {}
  try { fs.mkdir(deltaDir,{recursive:true}).catch(()=>{}); } catch {}

  // Initial scan after 3s
  setTimeout(() => {
    scanIncomingFolder(pool, dir).catch((e) => {
      console.warn('[Auto-Processor] Initial scan warning:', e.message);
    });
  }, 3000);

  // Recurring interval
  if (autoScanIntervalId) clearInterval(autoScanIntervalId);
  autoScanIntervalId = setInterval(() => {
    scanIncomingFolder(pool, dir).catch((e) => {
      console.warn('[Auto-Processor] Periodic scan warning:', e.message);
    });
  }, intervalMs);

  return {
    scanNow: () => scanIncomingFolder(pool, dir),
    stop: () => {
      if (autoScanIntervalId) clearInterval(autoScanIntervalId);
    },
    getIncomingDir: () => dir
  };
}
