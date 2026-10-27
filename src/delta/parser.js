import {cents,isoDate,money} from '../metlife/parser.js';
import {normalizeTooth} from '../metlife/procedureIdentity.js';

const amounts=text=>[...text.matchAll(/\$([\d,]+\.\d{2})/g)].map(m=>cents(m[1]));
const signature=p=>JSON.stringify([p.date,p.code,p.tooth,p.feeCents,p.allowedCents,p.maximumCents,p.deductibleCents,p.percent,p.benefitCents,p.patientDueCents,p.explanationCode]);
const fail=(message)=>Object.assign(new Error(message),{code:'EOB_REVIEW_REQUIRED'});

export function parseDelta(extracted){
 const errors=[],warnings=[],claims=[],claimTexts=new Map();let current;
 try{
 for(const page of extracted.pages){
  const lines=page.lines.map(l=>l.text.trim()).filter(Boolean),text=lines.join('\n');
  const ids=[...text.matchAll(/^Claim\s+(\d{8,20})$/gm)].map(m=>m[1]);
  if(ids.length>1)throw fail('Trang Delta có nhiều claim; cần tách rõ thông tin bệnh nhân.');
  if(ids.length){
   if(!/DELTA DENTAL/i.test(text)||!/Provider Tools/i.test(text))throw fail('Không nhận diện đúng mẫu Delta Provider Tools.');
   if(claims.some(c=>c.claimNumber===ids[0]))throw fail('Thông tin đầu claim Delta xuất hiện nhiều lần.');
   const nameIndex=lines.findIndex(l=>/^Patient date of birth\b/i.test(l));
   const name=lines[nameIndex-1]||'',parts=name.split(/\s+/);
   const birth=lines[nameIndex+1]?.match(/\d{2}\/\d{2}\/\d{4}/)?.[0];
   const memberIndex=lines.findIndex(l=>/Subscriber ID/.test(l));
   const member=lines[memberIndex+1]?.match(/\b\d{6,20}\b/)?.[0];
   const dateIndex=lines.findIndex(l=>/^Date payment sent$/i.test(l));
   const payDate=isoDate(lines[dateIndex+1]);
   const amountIndex=lines.findIndex(l=>/^Amount\b.*Payment status updated/i.test(l));
   const headerPaid=amountIndex>=0?amounts(lines[amountIndex+1])[0]:null;
   current={claimNumber:ids[0],patient:{raw:name,firstName:parts.slice(0,-1).join(' '),lastName:parts.at(-1),memberId:member||'',birthdate:isoDate(birth)},date:payDate,headerPaidCents:headerPaid,rawProcedures:[],printedTotals:null};
   if(parts.length<2||!current.patient.birthdate||!member||!payDate||!Number.isSafeInteger(headerPaid)||!/\bCleared\b|\bPaid\b/.test(text))throw fail('Thiếu thông tin bệnh nhân, ngày gửi tiền hoặc trạng thái thanh toán Delta.');
   claims.push(current);
  }
  if(current)claimTexts.set(current.claimNumber,(claimTexts.get(current.claimNumber)||'')+'\n'+text);
  const rows=[];
  for(const line of lines){
   if(/[-−]\$|\$\s*[-−]/.test(line))throw fail('Claim Delta có số tiền âm; cần đối chiếu trước khi xử lý.');
   const match=/^(?:\S+\s+)?(\d{2}\/\d{2}\/\d{4})\s+(D\d{4})\s+(\S+)/.exec(line);
   if(match){
    if(!current)throw fail('Có dịch vụ Delta nhưng thiếu thông tin claim.');
    const a=amounts(line),percent=Number(/(\d+(?:\.\d+)?)%/.exec(line)?.[1]),date=isoDate(match[1]),tooth=match[3]==='-'?'':normalizeTooth(match[3]);
    if(a.length!==6||!date||!Number.isFinite(percent)||percent<0||percent>100||!/^(?:|[1-9]|[12]\d|3[0-2]|[A-T]|Q0[1-4]|UR|UL|LR|LL|UA|LA|FM)$/.test(tooth))throw fail('Dòng Delta thiếu ngày, răng, tỷ lệ hoặc cột tiền.');
    const [feeCents,allowedCents,maximumCents,deductibleCents,benefitCents,patientDueCents]=a;
    const calculatedBenefit=Math.round(Math.max(0,maximumCents-deductibleCents)*percent/100);
    if(calculatedBenefit!==benefitCents){
     // The printed benefit can be reduced below the contract percentage.
     // Accept it only when the patient's printed share reconciles the accepted
     // fee; all six claim-total columns must still reconcile below.
     if(benefitCents>calculatedBenefit||benefitCents+patientDueCents!==allowedCents)throw fail('Tiền Delta trả không khớp mức hưởng và tỷ lệ trên dòng dịch vụ.');
     warnings.push(`Claim ${current.claimNumber}, ${match[2]} ngày ${date}: dùng Delta Dental pays ${money(benefitCents)} thấp hơn mức tính theo tỷ lệ ${money(calculatedBenefit)}; đã khớp phần bệnh nhân trả với Accepted fee.`);
    }
    const explanationCode=/^([A-Z]+)\s+\d{2}\//.exec(line)?.[1]||'';
    rows.push({date,code:match[2],tooth,feeCents,allowedCents,maximumCents,deductibleCents,benefitCents,patientDueCents,percent,explanationCode});
   }else if(/\bD\d{4}\b/.test(line)&&line.includes('$'))throw fail('Có dòng dịch vụ Delta chưa đọc đầy đủ.');
   if(/^Claim total\b/i.test(line)){
    if(!current||current.printedTotals)throw fail('Tổng claim Delta bị thiếu hoặc lặp.');
    const a=amounts(line);if(a.length!==6)throw fail('Chưa đọc đủ tổng các cột Delta.');current.printedTotals=a;
   }
  }
  if(rows.length){
   // Portal printouts can repeat the bottom of one page at the top of the next.
   // Remove only an exact suffix/prefix overlap, never same-code rows globally.
   let overlap=0;
   if(!ids.length)for(let n=1;n<=Math.min(rows.length,current.rawProcedures.length);n++)if(rows.slice(0,n).every((p,i)=>signature(p)===signature(current.rawProcedures.at(-n+i))))overlap=n;
   if(overlap)warnings.push(`Claim ${current.claimNumber}: bỏ ${overlap} dòng lặp chính xác tại chỗ nối trang.`);
   current.rawProcedures.push(...rows.slice(overlap));
  }
 }
 for(const claim of claims){
  if(!claim.printedTotals||!claim.rawProcedures.length)throw fail('Thiếu trang tiếp theo hoặc tổng claim Delta.');
  const groups=new Map();for(const p of claim.rawProcedures){const key=JSON.stringify([p.date,p.code,p.tooth]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);}
  const normalized=[];
  for(const rows of groups.values()){
   if(rows.length===1){normalized.push({...rows[0]});continue;}
   const paid=rows.filter(p=>p.benefitCents>0),denied=rows.filter(p=>p.benefitCents===0);
   if(rows.length!==2||paid.length!==1||denied.length!==1||!denied[0].feeCents)throw fail('Các dòng cùng mã/ngày/răng Delta chưa xác định duy nhất; cần đối chiếu.');
   normalized.push({...paid[0],feeCents:denied[0].feeCents});
  }
  const keys=['feeCents','allowedCents','maximumCents','deductibleCents','benefitCents','patientDueCents'];
  const totals=keys.map(k=>normalized.reduce((n,p)=>n+p[k],0));
  if(totals[0]!==claim.printedTotals[0]){
   // FLB replaces separate radiographs with a complete series. The portal
   // excludes their submitted fees from Claim total, while still printing
   // the original rows. Preserve those rows/fees for history and reporting.
   const claimText=claimTexts.get(claim.claimNumber)||'';
   const flbExplained=/\bFLB:\s*The combined fees for radiographic images[\s\S]*?equivalent to a complete series\b/i.test(claimText);
   const bundled=normalized.filter(p=>p.explanationCode==='FLB'&&/^D0(?:220|230|274)$/.test(p.code)&&keys.slice(1).every(k=>p[k]===0)&&normalized.some(s=>s.code==='D0210'&&s.date===p.date&&s.benefitCents>0));
   const excluded=bundled.reduce((n,p)=>n+p.feeCents,0);
   const completeSeries=[...new Set(bundled.map(p=>p.date))].every(date=>{
    const series=normalized.filter(p=>p.code==='D0210'&&p.date===date&&p.benefitCents>0);
    return series.length===1&&bundled.filter(p=>p.date===date).reduce((n,p)=>n+p.feeCents,0)>=series[0].feeCents;
   });
   if(flbExplained&&completeSeries&&excluded>0&&totals[0]-excluded===claim.printedTotals[0]){
    totals[0]-=excluded;
    warnings.push(`Claim ${claim.claimNumber}: Claim total không cộng phí ${money(excluded)} của ${bundled.length} dòng X-quang FLB đã gộp vào D0210; giữ nguyên các dòng gốc.`);
   }
  }
  if(totals.some((n,i)=>n!==claim.printedTotals[i]))throw fail('Tổng từng cột dịch vụ Delta không khớp Claim total; cần đủ trang và đọc rõ số tiền.');
  const paid=claim.printedTotals[4];if(paid<=0)throw fail('Claim Delta không có khoản hưởng dương.');
  // Confirmed clinic rule: deposit Amount may combine multiple claims.
  // Only this claim's reconciled Delta Dental pays column is posted.
  if(claim.headerPaidCents!==paid)warnings.push(`Claim ${claim.claimNumber}: Amount ${money(claim.headerPaidCents)} là thông tin tổng đợt trả; dùng Claim total ${money(paid)} theo quy tắc đã xác nhận.`);
  claim.procedures=normalized.map((p,i)=>({...p,line:i+1,copayCents:0,coinsuranceCents:0,status:p.benefitCents>0?'Approved':'Denied'}));
  claim.totals={planPaidCents:paid};claim.plan={carrier:'DELTA DENTAL',group:''};claim.check={number:'',date:claim.date};
  claim.paymentPayload={payType:'Insurance Paid',checkNum:'',claimNum:claim.claimNumber,payDate:claim.date,payNote:`Claim number: ${claim.claimNumber}`,amountCents:paid,amount:money(paid),splits:claim.procedures.filter(p=>p.benefitCents>0).map(p=>({code:p.code,tooth:p.tooth,date:p.date,amountCents:p.benefitCents,amount:money(p.benefitCents)}))};
 }
 if(!claims.length)throw fail('Không nhận diện được claim Delta Dental.');
 }catch(e){errors.push(e.message);}
 return {carrier:'DELTA DENTAL',parserVersion:1,sha256:extracted.sha256,pageCount:extracted.pages.length,claimsCount:claims.length,claims,check:{number:'',date:claims[0]?.date,netPaymentCents:claims.reduce((n,c)=>n+(c.totals?.planPaidCents||0),0)},settlementBasis:'Claim total / Delta Dental pays',text:extracted.pages.map(p=>p.lines.map(l=>l.text).join('\n')).join('\n'),errors,warnings};
}
