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
const labelPattern=/^For service on ([A-Za-z]{3}\s+\d{1,2},\s*\d{4}):\s*(D\d{4})\*?(?:\s+for Tooth#\/Quad\/Arch:\s*(0?[1-9]|[12]\d|3[0-2]|Q0[1-4]|UR|UL|LR|LL|UA|LA|FM|[A-T]))?(?:\s+\(see note ([A-Z]{1,3})\))?$/i;
const fail=s=>{throw new Error(s);};

function normalizeAlternates(claim,notes){
 const used=new Set(),normalized=[];
 for(const p of claim.rawProcedures.filter(p=>p.benefitCents>0)){
  let target=p;
  if(p.feeCents===0){
   const originals=claim.rawProcedures.filter(r=>r.date===p.date&&r.tooth===p.tooth&&r.feeCents>0&&r.benefitCents===0);
   if(originals.length!==1||!/alternate benefit/i.test(notes.get(p.explanationCode)||'')||!/alternate benefit/i.test(notes.get(originals[0]?.explanationCode)||''))fail(`${p.code}: chưa xác nhận duy nhất dịch vụ gốc và ghi chú alternate benefit.`);
   target=originals[0];
  }
  if(p.allowedCents>target.feeCents||p.benefitCents>target.feeCents)fail(`${p.code}: quyền lợi thay thế vượt phí dịch vụ gốc.`);
  if(used.has(target)||used.has(p))fail('CIGNA statement: nhiều dòng quyền lợi dùng cùng một dịch vụ gốc.');
  used.add(target);used.add(p);
  normalized.push({...target,allowedCents:p.allowedCents,deductibleCents:p.deductibleCents,coveredCents:p.coveredCents,coinsuranceCents:p.coinsuranceCents,benefitCents:p.benefitCents,percent:p.percent,notAllowedCents:target.feeCents-p.allowedCents,patientDueCents:target.feeCents-p.benefitCents,status:'Approved',alternateCode:target===p?null:p.code});
 }
 normalized.push(...claim.rawProcedures.filter(p=>!used.has(p)));
 return normalized.map((p,i)=>({...p,line:i+1}));
}

export function parseCignaStatement(extracted){
 const claims=[],byId=new Map(),errors=[],warnings=[...(extracted.warnings||[])];
 const fullText=extracted.pages.flatMap(p=>p.lines.map(l=>clean(l.text))).join('\n');
 const notes=new Map([...fullText.matchAll(/(?:^|\n)([A-Z]{1,3})\s*-\s*([\s\S]*?)(?=\n[A-Z]{1,3}\s*-|$)/g)].map(m=>[m[1],clean(m[2])]));
 try{
  for(const page of extracted.pages){
   const lines=page.lines.map(l=>clean(l.text)).filter(Boolean);
   const starts=lines.map((s,i)=>/^PATIENT NAME:/i.test(s)?i:-1).filter(i=>i>=0);
   if(!starts.length){
    if(lines.some(s=>/^(?:For service on|Amount paid by the plan)/i.test(s))||/DOCUMENT\s*#\s*:/i.test(lines.join(' ')))fail('CIGNA statement: có dịch vụ/tổng tiền nhưng thiếu khối bệnh nhân.');
    continue;
   }
   if(lines.slice(0,starts[0]).some(s=>/^For service on/i.test(s)))fail('CIGNA statement: có dịch vụ trước khối bệnh nhân.');
   // A page can finish one patient's claim and begin another patient's claim.
   for(const [b,start] of starts.entries()){
    const block=lines.slice(start,starts[b+1]??lines.length),text=block.join('\n');
    const serviceLines=block.map((s,i)=>/^For service on\b/i.test(s)?i:-1).filter(i=>i>=0);
    if(!serviceLines.length)fail('CIGNA statement: khối bệnh nhân chưa đọc đủ dịch vụ.');
    const header=/DOCUMENT\s*#\s*:\s*([A-Z0-9-]+)\s+CLAIMANT\s*#\s*:\s*(\d+)\s+CLAIM\s*#\s*:\s*(\d+)\s+PAYMENT\s*#\s*:\s*(\d+)/i.exec(text);
    const processed=date(/PROCESSED DATE:\s*([A-Za-z]{3}\s+\d{1,2},\s*\d{4})/i.exec(text)?.[1]);
    const name=/PATIENT NAME:\s*(.+?)\s+SUBSCRIBER NAME:/i.exec(text)?.[1];
    if(!header||!processed||!name)fail('CIGNA statement: thiếu DOCUMENT / CLAIMANT / CLAIM hoặc Processed Date / bệnh nhân.');
    const claimNumber=header[1],memberId=/PATIENT ID:\s*(\S+)/i.exec(text)?.[1]||'';
    let claim=byId.get(claimNumber);
    if(!claim){
     const parts=name.split(' ');
     claim={claimNumber,documentNumber:claimNumber,legacyClaimNumbers:[`${claimNumber}-${header[2]}-${header[3]}`],claimantNumber:header[2],sourceClaimNumber:header[3],paymentSequence:header[4],patient:{raw:name,firstName:parts.slice(0,-1).join(' '),lastName:parts.at(-1),memberId},date:processed,rawProcedures:[],printedTotals:null,planPaid:null,responsibility:null,plan:{carrier:'CIGNA',group:/G\s*ROUP\s*#\s*:\s*(\S+)/i.exec(text)?.[1]||''}};
     claims.push(claim);byId.set(claimNumber,claim);
    }
    if(claim.date!==processed||claim.paymentSequence!==header[4]||claim.claimantNumber!==header[2]||claim.sourceClaimNumber!==header[3]||claim.patient.memberId!==memberId)fail(`Claim ${claimNumber}: khối tiếp theo khác bệnh nhân/claim/ngày/đợt thanh toán.`);
    const columns=block.slice(0,serviceLines[0]).join(' ');
    if(!/AMOUNT YOU CONTRACTED FOR COVERAGE PATIENT COPAY\/ REMAINING PATIENT/i.test(columns)||!/CHARGED \(\$\) AMOUNT \(\$\) BY THE PLAN \(\$\) DEDUCTIBLE \(\$\) BALANCE \(\$\) COINSURANCE \(\$\) \(%\) \(\$\)/i.test(columns)||!/THE PLAN COVERED/i.test(columns))fail('CIGNA statement: chưa xác nhận đúng thứ tự các cột tiền.');
    for(const i of serviceLines){
     const label=labelPattern.exec(block[i]),row=rowPattern.exec(block[i+1]||'');
     if(!label||!date(label[1])||!row)fail(`CIGNA statement: ngày, mã hoặc tám cột dịch vụ trang ${page.page||'?'} chưa rõ.`);
     const a=[...row.slice(1,7),row[8]].map(cents),percent=Number(row[7]);
     const [charged,contracted,eligible,deductible,remaining,coinsurance,paid]=a;
     if(a.some(n=>n<0)||percent>100||(eligible>charged&&!(charged===0&&paid>0))||contracted>charged||eligible-deductible!==remaining||coinsurance+paid!==remaining||Math.round(remaining*percent/100)!==paid)fail(`${label[2]}: CIGNA statement có cột tiền/tỷ lệ chưa khớp.`);
     const tooth=label[3]?(/^\d+$/.test(label[3])?String(Number(label[3])):label[3].toUpperCase()):'';
     if(claim.rawProcedures.some(p=>p.code===label[2]&&p.date===date(label[1])&&p.tooth===tooth))fail('CIGNA statement: trùng mã/ngày/răng; cần đối chiếu.');
     claim.rawProcedures.push({code:label[2],date:date(label[1]),tooth,explanationCode:label[4]||'',...Object.fromEntries(keys.map((k,j)=>[k,a[j]])),percent,notAllowedCents:Math.max(0,charged-eligible),copayCents:0,patientDueCents:Math.max(0,charged-paid),status:paid>0?'Approved':'Denied',page:page.page});
    }
    const totals=block.slice(serviceLines.at(-1)+2).filter(s=>totalPattern.test(s));
    if(totals.length>1||claim.printedTotals&&totals.length)fail('CIGNA statement: tổng claim xuất hiện nhiều lần.');
    if(totals.length)claim.printedTotals=totalPattern.exec(totals[0]).slice(1).map(cents);
    const plan=/^Amount paid by the plan\s+(\$[\d,]+\.\d{2})$/im.exec(text),responsibility=/^Customer['’]s responsibility\s+(\$[\d,]+\.\d{2})$/im.exec(text);
    if(plan)claim.planPaid=cents(plan[1]);if(responsibility)claim.responsibility=cents(responsibility[1]);
   }
  }
  if(!claims.length)fail('Không nhận diện được claim CIGNA statement.');
  for(const c of claims){
   const totals=keys.map(k=>c.rawProcedures.reduce((s,p)=>s+p[k],0));
   if(!c.printedTotals||totals.some((s,i)=>s!==c.printedTotals[i])||c.planPaid!==totals[6]||c.responsibility!==totals[0]-totals[6])fail(`Claim ${c.claimNumber}: thiếu trang hoặc tổng cột / Amount paid / trách nhiệm bệnh nhân không khớp.`);
   c.procedures=normalizeAlternates(c,notes);c.status='PROCESSED';c.headerPaidCents=c.planPaid;c.totals={planPaidCents:c.planPaid};c.check={number:'',date:c.date};
   c.paymentPayload={payType:'Insurance Paid',checkNum:'',claimNum:c.claimNumber,payDate:c.date,payNote:`Claim number: ${c.claimNumber}`,amountCents:c.planPaid,amount:money(c.planPaid),splits:c.procedures.filter(p=>p.benefitCents>0).map(p=>({code:p.code,tooth:p.tooth,date:p.date,amountCents:p.benefitCents,amount:money(p.benefitCents)}))};
  }
  const summaries=[...fullText.matchAll(/^Payment amount:\s*(\$[\d,]+\.\d{2})$/gim)].map(m=>cents(m[1]));
  if(summaries.length!==1||summaries[0]!==claims.reduce((s,c)=>s+c.planPaid,0))fail('CIGNA statement: Payment Summary không khớp tổng các claim hoặc thiếu trang đầu.');
 }catch(e){errors.push(e.message);}
 return {carrier:'CIGNA',sourceTemplate:'payment-statement',parserVersion:2,sha256:extracted.sha256,pageCount:extracted.pages.length,claimsCount:claims.length,claims,check:{number:'',date:claims[0]?.date,netPaymentCents:claims.reduce((s,c)=>s+(c.totals?.planPaidCents||0),0)},settlementBasis:'The Plan Covered / Amount paid by the plan',errors,warnings};
}
