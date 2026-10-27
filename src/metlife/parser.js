import { createHash } from 'node:crypto';

export function cents(value) {
  const s = String(value ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) throw new Error(`Invalid money: ${s}`);
  const negative = s.startsWith('-');
  const [whole, fraction = ''] = s.replace(/^-/, '').split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('Money exceeds supported range');
  return negative ? -result : result;
}

export const money = (n) =>
  `${n < 0 ? '-' : ''}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, '0')}`;

export function isoDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || '');
  if (!m) return null;
  const [, mo, day, year] = m;
  const d = new Date(`${year}-${mo}-${day}T12:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === `${year}-${mo}-${day}` ? `${year}-${mo}-${day}` : null;
}

export function linesOf(items) {
  const lines = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row = lines.find((r) => Math.abs(r.y - item.y) < 2);
    if (!row) {
      row = { y: item.y, items: [] };
      lines.push(row);
    }
    row.items.push(item);
  }
  return lines
    .sort((a, b) => a.y - b.y)
    .map((r) => ({
      ...r,
      text: r.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    }));
}

export async function extractPdf(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    stopAtErrors: true
  });
  let doc;
  try {
    doc = await task.promise;
    if (doc.numPages > 30) throw new Error('PDF vượt quá 30 trang; hãy tách đúng claim trước.');
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items
        .filter((i) => i.str?.trim())
        .map((i) => ({ str: i.str.trim(), x: i.transform[4], y: viewport.height - i.transform[5], width: i.width }));
      pages.push({ page: n, width: viewport.width, height: viewport.height, items, lines: linesOf(items) });
      page.cleanup();
    }
    return { pages, sha256: createHash('sha256').update(buffer).digest('hex') };
  } finally {
    await task.destroy();
  }
}

const take = (text, re) => text.match(re)?.[1]?.trim() || '';

export function parseMetlife(extracted) {
  const { pages, sha256 } = extracted;
  const text = pages.map((p) => p.lines.map((r) => r.text).join('\n')).join('\n\f\n');
  const errors = [],
    warnings = [...(extracted.warnings||[])];
  const template =
    /Claim Summary/.test(text) &&
    /Relationship to Subscriber:/.test(text) &&
    /Group Number:/.test(text) &&
    /Claim Detail/.test(text);
  if (!template)
    errors.push('Không nhận diện được mẫu MetLife Claim Summary đã hỗ trợ. PDF scan/Liberty/mẫu khác cần kiểm tra riêng.');
  if ((text.match(/Claim Number:/g) || []).length !== 1) errors.push('PDF phải chứa đúng một Claim Number.');
  const claimRaw = take(text, /Claim Number:\s*([\d ]+?)(?=Patient Name:|\n)/);
  const claimBase = claimRaw.match(/^\d+/)?.[0] || '';
  const patient = take(text, /Patient Name:\s*(.+?)(?=Provider ID:|\n)/);
  const subscriber = take(text, /Subscriber Name:\s*(.+?)(?=\n)/);
  const group = take(text, /Group Number:\s*([^\s]+)/);
  const processed = isoDate(take(text, /PROCESSED on\s*(\d{2}\/\d{2}\/\d{4})/));
  const received = isoDate(take(text, /Date Received:\s*(\d{2}\/\d{2}\/\d{4})/));
  if(!processed) errors.push('Thiếu ngày PROCESSED on của MetLife.');
  if (!claimRaw || !patient || !subscriber || !group)
    errors.push('Thiếu claim number, patient, subscriber hoặc group number.');
  const procedures = [];
  const benefits = [];
  let paymentSection = false;
  const payments = [];
  for (const p of pages) {
    const claimDetail = p.lines.find((r) => r.text === 'Claim Detail');
    const paymentHeading = p.lines.find((r) => r.text === 'Payment Detail');
    const notesHeading = p.lines.find((r) => r.text.startsWith('Notes to Claimant'));
    const codeItems = p.items
      .filter(
        (i) =>
          /^\(?\s*D\d{4}\s*\)?$/.test(i.str) &&
          (!claimDetail || i.y > claimDetail.y) &&
          (!paymentHeading || i.y < paymentHeading.y)
      )
      .sort((a, b) => a.y - b.y);
    const totalLines = p.lines.filter((r) => /^Total\b/.test(r.text));
    if (codeItems.length) {
      const end = totalLines.find((r) => r.y > codeItems.at(-1).y)?.y;
      const headerItems=p.items.filter(i=>i.y<codeItems[0].y&&(!claimDetail||i.y>claimDetail.y));
      const moneyHeaders=['Charged','Negotiated','Expense','Applied','Plan'].map(label=>headerItems.find(i=>i.str===label)?.x/p.width);
      const hasMoneyHeaders=moneyHeaders.every(Number.isFinite)&&moneyHeaders.every((x,i)=>!i||x>moneyHeaders[i-1]);
      const columnBounds=hasMoneyHeaders?moneyHeaders.map((x,i)=>i?(x+moneyHeaders[i-1])/2:Math.max(0,x-(moneyHeaders[1]-x)/2)):null;
      if (!end) errors.push(`Trang ${p.page}: không tìm thấy Total của Claim Detail.`);
      for (let i = 0; i < codeItems.length; i++) {
        const c = codeItems[i];
        const row = p.items.filter((t) => t.y >= c.y - 2 && t.y < (codeItems[i + 1]?.y ?? end) - 2);
        const rowText = linesOf(row)
          .map((r) => r.text)
          .join(' ');
        const currency = (lo, hi) =>
          row.flatMap((t) => {
            if (t.x / p.width < lo || t.x / p.width >= hi) return [];
            const matches = t.str.match(/\$[\d,]+\.\d{2}/g);
            return matches ? matches.map((m) => cents(m)) : [];
          });
        const field = (lo, hi) => {
          const a = currency(lo, hi);
          return a.length === 1 ? a[0] : null;
        };
        const code = c.str.match(/D\d{4}/)[0];
        const moneyColumn=(index,lo,hi)=>columnBounds?field(columnBounds[index],columnBounds[index+1]??0.93):field(lo,hi);
        let benefit = moneyColumn(4,0.8,0.93);
        if (benefit === null) {
          // Fallback: in MetLife EOB row, benefit is the last dollar amount before notes
          const allCurrencies = [...rowText.matchAll(/\$[\d,]+\.\d{2}/g)].map((m) => cents(m[0]));
          if (allCurrencies.length >= 1) {
            benefit = allCurrencies.at(-1);
          }
        }
        if (benefit === null) errors.push(`${code}: không xác định duy nhất Plan Benefit.`);
        const teeth = row
          .filter((t) => t.x / p.width >= 0.38 && t.x / p.width < 0.46)
          .map((t) => t.str)
          .filter((t) => /^([A-T]|0?[1-9]|[12][0-9]|3[0-2])$/.test(t));
        const areaText=row.filter(t=>t.x/p.width>=0.30&&t.x/p.width<0.46).map(t=>t.str).join(' ').toUpperCase();
        const quadrants=[...new Set([...areaText.matchAll(/\b(?:UR|UL|LR|LL|Q0[1-4])\b/g)].map(m=>({Q01:'UR',Q02:'UL',Q03:'LL',Q04:'LR'}[m[0]]||m[0])))];
        if(/^D434[12]$/.test(code)&&quadrants.length>1)errors.push(`${code}: vùng hàm không xác định duy nhất.`);
        procedures.push({
          code,
          tooth: teeth.length === 1 ? (/^\d+$/.test(teeth[0])?String(Number(teeth[0])):teeth[0]) : null,
          surface: /^D434[12]$/.test(code)&&quadrants.length===1?quadrants[0]:'',
          date: isoDate(take(rowText, /(\d{2}\/\d{2}\/\d{4})/)),
          status: /\bDenied\b/i.test(rowText) ? 'Denied' : /\bApproved\b/i.test(rowText) ? 'Approved' : 'Unknown',
          feeCents: moneyColumn(0,0.44,0.56),
          benefitCents: benefit,
          coveredCents: moneyColumn(2,0.62,0.73),
          deductibleCents: moneyColumn(3,0.72,0.82),
          bundled: /Allowable/i.test(rowText),
          page: p.page,
          evidence: rowText
        });
      }
      const total = totalLines.find((r) => r.y > codeItems.at(-1).y);
      const b = total?.items.flatMap((i) => {
        if (i.x / p.width < 0.78 || i.x / p.width >= 0.95) return [];
        const m = i.str.match(/\$[\d,]+\.\d{2}/);
        return m ? [cents(m[0])] : [];
      });
      if (b?.length === 1) benefits.push(b[0]);
    }
    if (paymentHeading) paymentSection = true;
    if (paymentSection) {
      const rows = p.lines.filter(
        (r) => (!paymentHeading || r.y > paymentHeading.y) && (!notesHeading || r.y < notesHeading.y)
      );
      for (const row of rows) {
        const dateItem = row.items.filter((i) => i.x / p.width >= 0.12 && i.x / p.width < 0.28 && isoDate(i.str));
        const amountItem = row.items.filter(
          (i) => i.x / p.width >= 0.24 && i.x / p.width < 0.40 && /^\$[\d,]+\.\d{2}$/.test(i.str)
        );
        if (dateItem.length === 1 && amountItem.length === 1) {
          const method = row.items
            .filter((i) => i.x / p.width >= 0.6 && i.x / p.width < 0.73)
            .map((i) => i.str)
            .join(' ');
          const trace = row.items
            .filter((i) => i.x / p.width >= 0.73)
            .map((i) => i.str)
            .join(' ');
          const status = rows
            .filter((r) => Math.abs(r.y - row.y) < 14)
            .flatMap((r) => r.items.filter((i) => i.x / p.width < 0.14))
            .map((i) => i.str)
            .join(' ');
          payments.push({
            date: isoDate(dateItem[0].str),
            amountCents: cents(amountItem[0].str),
            method,
            trace,
            status,
            page: p.page,
            evidence: row.text
          });
        }
      }
    }
    if (notesHeading) paymentSection = false;
  }
  if (!procedures.length) errors.push('Không đọc được bảng dịch vụ.');
  if (benefits.length !== 1) errors.push('Không đọc được một tổng Plan Benefit duy nhất.');
  if (payments.length !== 1)
    errors.push('Cần đúng một dòng thanh toán; nhiều dòng hoặc thiếu trang cần kiểm tra riêng.');
  const payment = payments.length === 1 ? payments[0] : null;
  const benefitCents = benefits.length === 1 ? benefits[0] : null;
  if (payment && !/Paid\s*\/?\s*Settled/i.test(payment.status))
    errors.push('Trạng thái thanh toán không phải Paid / Settled.');
  if (payment && (!payment.trace || !/^(EFT|Check|ACH)$/i.test(payment.method)))
    errors.push('Thiếu trace/check number hoặc payment method chưa hỗ trợ.');
  if (payment && payment.amountCents <= 0) errors.push('Số tiền thực trả phải lớn hơn 0.');
  if (
    procedures.every((r) => r.benefitCents !== null) &&
    benefitCents !== null &&
    procedures.reduce((n, r) => n + r.benefitCents, 0) !== benefitCents
  )
    errors.push('Tổng Plan Benefit từng dịch vụ không khớp Total.');
  if (payment && payment.amountCents !== benefitCents) errors.push('Benefit Paid không khớp tổng Plan Benefit.');
  if (procedures.some((r) => r.bundled))
    warnings.push('Có dịch vụ Allowable/bundled: cần xác định procedure OD tương ứng; không phân bổ theo phí gốc.');
  if (claimRaw !== claimBase) warnings.push('Giữ nguyên claim number đầy đủ, bao gồm phần số sau dấu cách.');
  if (!/MetLife/i.test(text))
    warnings.push('Logo MetLife là ảnh: nhận diện theo bố cục; phải đối chiếu carrier MetLife trong OD.');
  return {
    parserVersion: 1,
    sha256,
    pageCount: pages.length,
    template: template ? 'metlife-claim-summary-v1' : null,
    claimRaw,
    claimBase,
    patient,
    subscriber,
    group,
    received,
    processed,
    payment,
    benefitCents,
    procedures,
    errors: [...new Set(errors)],
    warnings,
    text
  };
}
