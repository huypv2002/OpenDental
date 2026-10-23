import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseLiberty } from './parser.js';
import {validateLibertyForPosting,matchLibertyProcedures} from './validation.js';
import {claimPaymentFields} from '../metlife/paymentFormat.js';
import { nativeSplitHashes } from '../metlife/nativeSplitHashes.js';
import {planMissingProcedures,createMissingProcedures} from '../metlife/missingProcedures.js';
import {prepareInsuranceSettlement,applyInsuranceSettlement,verifyInsuranceSettlement,verifiedInsurancePayment,recordInsuranceResult,reviewError,procedureDay} from '../metlife/insuranceSettlement.js';
import { odSecurityLogHash } from '../metlife/directPayment.js';
import { autoPopulateProcedureFees, importPdfToAtoZ } from '../metlife/autoProcessor.js';

export async function resolveLibertyPatient(pool, { claim, strictMember=false }) {
  const { lastName, firstName, memberId } = claim.patient;

  // 1. Try matching by SubscriberID in inssub
  if (memberId) {
    const cleanId = memberId.replace(/-.*$/, ''); // e.g. 346M97946 from 346M97946-01
    const [matches] = await pool.execute(
      `SELECT DISTINCT p.PatNum, p.FName, p.LName, p.Birthdate, p.ClinicNum, p.PriProv, p.ImageFolder, p.ChartNumber
       FROM patient p
       JOIN patplan pp ON pp.PatNum = p.PatNum
       JOIN inssub s ON s.InsSubNum = pp.InsSubNum
       WHERE (TRIM(s.SubscriberID) = ? OR TRIM(s.SubscriberID) = ?) AND LOWER(TRIM(p.LName)) = LOWER(?) AND LOWER(TRIM(p.FName)) = LOWER(?)
       ORDER BY p.PatNum ASC LIMIT 2`,
      [memberId,cleanId,lastName,firstName]
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  // 2. Try matching by Exact Last Name + First Name
  if (!strictMember && lastName && firstName) {
    const [matches] = await pool.execute(
      `SELECT DISTINCT p.PatNum, p.FName, p.LName, p.Birthdate, p.ClinicNum, p.PriProv, p.ImageFolder, p.ChartNumber
       FROM patient p
       WHERE LOWER(p.LName) = LOWER(?) AND LOWER(p.FName) = LOWER(?)
       ORDER BY p.PatNum ASC LIMIT 2`,
      [lastName, firstName]
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  throw new Error(`Không tìm thấy bệnh nhân trong Open Dental cho Liberty Claim #${claim.claimNumber} (Bệnh nhân: ${lastName}, ${firstName} - Member ID: ${memberId})`);
}

export async function libertyProcedures(pool,patNum){
  const [dbProcs] = await pool.execute(
    `SELECT procedurelog.ProcNum, procedurelog.ProcDate, procedurelog.ProcFee, procedurelog.ProvNum, procedurelog.ClinicNum, procedurelog.ToothNum, procedurelog.Surf, procedurecode.ProcCode, procedurecode.Descript
     FROM procedurelog
     JOIN procedurecode ON procedurecode.CodeNum = procedurelog.CodeNum
     WHERE procedurelog.PatNum = ? AND procedurelog.ProcStatus = 2`,
    [patNum]
  );

  return dbProcs;
}

export function libertySplitPlan(claim,check,patient,matches){
 const checkDate=check.date,clinicNum=patient.ClinicNum||0,provNum=patient.PriProv||1;
  const splitsPlan = [];
  for (const eobProc of claim.procedures) {
    if (!eobProc.benefitCents || eobProc.benefitCents <= 0) continue;
    const splitAmount = (eobProc.benefitCents / 100).toFixed(2);

    const match = matches.get(eobProc);

    splitsPlan.push({
      ProcNum: match ? match.ProcNum : 0,
      ProvNum: match?.ProvNum || provNum,
      ClinicNum: match?.ClinicNum || clinicNum,
      date: eobProc.date || checkDate,
      amount: splitAmount,
      amountCents: eobProc.benefitCents,
      code: eobProc.code,
      desc: match?.Descript || `${claim.plan?.carrier||'Insurance'} ${eobProc.code}`
    });
  }

 return splitsPlan;
}

export async function prepareLibertyClaimPayload(pool, { claim, check, patient, dbProcs: suppliedProcs, settlement, hashSplits=nativeSplitHashes }) {
  const patNum = patient.PatNum;
  const clinicNum = patient.ClinicNum || 0;
  const provNum = patient.PriProv || 1;
  const checkDate = check.date;
  const claimNumber = claim.claimNumber;
  const checkNumber = check.number;
  const groupNumber = claim.plan.group || '';

  const dbProcs = suppliedProcs || await libertyProcedures(pool,patNum);
  const matches = matchLibertyProcedures(dbProcs,claim,{allowUniqueCodeDate:claim.plan?.carrier==='LIBERTY Dental Plan'});
  const claimDates = new Set(claim.procedures.map(p=>p.date));

  const eobProcedures = claim.procedures.map((p) => ({
    procNum: matches.get(p)?.ProcNum,
    code: p.code,
    date: p.date,
    benefitCents: p.benefitCents,
    feeCents: p.feeCents,
    tooth: p.tooth
  }));

  const updatedFees = await autoPopulateProcedureFees(pool, {
    patNum,
    eobProcedures,
    settlement,
    dbProcs:dbProcs.filter(p=>settlement?settlement.procIds.includes(String(p.ProcNum)):claimDates.has(procedureDay(p.ProcDate)))
  });

  const splitsPlan=libertySplitPlan(claim,check,patient,matches);

  // Generate Security Hashes
  const hashPlan = {
    patNum,
    date: checkDate,
    splits: splitsPlan
  };
  const hashes = await hashSplits(hashPlan);
  hashes.forEach((h, idx) => {
    splitsPlan[idx].SecurityHash = h;
  });

  const paymentFields = claimPaymentFields(claimNumber,checkDate);
  const payNote = paymentFields.note;
  const totalAmount = (claim.totals.planPaidCents / 100).toFixed(2);

  return {
    patNum,
    claimNumber,
    checkNumber,
    checkNum: paymentFields.checkNum,
    checkDate,
    totalAmount,
    totalAmountCents: claim.totals.planPaidCents,
    payNote,
    splits: splitsPlan,
    updatedFees
  };
}

export async function processLibertyPdf(pool, { filePath, fileName, fileBytes, extracted }, { preparePayload = prepareLibertyClaimPayload, hashSplits=nativeSplitHashes, log = console.log, normalized=null, carrier='LIBERTY Dental Plan', patientResolver=resolveLibertyPatient } = {}) {
  const label=carrier==='DELTA DENTAL'?'Delta Dental':carrier==='CIGNA'?'Cigna':'Liberty';
  const parsed = validateLibertyForPosting(normalized||parseLiberty(extracted),extracted,carrier==='DELTA DENTAL'?{verifyLibertyOcr:false}:carrier==='CIGNA'?{claimPattern:/^[A-Z0-9-]{1,64}$/,requireMember:false}:{});
  const preflight=new Map();
  {
    // Resolve every patient/procedure before importing or changing fees for the first claim.
    try{for(const claim of parsed.claims){
      const patient=await patientResolver(pool,{claim,strictMember:!!extracted.ocr,fileName,claimsCount:parsed.claimsCount});
      const missingPlan=planMissingProcedures(await libertyProcedures(pool,patient.PatNum),claim.procedures,{allowUniqueCodeDate:carrier==='LIBERTY Dental Plan'});
      const dbProcs=missingPlan.procs;
      const matches=matchLibertyProcedures(dbProcs,claim,{allowUniqueCodeDate:carrier==='LIBERTY Dental Plan'});
      const check={...parsed.check,...claim.check},splits=libertySplitPlan(claim,check,patient,matches);
      const settlement=await prepareInsuranceSettlement(pool,{patNum:patient.PatNum,carrier,procedures:claim.procedures,dbProcs,splits});
      const existing=await verifiedInsurancePayment(pool,{patNum:patient.PatNum,claimNumber:claim.claimNumber,date:check.date,amountCents:claim.totals.planPaidCents,splits});
      preflight.set(claim.claimNumber,{patient,dbProcs,matches,splits,settlement,existing,missingPlan});
    }}catch(e){e.code='EOB_REVIEW_REQUIRED';throw e;}
  }

  // All patients, allocations and existing payments passed read-only preflight.
  // Missing services are now created once, before PDF/fee/payment writes.
  for(const claim of parsed.claims){
    const checked=preflight.get(claim.claimNumber);
    checked.addedProcedures=await createMissingProcedures(pool,{plan:checked.missingPlan,patient:checked.patient,claimNumber:claim.claimNumber,carrier});
    for(const p of checked.addedProcedures)log(`[${label} Auto-Processor] Claim #${claim.claimNumber}: ${p.reused?'dùng lại':'đã thêm'} dịch vụ ${p.code}, ProcNum: ${p.procNum}${p.newCode?' (đã thêm mã vào danh mục)':''}.`);
    if(checked.addedProcedures.length){
      checked.matches=matchLibertyProcedures(checked.dbProcs,claim,{allowUniqueCodeDate:carrier==='LIBERTY Dental Plan'});
      const check={...parsed.check,...claim.check};
      checked.splits=libertySplitPlan(claim,check,checked.patient,checked.matches);
      checked.settlement=await prepareInsuranceSettlement(pool,{patNum:checked.patient.PatNum,carrier,procedures:claim.procedures,dbProcs:checked.dbProcs,splits:checked.splits});
      checked.existing=await verifiedInsurancePayment(pool,{patNum:checked.patient.PatNum,claimNumber:claim.claimNumber,date:check.date,amountCents:claim.totals.planPaidCents,splits:checked.splits});
    }
  }

  log(`[${label} Auto-Processor] Phát hiện ${parsed.claimsCount} claim${parsed.check.number?` trong check #${parsed.check.number}`:''}`);

  const processedClaims = [];
  const incomingDir = path.dirname(filePath);
  const processedDir = path.join(incomingDir, 'PROCESSED');
  const archivePath = path.join(processedDir, `${Date.now()}_${fileName}`);

  for (const claim of parsed.claims) {
    log(`[${label} Auto-Processor] Đang xử lý claim #${claim.claimNumber} cho bệnh nhân ${claim.patient.lastName}, ${claim.patient.firstName}...`);

    log(`[${label} Auto-Processor] Claim #${claim.claimNumber}: đối chiếu bệnh nhân...`);
    const patient = preflight.get(claim.claimNumber)?.patient || await patientResolver(pool, { claim });
    const patNum = patient.PatNum;
    const clinicNum = patient.ClinicNum || 0;
    const claimNumber = claim.claimNumber;
    const checkNumber = parsed.check.number;
    const groupNum = claim.plan.group || '';
    const claimCheck={...parsed.check,...claim.check};
    const checkDate = claimCheck.date;
    const paymentFields = claimPaymentFields(claimNumber,checkDate);
    const totalBenefit = (claim.totals.planPaidCents / 100).toFixed(2);

    log(`[${label} Auto-Processor] Claim #${claimNumber}: lưu PDF vào Finished Claims...`);
    // Import PDF to AtoZ
    const aToZResult = await importPdfToAtoZ(pool, {
      patient,
      fileBytes,
      fileName,
      claimNumber,
      carrier,
      paymentDate: checkDate,
      amountCents: claim.totals.planPaidCents
    });

    // Prepare payload
    log(`[${label} Auto-Processor] Claim #${claimNumber}: đối chiếu dịch vụ, cập nhật phí và chuẩn bị phân bổ...`);
    const checked=preflight.get(claim.claimNumber);
    const payload=checked.existing?{splits:checked.splits,updatedFees:[]}:await preparePayload(pool, { claim, check: claimCheck, patient, dbProcs:checked.dbProcs,settlement:checked.settlement,hashSplits });

    // Select Payment Type
    log(`[${label} Auto-Processor] Claim #${claimNumber}: chọn loại thanh toán...`);
    const [payTypes] = await pool.execute(
      'SELECT DefNum, ItemName FROM definition WHERE Category = 10 AND IsHidden = 0 ORDER BY ItemOrder'
    );
    const selectedPayType =
      payTypes.find((t) => /ins/i.test(t.ItemName)) ||
      payTypes.find((t) => /check/i.test(t.ItemName)) ||
      payTypes[0] ||
      { DefNum: 10, ItemName: 'Insurance Paid' };

    // DB Transaction with LOCK TABLES
    log(`[${label} Auto-Processor] Claim #${claimNumber}: chờ kết nối ghi thanh toán...`);
    const conn = await pool.getConnection();
    let payNum = 0;

    try {
      log(`[${label} Auto-Processor] Claim #${claimNumber}: chờ khóa bảng thanh toán...`);
      await conn.query(
        'LOCK TABLES payment WRITE, paysplit WRITE, securitylog WRITE, securityloghash WRITE, claimproc WRITE, claim WRITE, patient WRITE'
      );

      log(`[${label} Auto-Processor] Claim #${claimNumber}: ghi thanh toán $${totalBenefit}, ${payload.splits.length} phân bổ...`);
      await verifyInsuranceSettlement(conn,checked.settlement);
      const previous=await verifiedInsurancePayment(conn,{patNum,claimNumber,date:checkDate,amountCents:claim.totals.planPaidCents,splits:payload.splits});
      if(previous){payNum=previous.PayNum;log(`[${label} Auto-Processor] Claim #${claimNumber}: đã xác minh Payment #${payNum}; giữ nguyên khoản đã lưu.`);}
      else {
       if(checked.existing)throw reviewError('Khoản đã lưu thay đổi sau đối chiếu; chưa tạo lại thanh toán.');
      // Insert Payment
      const payNote = paymentFields.note;
      const [payRes] = await conn.execute(
        `INSERT INTO payment (
          PayType, PayDate, PayAmt, CheckNum, BankBranch, PayNote, IsSplit, PatNum,
          ClinicNum, DateEntry, DepositNum, Receipt, IsRecurringCC, SecUserNumEntry,
          PaymentSource, ProcessStatus, RecurringChargeDate, ExternalId, PaymentStatus,
          IsCcCompleted, MerchantFee
        ) VALUES (?, ?, ?, ?, '', ?, 1, ?, ?, CURDATE(), 0, '', 0, 0, 0, 0, '0001-01-01', ?, 0, 0, 0.00)`,
        [selectedPayType.DefNum, checkDate, totalBenefit, paymentFields.checkNum, payNote, patNum, clinicNum, claimNumber]
      );
      payNum = payRes.insertId;

      // Insert PaySplits with SecurityHash
      for (const split of payload.splits) {
        await conn.execute(
          `INSERT INTO paysplit (
            SplitAmt, PatNum, ProcDate, DatePay, ProcNum, ProvNum, ClinicNum, PayNum,
            DateEntry, SecUserNumEntry, SecurityHash, UnearnedType, IsDiscount, DiscountType,
            PayPlanNum, FSplitNum, AdjNum, PayPlanChargeNum, PayPlanDebitType
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), 0, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
          [split.amount, patNum, split.date, checkDate, split.ProcNum, split.ProvNum, split.ClinicNum, payNum, split.SecurityHash]
        );

      }

      // Audit SecurityLog & SecurityLogHash
      const logText = `Payment created for ${patient.LName}, ${patient.FName} with payment type '${selectedPayType.ItemName}', amount '$${totalBenefit}'`;
      const [logRes] = await conn.execute(
        `INSERT INTO securitylog (
          PermType, UserNum, LogText, PatNum, CompName, DateTPrevious
        ) VALUES (15, 0, ?, ?, ?, '0001-01-01 00:00:00')`,
        [logText, patNum, (os.hostname() || 'SERVER').slice(0, 255)]
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
      await applyInsuranceSettlement(conn,checked.settlement,checkDate);
      await conn.query('UNLOCK TABLES');
    } finally {
      try { await conn.query('UNLOCK TABLES'); } catch {}
      conn.release();
    }

    log(`[${label} Auto-Processor] Claim #${claimNumber}: đã ghi Payment #${payNum}, đã mở khóa; cập nhật số dư...`);
    // Re-calculate BalTotal after releasing table locks
    try {
      const [balRes] = await pool.execute(
        'SELECT SUM(ProcFee) AS TotalCharges FROM procedurelog WHERE PatNum = ? AND ProcStatus = 2',
        [patNum]
      );
      const [paySumRes] = await pool.execute(
        'SELECT SUM(SplitAmt) AS TotalPaid FROM paysplit WHERE PatNum = ?',
        [patNum]
      );
      const newBal = (Number(balRes[0]?.TotalCharges || 0) - Number(paySumRes[0]?.TotalPaid || 0)).toFixed(2);
      await pool.execute('UPDATE patient SET BalTotal = ? WHERE PatNum = ?', [newBal, patNum]);
    } catch (e) {
      console.warn(`[${label}] Warning calculating BalTotal:`, e.message);
    }

    log(`[${label} Auto-Processor] Claim #${claimNumber}: ghi lịch sử xử lý...`);
    // Record in history table
    const details = JSON.stringify({
      carrier,
      insuranceDefaults:{estimate:0,writeOff:0,claimNums:checked.settlement.claimIds,claimProcNums:checked.settlement.rows.map(r=>r.ClaimProcNum)},
      procedureMatchWarnings:claim.procedures.filter(p=>p.matchWarning).map(p=>p.matchWarning),
      settlementBasis:parsed.settlementBasis,
      warnings:parsed.warnings,
      sourceProcedures:claim.rawProcedures,
      depositAmountCents:claim.headerPaidCents,
      sourceFormat: extracted.sourceFormat||'pdf',
      extractedText: extracted.ocr?parsed.text:undefined,
      archivePath,
      patient: `${patient.LName}, ${patient.FName}`,
      patNum,
      claimNumber,
      checkNumber,
      groupNum,
      payNum,
      docNum: aToZResult.docNum,
      totalBenefit,
      paymentDate: checkDate,
      paymentNote: paymentFields.note,
      paymentCheckNum: paymentFields.checkNum,
      documentDescription: aToZResult.description,
      documentDate: aToZResult.dateCreated,
      updatedFees: payload.updatedFees,
      addedProcedures:checked.addedProcedures,
      splits: payload.splits.map((s) => ({ code: s.code, amount: s.amount, procNum: s.ProcNum })),
      procedures: claim.procedures.map((p) => ({
        procNum:checked.matches.get(p)?.ProcNum,
        code: p.code,
        date: p.date,
        tooth: p.tooth,
        status: p.status,
        feeCents: p.feeCents,
        benefitCents: p.benefitCents
      }))
    });

    const feesUpdatedStr = payload.updatedFees.join(', ') || 'Không cần bù (đã có phí)';

    await recordInsuranceResult(pool,
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
        `[${label}] Đã tự động import Finished Claims và ghi thanh toán $${totalBenefit} vào Open Dental.`,
        details
      ]
    );

    log(`[${label} Auto-Processor] ✓ CLAIM HOÀN TẤT: #${claimNumber} -> PayNum: ${payNum}, DocNum: ${aToZResult.docNum}, $${totalBenefit}`);
    processedClaims.push({
      claimNumber,
      patNum,
      patientName: `${patient.LName}, ${patient.FName}`,
      payNum,
      docNum: aToZResult.docNum,
      amount: totalBenefit
    });
  }

  // Move PDF to PROCESSED
  log(`[${label} Auto-Processor] Chuyển ${fileName} vào PROCESSED...`);
  await fs.mkdir(processedDir, { recursive: true });
  await fs.rename(filePath, archivePath);
  log(`[${label} Auto-Processor] ✓ HOÀN THÀNH: ${fileName} -> ${processedClaims.length} claim, ${processedClaims.map(c => `PayNum: ${c.payNum}, DocNum: ${c.docNum}`).join('; ')} -> PROCESSED`);

  return {
    success: true,
    carrier,
    fileName,
    archivePath,
    claimsCount: processedClaims.length,
    claims: processedClaims
  };
}
