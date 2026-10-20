import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractPdf, parseMetlife } from './parser.js';
import { nativeSplitHashes } from './nativeSplitHashes.js';
import { odSecurityLogHash } from './directPayment.js';

let isScanning = false;
let autoScanIntervalId = null;
let lastScanTime = null;
let lastScanResult = null;

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
  const numMatch = fileName.match(/^(\d+)/) || fileName.match(/[^\d](\d{3,7})[^\d]/) || fileName.match(/(\d{3,7})\.pdf$/i);
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

export async function importPdfToAtoZ(pool, { patient, fileBytes, fileName, claimNumber }) {
  try {
    const [prefs] = await pool.execute(
      "SELECT PrefName, ValueString FROM preference WHERE LOWER(PrefName) IN ('docpath','atozfolderused','atozfolder','imagestore')"
    );
    const pref = (name) => prefs.find((r) => r.PrefName.toLowerCase() === name)?.ValueString;
    const root = pref('docpath') || pref('atozfolder');

    if (!root) {
      console.warn('[MetLife AtoZ] Không tìm thấy thư mục docpath hoặc atozfolder trong preference.');
      return { docNum: 0, savedPath: null };
    }

    let folder = patient.ImageFolder;
    if (!folder) {
      folder = `${(patient.LName || 'PT').slice(0, 5)}${(patient.FName || '').slice(0, 3)}${patient.PatNum}`.replace(/[^a-zA-Z0-9]/g, '');
      await pool.execute('UPDATE patient SET ImageFolder = ? WHERE PatNum = ?', [folder, patient.PatNum]);
    }

    const firstLetter = (folder[0] || 'P').toUpperCase();
    const destDir = path.join(root, firstLetter, folder);
    await fs.mkdir(destDir, { recursive: true });

    const safeClaim = (claimNumber || 'EOB').replace(/[^a-zA-Z0-9]/g, '_');
    const destFileName = `METLIFE_${safeClaim}_${Date.now()}.pdf`;
    const fullDestPath = path.join(destDir, destFileName);

    await fs.writeFile(fullDestPath, fileBytes);

    // Get Category for Finished Claims
    const [cats] = await pool.execute(
      "SELECT DefNum FROM definition WHERE Category = 19 AND UPPER(TRIM(ItemName)) IN ('FINISHED CLAM','FINISHED CLAIMS') ORDER BY DefNum ASC LIMIT 1"
    );
    const docCategory = cats.length ? cats[0].DefNum : 10;

    const [docRes] = await pool.execute(
      `INSERT INTO document (DocCategory, PatNum, FileName, Description, DateCreated)
       VALUES (?, ?, ?, 'MetLife EOB Finished Claim', NOW())`,
      [docCategory, patient.PatNum, destFileName]
    );

    return { docNum: docRes.insertId, savedPath: fullDestPath };
  } catch (err) {
    console.error('[MetLife AtoZ] Lỗi khi lưu PDF vào Finished Claims:', err);
    return { docNum: 0, savedPath: null, error: err.message };
  }
}

export async function autoPopulateProcedureFees(db, { patNum, eobProcedures, dbProcs }) {
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
    let match = procs.find(
      (p) => p.ProcCode === item.code && (!item.date || (p.ProcDate?.toISOString?.()?.slice(0, 10) || String(p.ProcDate).slice(0, 10)) === item.date)
    );
    if (!match) {
      match = procs.find((p) => p.ProcCode === item.code);
    }

    if (match) {
      await db.execute('UPDATE procedurelog SET ProcFee = ? WHERE ProcNum = ?', [splitFee, match.ProcNum]);
      await db.execute('UPDATE claimproc SET FeeBilled = ? WHERE ProcNum = ?', [splitFee, match.ProcNum]);
      updatedFees.push(`${item.code}: $${splitFee}`);
      match.ProcFee = splitFee;
    }
  }

  // Any procedure not in EOB (or without benefit, like unsent bitewings/panoramic/periapicals): keep at 0.00
  for (const p of procs) {
    const isEob = eobProcedures.some((ep) => ep.code === p.ProcCode && ep.benefitCents > 0);
    if (!isEob) {
      await db.execute('UPDATE procedurelog SET ProcFee = 0.00 WHERE ProcNum = ?', [p.ProcNum]);
      await db.execute('UPDATE claimproc SET FeeBilled = 0.00 WHERE ProcNum = ?', [p.ProcNum]);
      p.ProcFee = '0.00';
    }
  }

  // Update claim.ClaimFee if claim exists
  const [claims] = await db.execute('SELECT ClaimNum FROM claim WHERE PatNum = ?', [patNum]);
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

