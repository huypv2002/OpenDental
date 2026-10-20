import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdf } from '../metlife/parser.js';
import { parseLiberty } from './parser.js';
import { nativeSplitHashes } from '../metlife/nativeSplitHashes.js';
import { odSecurityLogHash } from '../metlife/directPayment.js';
import { autoPopulateProcedureFees, importPdfToAtoZ } from '../metlife/autoProcessor.js';

export async function resolveLibertyPatient(pool, { claim }) {
  const { lastName, firstName, memberId } = claim.patient;

  // 1. Try matching by SubscriberID in inssub
  if (memberId) {
    const cleanId = memberId.replace(/-.*$/, ''); // e.g. 346M97946 from 346M97946-01
    const [matches] = await pool.execute(
      `SELECT p.PatNum, p.FName, p.LName, p.Birthdate, p.ClinicNum, p.PriProv, p.ImageFolder, p.ChartNumber
       FROM patient p
       JOIN patplan pp ON pp.PatNum = p.PatNum
       JOIN inssub s ON s.InsSubNum = pp.InsSubNum
       WHERE s.SubscriberID LIKE ? OR s.SubscriberID LIKE ?
       ORDER BY p.PatNum ASC LIMIT 1`,
      [`%${memberId}%`, `%${cleanId}%`]
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  // 2. Try matching by Exact Last Name + First Name
  if (lastName && firstName) {
    const [matches] = await pool.execute(
      `SELECT p.PatNum, p.FName, p.LName, p.Birthdate, p.ClinicNum, p.PriProv, p.ImageFolder, p.ChartNumber
       FROM patient p
       WHERE LOWER(p.LName) = LOWER(?) AND LOWER(p.FName) LIKE LOWER(?)
       ORDER BY p.PatNum ASC LIMIT 2`,
      [lastName, `${firstName}%`]
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  // 3. Fallback: Search by Last Name only if unique
  if (lastName) {
    const [matches] = await pool.execute(
      `SELECT p.PatNum, p.FName, p.LName, p.Birthdate, p.ClinicNum, p.PriProv, p.ImageFolder, p.ChartNumber
       FROM patient p
       WHERE LOWER(p.LName) = LOWER(?)
       ORDER BY p.PatNum ASC LIMIT 2`,
      [lastName]
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  throw new Error(`Không tìm thấy bệnh nhân trong Open Dental cho Liberty Claim #${claim.claimNumber} (Bệnh nhân: ${lastName}, ${firstName} - Member ID: ${memberId})`);
}

export async function prepareLibertyClaimPayload(pool, { claim, check, patient }) {
  const patNum = patient.PatNum;
  const clinicNum = patient.ClinicNum || 0;
  const provNum = patient.PriProv || 1;
  const checkDate = check.date || new Date().toISOString().slice(0, 10);
  const claimNumber = claim.claimNumber;
  const checkNumber = check.number;
  const groupNumber = claim.plan.group || '';

  // Get completed procedures for this patient
  const [dbProcs] = await pool.execute(
    `SELECT procedurelog.ProcNum, procedurelog.ProcDate, procedurelog.ProcFee, procedurelog.ProvNum, procedurelog.ClinicNum, procedurecode.ProcCode, procedurecode.Descript
     FROM procedurelog
     JOIN procedurecode ON procedurecode.CodeNum = procedurelog.CodeNum
     WHERE procedurelog.PatNum = ? AND procedurelog.ProcStatus = 2`,
    [patNum]
  );

  const eobProcedures = claim.procedures.map((p) => ({
    code: p.code,
    date: p.date,
    benefitCents: p.benefitCents,
    feeCents: p.feeCents,
    tooth: p.tooth
  }));

  const updatedFees = await autoPopulateProcedureFees(pool, {
    patNum,
    eobProcedures,
    dbProcs
  });

  const splitsPlan = [];
  for (const eobProc of claim.procedures) {
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
      date: eobProc.date || checkDate,
      amount: splitAmount,
      amountCents: eobProc.benefitCents,
      code: eobProc.code,
      desc: match?.Descript || `Liberty ${eobProc.code}`
    });
  }

  // Generate Security Hashes
  const hashPlan = {
    patNum,
    date: checkDate,
    splits: splitsPlan
  };
  const hashes = await nativeSplitHashes(hashPlan);
  hashes.forEach((h, idx) => {
    splitsPlan[idx].SecurityHash = h;
  });

  const payNote = `Check # ${checkNumber} | Claim: ${claimNumber} | Group: ${groupNumber} | Carrier: LIBERTY Dental Plan`;
  const totalAmount = (claim.totals.planPaidCents / 100).toFixed(2);

  return {
    patNum,
    claimNumber,
    checkNumber,
    checkDate,
    totalAmount,
    totalAmountCents: claim.totals.planPaidCents,
    payNote,
    splits: splitsPlan,
    updatedFees
  };
}

export async function processLibertyPdf(pool, { filePath, fileName, fileBytes, extracted }) {
  const parsed = parseLiberty(extracted);
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`Lỗi định dạng Liberty: ${parsed.errors.join('; ')}`);
  }

  console.log(`[Liberty Auto-Processor] Phát hiện ${parsed.claimsCount} claim trong check #${parsed.check.number}`);

  const processedClaims = [];
  const incomingDir = path.dirname(filePath);

  for (const claim of parsed.claims) {
    console.log(`[Liberty Auto-Processor] Đang xử lý claim #${claim.claimNumber} cho bệnh nhân ${claim.patient.lastName}, ${claim.patient.firstName}...`);

    const patient = await resolveLibertyPatient(pool, { claim });
    const patNum = patient.PatNum;
    const clinicNum = patient.ClinicNum || 0;
    const claimNumber = claim.claimNumber;
    const checkNumber = parsed.check.number;
    const groupNum = claim.plan.group || '';
    const checkDate = parsed.check.date || new Date().toISOString().slice(0, 10);
    const totalBenefit = (claim.totals.planPaidCents / 100).toFixed(2);

    // Import PDF to AtoZ
    const aToZResult = await importPdfToAtoZ(pool, {
      patient,
      fileBytes,
      fileName,
      claimNumber
    });

    // Prepare payload
    const payload = await prepareLibertyClaimPayload(pool, { claim, check: parsed.check, patient });

    // Select Payment Type
    const [payTypes] = await pool.execute(
      'SELECT DefNum, ItemName FROM definition WHERE Category = 10 AND IsHidden = 0 ORDER BY ItemOrder'
    );
    const selectedPayType =
      payTypes.find((t) => /ins/i.test(t.ItemName)) ||
      payTypes.find((t) => /check/i.test(t.ItemName)) ||
      payTypes[0] ||
      { DefNum: 10, ItemName: 'Insurance Paid' };

    // DB Transaction with LOCK TABLES
    const conn = await pool.getConnection();
    let payNum = 0;

    try {
      await conn.query(
        'LOCK TABLES payment WRITE, paysplit WRITE, securitylog WRITE, securityloghash WRITE, claimproc WRITE, claim WRITE, patient WRITE'
      );

      // Revert duplicate payments for this check & claim
      const [existingPayments] = await conn.execute(
        'SELECT PayNum FROM payment WHERE PatNum = ? AND (CheckNum = ? OR CheckNum = ?)',
        [patNum, checkNumber, claimNumber]
      );
      for (const p of existingPayments) {
        await conn.execute('DELETE FROM paysplit WHERE PayNum = ?', [p.PayNum]);
        await conn.execute('DELETE FROM payment WHERE PayNum = ?', [p.PayNum]);
      }

      // Reset claimproc
      await conn.execute(
        "UPDATE claimproc SET InsPayAmt = 0, Status = 0, DateCP = '0001-01-01' WHERE PatNum = ? AND Status = 1",
        [patNum]
      );
      await conn.execute(
        "UPDATE claim SET ClaimStatus = 'W', DateReceived = '0001-01-01' WHERE PatNum = ? AND ClaimStatus = 'R'",
        [patNum]
      );

      // Insert Payment
      const [payRes] = await conn.execute(
        `INSERT INTO payment (
          PayType, PatNum, ClinicNum, PayDate, PayAmt, CheckNum,
          BankExchangeRate, PayNote, DateEntry, IsRecurring, ProcessToken,
          Receipt, PaymentStatus
        ) VALUES (?, ?, ?, ?, ?, ?, 1.0, ?, CURDATE(), 0, '', '', 0)`,
        [
          selectedPayType.DefNum,
          patNum,
          clinicNum,
          checkDate,
          totalBenefit,
          checkNumber,
          payload.payNote
        ]
      );
      payNum = payRes.insertId;

      // Insert PaySplits with SecurityHash
      for (const split of payload.splits) {
        await conn.execute(
          `INSERT INTO paysplit (
            SplitNum, SplitAmt, PatNum, ProcDate, DatePay, ProcNum,
            ProvNum, PayNum, ClinicNum, DateEntry, UnearnedType,
            SecDateTEdit, SecDateTEntry, SecurityHash
          ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), 0, NOW(), NOW(), ?)`,
          [
            split.amount,
            patNum,
            split.date,
            checkDate,
            split.ProcNum,
            split.ProvNum,
            payNum,
            split.ClinicNum,
            split.SecurityHash
          ]
        );
      }

      // SecurityLog
      const logText = `Payment Create: ${totalBenefit}, ${selectedPayType.ItemName}, PatNum: ${patNum}`;
      const logHash = odSecurityLogHash(logText);
      const [logRes] = await conn.execute(
        `INSERT INTO securitylog (
          PermType, UserNum, LogDateTime, LogText, PatNum, CompName,
          FKey, LogHash
        ) VALUES (27, 0, NOW(), ?, ?, 'SERVER', ?, ?)`,
        [logText, patNum, payNum, logHash]
      );
      const secLogNum = logRes.insertId;

      try {
        await conn.execute(
          'INSERT INTO securityloghash (SecurityLogNum, LogHash) VALUES (?, ?)',
          [secLogNum, logHash]
        );
      } catch {}

      // Update matching claim to Received ('R')
      await conn.execute(
        "UPDATE claim SET ClaimStatus = 'R', DateReceived = ? WHERE PatNum = ? AND ClaimStatus = 'W' LIMIT 1",
        [checkDate, patNum]
      );

      // Re-calculate BalTotal
      const [balRes] = await conn.execute(
        'SELECT SUM(ProcFee) AS TotalCharges FROM procedurelog WHERE PatNum = ? AND ProcStatus = 2',
        [patNum]
      );
      const [paySumRes] = await conn.execute(
        'SELECT SUM(SplitAmt) AS TotalPaid FROM paysplit WHERE PatNum = ?',
        [patNum]
      );
      const newBal = (Number(balRes[0]?.TotalCharges || 0) - Number(paySumRes[0]?.TotalPaid || 0)).toFixed(2);
      await conn.execute('UPDATE patient SET BalTotal = ? WHERE PatNum = ?', [newBal, patNum]);

    } finally {
      await conn.query('UNLOCK TABLES');
      conn.release();
    }

    // Record in history table
    const details = JSON.stringify({
      carrier: 'LIBERTY Dental Plan',
      patient: `${patient.LName}, ${patient.FName}`,
      patNum,
      claimNumber,
      checkNumber,
      groupNum,
      payNum,
      docNum: aToZResult.docNum,
      totalBenefit,
      updatedFees: payload.updatedFees,
      splits: payload.splits.map((s) => ({ code: s.code, amount: s.amount, procNum: s.ProcNum })),
      procedures: claim.procedures.map((p) => ({
        code: p.code,
        date: p.date,
        tooth: p.tooth,
        status: p.status,
        feeCents: p.feeCents,
        benefitCents: p.benefitCents
      }))
    });

    const feesUpdatedStr = payload.updatedFees.join(', ') || 'Không cần bù (đã có phí)';

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
        checkNumber,
        totalBenefit,
        payload.splits.length,
        feesUpdatedStr,
        payNum,
        aToZResult.docNum,
        `[Liberty] Đã tự động import Finished Claims và ghi thanh toán $${totalBenefit} vào Open Dental.`,
        details
      ]
    );

    processedClaims.push({
      claimNumber,
      patNum,
      patientName: `${patient.LName}, ${patient.FName}`,
      payNum,
      amount: totalBenefit
    });
  }

  // Move PDF to PROCESSED
  const processedDir = path.join(incomingDir, 'PROCESSED');
  await fs.mkdir(processedDir, { recursive: true });
  const archivePath = path.join(processedDir, `${Date.now()}_${fileName}`);
  await fs.rename(filePath, archivePath);

  return {
    success: true,
    carrier: 'LIBERTY Dental Plan',
    fileName,
    claims: processedClaims
  };
}
