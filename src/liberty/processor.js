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
