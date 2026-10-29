import {cents,money} from '../metlife/parser.js';

const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
export function isCignaStatement(text){
 const s=clean(text);
 return /Cigna Dental/i.test(s)&&/Explanation of dental payment/i.test(s)&&/DOCUMENT\s*#\s*:/i.test(s)&&/PROCESSED DATE:/i.test(s);
}
function date(value){
 const m=/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(clean(value));
 const month=m&&['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase())+1;
 if(!m||!month)return null;
 const iso=`${m[3]}-${String(month).padStart(2,'0')}-${m[2].padStart(2,'0')}`,d=new Date(iso+'T12:00:00Z');
 return Number.isFinite(+d)&&d.toISOString().slice(0,10)===iso?iso:null;
}
const number='\\$?\\d[\\d,]*\\.\\d{2}';
const rowPattern=new RegExp(`^(${number}) (${number}) (${number}) (${number}) (${number}) (${number}) (\\d+(?:\\.\\d+)?)% (${number})$`);
const totalPattern=new RegExp(`^(${Array(7).fill(number).join(') (')})$`);
const keys=['feeCents','contractedCents','allowedCents','deductibleCents','coveredCents','coinsuranceCents','benefitCents'];

export function parseCignaStatement(extracted){
 const claims=[],byId=new Map(),errors=[],warnings=[...(extracted.warnings||[])];
 try{
  const fail=s=>{throw new Error(s);};
  for(const page of extracted.pages){
   const lines=page.lines.map(l=>clean(l.text)).filter(Boolean),text=lines.join('\n');
   const serviceLines=lines.map((s,i)=>/^For service on\b/i.test(s)?i:-1).filter(i=>i>=0);
   if(!serviceLines.length){
    if(/DOCUMENT\s*#\s*:/i.test(text)||lines.some(s=>/Amount paid by the plan/i.test(s)))fail('CIGNA statement: trang claim có dữ liệu chưa đọc đủ dịch vụ.');
    continue; // Definitions, blank pages and appeal instructions carry no claim rows.
   }
   const header=/DOCUMENT\s*#\s*:\s*([A-Z0-9-]+)\s+CLAIMANT\s*#\s*:\s*(\d+)\s+CLAIM\s*#\s*:\s*(\d+)\s+PAYMENT\s*#\s*:\s*(\d+)/i.exec(text);
   const processed=date(/PROCESSED DATE:\s*([A-Za-z]{3}\s+\d{1,2},\s*\d{4})/i.exec(text)?.[1]);
   const name=/PATIENT NAME:\s*(.+?)\s+SUBSCRIBER NAME:/i.exec(text)?.[1];
   if(!header||!processed||!name)fail('CIGNA statement: thiếu DOCUMENT / CLAIMANT / CLAIM hoặc Processed Date / bệnh nhân.');
   // CLAIM # alone is a short sequence (e.g. 002), not a globally unique ID.
   const claimNumber=`${header[1]}-${header[2]}-${header[3]}`;
   let claim=byId.get(claimNumber);
   if(!claim){
    const parts=name.split(' ');
    claim={claimNumber,documentNumber:header[1],claimantNumber:header[2],sourceClaimNumber:header[3],paymentSequence:header[4],patient:{raw:name,firstName:parts.slice(0,-1).join(' '),lastName:parts.at(-1),memberId:/PATIENT ID:\s*(\S+)/i.exec(text)?.[1]||''},date:processed,procedures:[],printedTotals:null,planPaid:null,responsibility:null,plan:{carrier:'CIGNA',group:/GROUP\s*#\s*:\s*(\S+)/i.exec(text)?.[1]||''}};
    claims.push(claim);byId.set(claimNumber,claim);
   }
   if(claim.date!==processed||claim.paymentSequence!==header[4])fail('CIGNA statement: trang tiếp theo khác ngày xử lý hoặc đợt thanh toán.');
   const columns=lines.slice(0,serviceLines[0]).join(' ');
   if(!/AMOUNT YOU CONTRACTED FOR COVERAGE PATIENT COPAY\/ REMAINING PATIENT/i.test(columns)||!/CHARGED \(\$\) AMOUNT \(\$\) BY THE PLAN \(\$\) DEDUCTIBLE \(\$\) BALANCE \(\$\) COINSURANCE \(\$\) \(%\) \(\$\)/i.test(columns)||!/THE PLAN COVERED/i.test(columns))fail('CIGNA statement: chưa xác nhận đúng thứ tự các cột tiền.');
   for(const i of serviceLines){
    const label=/^For service on ([A-Za-z]{3}\s+\d{1,2},\s*\d{4}):\s*(D\d{4})\*?$/i.exec(lines[i]),row=rowPattern.exec(lines[i+1]||'');
    if(!label||!date(label[1])||!row)fail('CIGNA statement: ngày, mã hoặc tám cột của dòng dịch vụ chưa rõ.');
    const a=[...row.slice(1,7),row[8]].map(cents),percent=Number(row[7]);
    const [charged,contracted,eligible,deductible,remaining,coinsurance,paid]=a;
    if(a.some(n=>n<0)||percent>100||eligible>charged||contracted>charged||eligible-deductible!==remaining||coinsurance+paid!==remaining||Math.round(remaining*percent/100)!==paid)fail(`${label[2]}: CIGNA statement có cột tiền/tỷ lệ chưa khớp.`);
    if(claim.procedures.some(p=>p.code===label[2]&&p.date===date(label[1])))fail('CIGNA statement: trùng mã/ngày không có răng để phân biệt; cần đối chiếu.');
    claim.procedures.push({code:label[2],date:date(label[1]),tooth:'',...Object.fromEntries(keys.map((k,j)=>[k,a[j]])),percent,notAllowedCents:charged-eligible,copayCents:0,patientDueCents:charged-paid,status:paid>0?'Approved':'Denied',page:page.page});
   }
   const totals=lines.slice(serviceLines.at(-1)+2).filter(s=>totalPattern.test(s));
   if(totals.length>1||claim.printedTotals&&totals.length)fail('CIGNA statement: tổng claim xuất hiện nhiều lần.');
   if(totals.length)claim.printedTotals=totalPattern.exec(totals[0]).slice(1).map(cents);
   const plan=/^Amount paid by the plan\s+(\$[\d,]+\.\d{2})$/im.exec(text);
   const responsibility=/^Customer['’]s responsibility\s+(\$[\d,]+\.\d{2})$/im.exec(text);
   if(plan)claim.planPaid=cents(plan[1]);
   if(responsibility)claim.responsibility=cents(responsibility[1]);
  }
  if(!claims.length)fail('Không nhận diện được claim CIGNA statement.');
  for(const c of claims){
   const totals=keys.map(k=>c.procedures.reduce((s,p)=>s+p[k],0));
   if(!c.printedTotals||totals.some((s,i)=>s!==c.printedTotals[i])||c.planPaid!==totals[6]||c.responsibility!==totals[0]-totals[6])fail(`Claim ${c.claimNumber}: thiếu trang hoặc tổng cột / Amount paid / trách nhiệm bệnh nhân không khớp.`);
   c.procedures=c.procedures.map((p,i)=>({...p,line:i+1}));c.status='PROCESSED';c.headerPaidCents=c.planPaid;c.totals={planPaidCents:c.planPaid};c.check={number:'',date:c.date};
   c.paymentPayload={payType:'Insurance Paid',checkNum:'',claimNum:c.documentNumber,payDate:c.date,payNote:`Claim number: ${c.documentNumber}`,amountCents:c.planPaid,amount:money(c.planPaid),splits:c.procedures.filter(p=>p.benefitCents>0).map(p=>({code:p.code,tooth:p.tooth,date:p.date,amountCents:p.benefitCents,amount:money(p.benefitCents)}))};
  }
  const summaries=[...extracted.pages.flatMap(p=>p.lines.map(l=>clean(l.text))).join('\n').matchAll(/^Payment amount:\s*(\$[\d,]+\.\d{2})$/gim)].map(m=>cents(m[1]));
  if(summaries.length!==1||summaries[0]!==claims.reduce((s,c)=>s+c.planPaid,0))fail('CIGNA statement: Payment Summary không khớp tổng các claim hoặc thiếu trang đầu.');
 }catch(e){errors.push(e.message);}
 return {carrier:'CIGNA',sourceTemplate:'payment-statement',parserVersion:1,sha256:extracted.sha256,pageCount:extracted.pages.length,claimsCount:claims.length,claims,check:{number:'',date:claims[0]?.date,netPaymentCents:claims.reduce((s,c)=>s+(c.totals?.planPaidCents||0),0)},settlementBasis:'The Plan Covered / Amount paid by the plan',errors,warnings};
}
