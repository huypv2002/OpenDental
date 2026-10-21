import { createHash } from 'node:crypto';
import { cents, money, isoDate, linesOf, extractPdf } from '../metlife/parser.js';

export { cents, money, isoDate, linesOf, extractPdf };

export function parseShortDos(s) {
  // Parses MM/DD/YY to YYYY-MM-DD
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(s || '');
  if (!m) return null;
  const [, mo, day, yy] = m;
  const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  const d = new Date(`${year}-${mo}-${day}T12:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === `${year}-${mo}-${day}` ? `${year}-${mo}-${day}` : null;
}

export function parseLibertyToothAndDesc(mid) {
  const trimmed = (mid || '').trim();
  // Tooth/Arch/Quadrant pattern: 1-32, A-T, Q01-Q04, UR, UL, LR, LL, UA, LA, FM
  const m = trimmed.match(/^([A-T]|3[0-2]|[12][0-9]|[1-9]|Q0[1-4]|UR|UL|LR|LL|UA|LA|FM)\s+(.*)$/i);
  if (m) {
    return {
      tooth: m[1].toUpperCase(),
      description: m[2].trim()
    };
  }
  return {
    tooth: null,
    description: trimmed
  };
}

export function parseLiberty(extracted) {
  const { pages, sha256 } = extracted;
  const fullText = pages.map((p) => p.lines.map((r) => r.text).join('\n')).join('\n\f\n');

  const errors = [];
  const warnings = [];

  const isLiberty =
    /LIBERTY Dental Plan/i.test(fullText) &&
    /PAYMENT DETAILS/i.test(fullText) &&
    /CLAIM:\s*\d+/i.test(fullText);

  if (!isLiberty) {
    errors.push('Không nhận diện được mẫu EOB của LIBERTY Dental Plan.');
  }

  // 1. Check & Vendor Header Information
  const checkNumberMatch = fullText.match(/Check Number:\s*([A-Za-z0-9]+)/i);
  const checkNumber = checkNumberMatch ? checkNumberMatch[1].trim() : '';

  const checkDateMatch = fullText.match(/Check Date:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const checkDateRaw = checkDateMatch ? checkDateMatch[1].trim() : '';
  const checkDate = isoDate(checkDateRaw);

  const vendorNameMatch = fullText.match(/VENDOR NAME:\s*(.+?)(?=\s*Check Number|\n)/i);
  const vendorName = vendorNameMatch ? vendorNameMatch[1].trim() : '';

  const vendorNumMatch = fullText.match(/VENDOR NUMBER:\s*([A-Za-z0-9]+)/i);
  const vendorNumber = vendorNumMatch ? vendorNumMatch[1].trim() : '';

  const officeMatch = fullText.match(/OFFICE:\s*(.+?)(?=\n|Patient:)/i);
  const office = officeMatch ? officeMatch[1].trim() : '';

  const netPaymentMatch = fullText.match(/NET PAYMENT\s*:\s*([\d,]+\.\d{2})/i);
  const netPaymentCents = netPaymentMatch ? cents(netPaymentMatch[1]) : 0;

  if (!checkNumber) errors.push('Không tìm thấy Check Number trong tài liệu Liberty.');
  if (!checkDate) errors.push('Không tìm thấy Check Date trong tài liệu Liberty.');

  // 2. Parse Claims (Document may contain 1 or multiple patients/claims)
  const patientSections = fullText.split(/(?=Patient:\s*)/).slice(1);
  if (!patientSections.length) {
    errors.push('Không tìm thấy khối bệnh nhân (Patient:) nào trong tài liệu Liberty.');
  }

  const claims = [];

  for (let i = 0; i < patientSections.length; i++) {
    const block = patientSections[i];

    // Patient info
    const patientMatch = block.match(/Patient:\s*([^-\n]+?)\s*-\s*([A-Za-z0-9-]+)/);
    const rawPatientName = patientMatch ? patientMatch[1].trim() : '';
    const memberId = patientMatch ? patientMatch[2].trim() : '';

    let lastName = '';
    let firstName = '';
    if (rawPatientName.includes(',')) {
      const [l, f] = rawPatientName.split(',');
      lastName = l.trim();
      firstName = f.trim();
    } else {
      lastName = rawPatientName;
    }

    const planMatch = block.match(/Plan\s*:\s*(.+?)(?=\s*Group|\n)/i);
    const planName = planMatch ? planMatch[1].trim() : '';

    const groupMatch = block.match(/Group\s*:\s*([\s\S]+?)(?=\n\s*CLAIM:)/i);
    const groupNumber = groupMatch ? groupMatch[1].replace(/\s+/g, ' ').trim() : '';

    const claimMatch = block.match(/CLAIM:\s*(\d+)(?:\s*\(([^)]+)\))?/i);
    const claimNumber = claimMatch ? claimMatch[1].trim() : '';
    const claimType = claimMatch && claimMatch[2] ? claimMatch[2].trim() : 'Original';

    const netPatientMatch = block.match(/NET PAYMENT FOR PATIENT\s*:\s*([\d,]+\.\d{2})/i);
    const netPatientPaidCents = netPatientMatch ? cents(netPatientMatch[1]) : 0;

    const claimTotalsMatch = block.match(
      /CLAIM TOTALS:\s*([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/i
    );

    const totals = {
      submittedCents: claimTotalsMatch ? cents(claimTotalsMatch[1]) : 0,
      allowedCents: claimTotalsMatch ? cents(claimTotalsMatch[2]) : 0,
      copayCents: claimTotalsMatch ? cents(claimTotalsMatch[3]) : 0,
      deductibleCents: claimTotalsMatch ? cents(claimTotalsMatch[4]) : 0,
      coinsuranceCents: claimTotalsMatch ? cents(claimTotalsMatch[5]) : 0,
      patientDueCents: claimTotalsMatch ? cents(claimTotalsMatch[6]) : 0,
      planPaidCents: claimTotalsMatch ? cents(claimTotalsMatch[7]) : netPatientPaidCents
    };

    // Procedures extraction
    const lines = block.split('\n');
    const procedures = [];

    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const line = lines[lIdx];
      // Procedure row regex: line# DOS(MM/DD/YY) CDT(D\d{4}) [tooth/desc] 7 amounts
      const procMatch = line.match(
        /^(\d+)\s+(\d{2}\/\d{2}\/\d{2})\s+(D\d{4})\s*(.*?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/
      );

      if (procMatch) {
        const lineNum = Number(procMatch[1]);
        const shortDos = procMatch[2];
        const dos = parseShortDos(shortDos);
        const code = procMatch[3];
        let mid = procMatch[4].trim();

        // Check if next line is a wrapped description continuation (not starting with procedure, CLAIM TOTALS, etc.)
        const nextLine = lines[lIdx + 1]?.trim() || '';
        if (
          nextLine &&
          !/^\d+\s+\d{2}\/\d{2}\/\d{2}/.test(nextLine) &&
          !/^CLAIM TOTALS/i.test(nextLine) &&
          !/^Patient:/i.test(nextLine) &&
          !/^\*Amount due/i.test(nextLine) &&
          !/^NET PAYMENT/i.test(nextLine)
        ) {
          mid += ` ${nextLine}`;
        }

        const { tooth, description } = parseLibertyToothAndDesc(mid);

        const subCents = cents(procMatch[5]);
        const allowCents = cents(procMatch[6]);
        const copayCents = cents(procMatch[7]);
        const dedCents = cents(procMatch[8]);
        const coinsCents = cents(procMatch[9]);
        const patDueCents = cents(procMatch[10]);
        const paidCents = cents(procMatch[11]);

        const status = paidCents > 0 || allowCents > 0 ? 'Approved' : 'Denied';

        procedures.push({
          line: lineNum,
          date: dos,
          code,
          tooth,
          surface: '',
          description,
          feeCents: subCents,
          submittedCents: subCents,
          allowedCents: allowCents,
          copayCents,
          deductibleCents: dedCents,
          coinsuranceCents: coinsCents,
          patientDueCents: patDueCents,
          benefitCents: paidCents,
          paidCents,
          status
        });
      }
    }

    if (!procedures.length) {
      errors.push(`Hồ sơ bệnh nhân ${rawPatientName} (Claim ${claimNumber}) không tìm thấy dịch vụ nào.`);
    }

    const calculatedPaidCents = procedures.reduce((sum, p) => sum + p.benefitCents, 0);
    if (totals.planPaidCents && calculatedPaidCents !== totals.planPaidCents) {
      warnings.push(`Claim ${claimNumber}: Tổng Plan Paid (${calculatedPaidCents}) không khớp CLAIM TOTALS (${totals.planPaidCents}).`);
    }

    // Prepare Open Dental Payment Payload for this claim (matching MetLife structure)
    const paymentPayload = {
      payType: 'Insurance Paid',
      checkNum: '',
      claimNum: claimNumber,
      payDate: checkDate,
      payNote: `Claim number: ${claimNumber}`,
      amountCents: totals.planPaidCents,
      amount: (totals.planPaidCents / 100).toFixed(2),
      splits: procedures
        .filter((p) => p.benefitCents > 0)
        .map((p) => ({
          code: p.code,
          date: p.date,
          tooth: p.tooth,
          amountCents: p.benefitCents,
          amount: (p.benefitCents / 100).toFixed(2),
          feeCents: p.benefitCents,
          description: p.description
        })),
      feesToUpdate: procedures.map((p) => ({
        code: p.code,
        fee: (p.benefitCents / 100).toFixed(2),
        isApproved: p.benefitCents > 0
      }))
    };

    claims.push({
      claimNumber,
      claimType,
      patient: {
        raw: rawPatientName,
        lastName,
        firstName,
        memberId
      },
      plan: {
        carrier: 'LIBERTY Dental Plan',
        name: planName,
        group: groupNumber
      },
      check: {
        number: checkNumber,
        date: checkDate
      },
      totals,
      procedures,
      paymentPayload
    });
  }

  // 3. Grand Totals Verification
  const totalClaimsPaidCents = claims.reduce((sum, c) => sum + c.totals.planPaidCents, 0);
  if (netPaymentCents > 0 && totalClaimsPaidCents !== netPaymentCents) {
    warnings.push(
      `Tổng chi trả các claim (${totalClaimsPaidCents}) không khớp NET PAYMENT toàn bộ check (${netPaymentCents}).`
    );
  }

  return {
    parserVersion: 1,
    sha256,
    pageCount: pages.length,
    carrier: 'LIBERTY Dental Plan',
    vendor: {
      name: vendorName,
      number: vendorNumber,
      office
    },
    check: {
      number: checkNumber,
      date: checkDate,
      dateRaw: checkDateRaw,
      netPaymentCents,
      netPaymentFormatted: money(netPaymentCents)
    },
    claimsCount: claims.length,
    claims,
    errors: [...new Set(errors)],
    warnings,
    text: fullText
  };
}