export async function processSinglePdf(pool, filePath) {
  const fileName = path.basename(filePath);
  console.log(`\n[Auto-Processor] Bắt đầu xử lý: ${fileName}...`);

  const fileBytes = await fs.readFile(filePath);
  const extracted = await extractPdf(fileBytes);
  const fullText = extracted.pages.map((p) => p.lines.map((r) => r.text).join('\n')).join('\n');

  // Carrier auto-detection: Liberty vs MetLife
  const isLiberty = /LIBERTY Dental Plan/i.test(fullText) || /PAYMENT DETAILS/i.test(fullText);
  if (isLiberty) {
    const { processLibertyPdf } = await import('../liberty/processor.js');
    return await processLibertyPdf(pool, { filePath, fileName, fileBytes, extracted });
  }

  const parsed = parseMetlife(extracted);

  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`Lỗi định dạng MetLife: ${parsed.errors.join('; ')}`);
  }

  // 1. Resolve Patient
  const patient = await resolvePatient(pool, { fileName, parsed });
  const patNum = patient.PatNum;
  const clinicNum = patient.ClinicNum || 0;
  const provNum = patient.PriProv || 1;
  const claimNumber = parsed.claimRaw || parsed.claimBase;
  const groupNum = parsed.group || '';
  const eobDate = parsed.payment?.date || parsed.processed || new Date().toISOString().slice(0, 10);
  const totalBenefit = (parsed.benefitCents / 100).toFixed(2);

  console.log(`[MetLife Auto-Processor] Bệnh nhân: ${patient.LName}, ${patient.FName} (#${patNum})`);
  console.log(`[MetLife Auto-Processor] Claim / Check: ${claimNumber} | Tổng tiền: $${totalBenefit}`);

  // 2. Import PDF to AtoZ Finished Claims
  const aToZResult = await importPdfToAtoZ(pool, {
    patient,
    fileBytes,
    fileName,
    claimNumber
  });

  // 3. Find matching procedures in DB for splits
  const [dbProcs] = await pool.execute(
    `SELECT procedurelog.ProcNum, procedurelog.ProcDate, procedurelog.ProcFee, procedurelog.ProvNum, procedurelog.ClinicNum, procedurecode.ProcCode, procedurecode.Descript
     FROM procedurelog
     JOIN procedurecode ON procedurecode.CodeNum = procedurelog.CodeNum
     WHERE procedurelog.PatNum = ? AND procedurelog.ProcStatus = 2`,
    [patNum]
  );

  // Auto-fix 0.00 ProcFee BEFORE locking tables
  const updatedFees = await autoPopulateProcedureFees(pool, {
    patNum,
    eobProcedures: parsed.procedures,
    dbProcs
  });

  const splitsPlan = [];
  for (const eobProc of parsed.procedures) {
    if (!eobProc.benefitCents || eobProc.benefitCents <= 0) continue;
    const splitAmount = (eobProc.benefitCents / 100).toFixed(2);

    let match = dbProcs.find(
      (p) => p.ProcCode === eobProc.code && (!eobProc.date || p.ProcDate?.toISOString?.()?.slice(0, 10) === eobProc.date)
    );
    if (!match) {
      match = dbProcs.find((p) => p.ProcCode === eobProc.code);
    }

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

  // 4. Generate SecurityHash for each split
  const hashPlan = {
    patNum,
    date: eobDate,
    splits: splitsPlan
  };
  const hashes = await nativeSplitHashes(hashPlan);
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

    // Revert any previous attempt for this check to avoid duplicates
    const [existingPayments] = await conn.execute(
      'SELECT PayNum FROM payment WHERE PatNum = ? AND CheckNum = ?',
      [patNum, claimNumber]
    );
    for (const p of existingPayments) {
      await conn.execute('DELETE FROM paysplit WHERE PayNum = ?', [p.PayNum]);
      await conn.execute('DELETE FROM payment WHERE PayNum = ?', [p.PayNum]);
    }

    // Reset old claimproc state if re-running
    await conn.execute(
      "UPDATE claimproc SET InsPayAmt = 0, Status = 0, DateCP = '0001-01-01' WHERE PatNum = ? AND Status = 1",
      [patNum]
    );
    await conn.execute(
      "UPDATE claim SET ClaimStatus = 'W', DateReceived = '0001-01-01' WHERE PatNum = ? AND ClaimStatus = 'R'",
      [patNum]
    );

    // Insert Payment
    const payNote = `group number : ${groupNum}`;
    const [payRes] = await conn.execute(
      `INSERT INTO payment (
        PayType, PayDate, PayAmt, CheckNum, BankBranch, PayNote, IsSplit, PatNum,
        ClinicNum, DateEntry, DepositNum, Receipt, IsRecurringCC, SecUserNumEntry,
        PaymentSource, ProcessStatus, RecurringChargeDate, ExternalId, PaymentStatus,
        IsCcCompleted, MerchantFee
      ) VALUES (?, ?, ?, ?, '', ?, 1, ?, ?, CURDATE(), 0, '', 0, 0, 0, 0, '0001-01-01', ?, 0, 0, 0.00)`,
      [selectedPayType.DefNum, eobDate, totalBenefit, claimNumber, payNote, patNum, clinicNum, claimNumber]
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

      // Ensure claimproc does not trigger a duplicate unfinalized InsPay line in Open Dental
      if (split.ProcNum > 0) {
        await conn.execute(
          `UPDATE claimproc SET InsPayAmt = 0, Status = 0, ClaimPaymentNum = 0, DateCP = '0001-01-01' WHERE PatNum = ? AND ProcNum = ?`,
          [patNum, split.ProcNum]
        );
      }
    }

    // Update Claim to Received
    await conn.execute(
      `UPDATE claim SET ClaimStatus = 'R', DateReceived = ? WHERE PatNum = ?`,
      [eobDate, patNum]
    );

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
  await fs.rename(filePath, archivePath);

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
    splits: splitsPlan.map((s) => ({ code: s.code, amount: s.amount, procNum: s.ProcNum })),
    eobPayment: parsed.payment || null,
    subscriber: parsed.subscriber || '',
    procedures: (parsed.procedures || []).map((p) => ({
      code: p.code,
      date: p.date || '',
      tooth: p.tooth || '',
      status: p.status || '',
      feeCents: p.feeCents || 0,
      benefitCents: p.benefitCents || 0,
      remarks: p.remarks || []
    })),
    archivePath
  });

  const feesUpdatedStr = updatedFees.join(', ') || 'Không cần bù (đã có phí)';

  await pool.execute(
    `INSERT INTO luk_metlife_history (
      FileName, FileHash, PatNum, PatientName, ClaimNumber, CheckNumber,
      TotalAmount, ProceduresCount, FeesUpdated, PayNum, DocNum, Status,
      Message, Details, ProcessedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUCCESS', ?, ?, NOW())`,
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

export async function scanIncomingFolder(pool, incomingDir) {
  if (isScanning) {
    return { status: 'busy', message: 'Quá trình quét đang diễn ra.' };
  }

  isScanning = true;
  lastScanTime = new Date().toISOString();
  await ensureMetlifeHistoryTable(pool);

  try {
    const candidateDirs = [incomingDir];
    try {
      const parentDir = path.dirname(incomingDir);
      const libertyDir = path.join(parentDir, 'LIBERTY');
      if (libertyDir.toLowerCase() !== incomingDir.toLowerCase()) {
        candidateDirs.push(libertyDir);
      }
    } catch {}

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

      let pdfs = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'));

      if (pdfs.length === 0) {
        // Auto-recover files from ERRORS folder if main folder is empty
        try {
          const errorsDir = path.join(cDir, 'ERRORS');
          const errEntries = await fs.readdir(errorsDir, { withFileTypes: true });
          const errPdfs = errEntries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'));
          if (errPdfs.length > 0) {
            console.log(`[Auto-Processor] Tìm thấy ${errPdfs.length} file trong ${errorsDir}. Đang tự động chuyển ra ngoài để thử lại...`);
            for (const errFile of errPdfs) {
              const cleanName = errFile.name.replace(/^\d{13}_/, '');
              const src = path.join(errorsDir, errFile.name);
              const dst = path.join(cDir, cleanName);
              await fs.rename(src, dst);
            }
            entries = await fs.readdir(cDir, { withFileTypes: true });
            pdfs = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'));
          }
        } catch {}
      }

      for (const p of pdfs) {
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

    console.log(`[Auto-Processor] Phát hiện ${allPdfFiles.length} file PDF mới cần xử lý (MetLife / Liberty)...`);
    const results = [];

    for (const file of allPdfFiles) {
      try {
        const res = await processSinglePdf(pool, file.fullPath);
        results.push(res);
      } catch (err) {
        console.error(`[Auto-Processor] ✗ Lỗi khi xử lý ${file.fileName}:`, err.message);

        // Move to ERRORS
        try {
          const errorsDir = path.join(file.dir, 'ERRORS');
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
            ) VALUES (?, '', 0, 'Chưa rõ', '', '', 0.00, 0, '', 0, 0, 'FAILED', ?, '', NOW())`,
            [file.fileName, `Lỗi xử lý tự động: ${err.message}`]
          );
        } catch {}

        results.push({
          success: false,
          fileName: file.fileName,
          error: err.message
        });
      }
    }

    const finalRes = { status: 'completed', count: results.length, results };
    lastScanResult = finalRes;
    return finalRes;
  } finally {
    isScanning = false;
  }
}

export async function getProcessorStatus(pool, incomingDir) {
  const dir = incomingDir || process.env.METLIFE_INCOMING_DIR || 'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const candidateDirs = [dir];
  try {
    const parentDir = path.dirname(dir);
    const libertyDir = path.join(parentDir, 'LIBERTY');
    if (libertyDir.toLowerCase() !== dir.toLowerCase()) candidateDirs.push(libertyDir);
  } catch {}

  let incomingCount = 0;
  let processedCount = 0;
  let errorsCount = 0;

  for (const cDir of candidateDirs) {
    try {
      const entries = await fs.readdir(cDir, { withFileTypes: true });
      incomingCount += entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).length;
    } catch {}

    try {
      const pEntries = await fs.readdir(path.join(cDir, 'PROCESSED'), { withFileTypes: true });
      processedCount += pEntries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).length;
    } catch {}

    try {
      const eEntries = await fs.readdir(path.join(cDir, 'ERRORS'), { withFileTypes: true });
      errorsCount += eEntries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).length;
    } catch {}
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
      errors: errorsCount
    },
    historyStats,
    serverTime: new Date().toISOString()
  };
}

export async function retryErrorFiles(pool, incomingDir) {
  const dir = incomingDir || process.env.METLIFE_INCOMING_DIR || 'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const candidateDirs = [dir];
  try {
    const parentDir = path.dirname(dir);
    const libertyDir = path.join(parentDir, 'LIBERTY');
    if (libertyDir.toLowerCase() !== dir.toLowerCase()) candidateDirs.push(libertyDir);
  } catch {}

  let moved = 0;
  for (const cDir of candidateDirs) {
    const errorsDir = path.join(cDir, 'ERRORS');
    try {
      const errEntries = await fs.readdir(errorsDir, { withFileTypes: true });
      const errPdfs = errEntries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'));
      for (const errFile of errPdfs) {
        const cleanName = errFile.name.replace(/^\d{13}_/, '');
        const src = path.join(errorsDir, errFile.name);
        const dst = path.join(cDir, cleanName);
        await fs.rename(src, dst);
        moved++;
      }
    } catch {}
  }

  const scanResult = await scanIncomingFolder(pool, dir);
  return { movedCount: moved, scanResult };
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
          return { filename: fileName, bytes };
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
      return { filename: item.FileName, bytes };
    } catch {}
  }

  // 3. Try checking PROCESSED, ERRORS, incomingDir
  const searchDirs = [
    path.join(dir, 'PROCESSED'),
    path.join(dir, 'ERRORS'),
    dir
  ];
  for (const sDir of searchDirs) {
    try {
      const files = await fs.readdir(sDir);
      const match = files.find((f) => f === item.FileName || f.endsWith('_' + item.FileName) || f.endsWith(item.FileName));
      if (match) {
        const bytes = await fs.readFile(path.join(sDir, match));
        return { filename: item.FileName, bytes };
      }
    } catch {}
  }

  throw new Error(`Không tìm thấy file PDF cho giao dịch #${historyId} (${item.FileName}).`);
}

export function startAutoProcessor({ pool, incomingDir, intervalMs = 30000 }) {
  const dir = incomingDir || process.env.METLIFE_INCOMING_DIR || 'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const parentDir = path.dirname(dir);
  const libertyDir = path.join(parentDir, 'LIBERTY');

  console.log(`[Insurance Auto-Processor] Khởi chạy bộ quét EOB tự động (Hỗ trợ cả MetLife & LIBERTY Dental Plan)`);
  console.log(`[Insurance Auto-Processor] Thư mục theo dõi:`);
  console.log(`  - MetLife: ${dir}`);
  console.log(`  - Liberty: ${libertyDir}`);
  console.log(`  - Chu kỳ quét: ${intervalMs / 1000}s/lần`);

  // Ensure folders exist so staff can easily see them in Explorer
  try { fs.mkdir(dir, { recursive: true }).catch(() => {}); } catch {}
  try { fs.mkdir(libertyDir, { recursive: true }).catch(() => {}); } catch {}

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
