import {cents,isoDate,money} from '../metlife/parser.js';
import {isCignaStatement,parseCignaStatement} from './statementParser.js';

const currency=/^-?\$[\d,]+\.\d{2}$/;
const value=s=>cents(s.replace(/\$/g,''));
const unique=values=>[...new Set(values)];

export function parseCigna(extracted){
  const fullText=extracted.pages.flatMap(p=>p.lines.map(l=>l.text)).join('\n');
  if(isCignaStatement(fullText)){
    if(/Claim\/Reference Number:/i.test(fullText))return {errors:['File trộn hai mẫu CIGNA; cần tách và đối chiếu.'],claims:[],warnings:[]};
    return parseCignaStatement(extracted);
  }
  const errors=[],warnings=[...(extracted.warnings||[])],claims=[],byId=new Map();let current;
  const fail=text=>errors.push(text);
  for(const page of extracted.pages){
    const text=page.lines.map(l=>l.text).join('\n');
    const ids=unique([...text.matchAll(/Claim\/Reference Number:\s*([A-Z0-9-]+)/g)].map(m=>m[1]));
    if(ids.length>1){fail('Trang CIGNA có nhiều số claim khác nhau; cần đối chiếu.');continue;}
    if(ids.length){
      current=byId.get(ids[0]);
      if(!current){
        const name=/Patient Name:\s*([^|\n]+)/.exec(text)?.[1]?.trim()||'';
        const parts=name.split(/\s+/),lastName=name.includes(',')?name.split(',')[0].trim():parts.at(-1),firstName=name.includes(',')?name.split(',')[1].trim():parts.slice(0,-1).join(' ');
        current={claimNumber:ids[0],patient:{raw:name,firstName,lastName,memberId:''},status:/Claim Status:\s*([A-Z]+)/.exec(text)?.[1]||'',date:isoDate(/Date Processed:\s*(\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1]),headerPaidCents:null,rawProcedures:[],printedTotals:null};
        claims.push(current);byId.set(ids[0],current);
      }
      const header=/Claim Amount Paid:\s*(\$[\d,]+\.\d{2})/.exec(text);
      if(header)current.headerPaidCents=value(header[1]);
    }
    const codeLines=page.lines.filter(l=>l.items?.some(i=>/^D\d{4}\b/.test(i.str)));
    if(!codeLines.length)continue;
    if(!current){fail('Có dịch vụ CIGNA nhưng thiếu phần thông tin claim.');continue;}
    const items=page.lines.flatMap(l=>l.items||[]);
    const labels=['Charged','Allowed','Applied','Balance','Contracted','Coinsurance'];
    const columns=labels.map(label=>items.find(i=>i.str===label)?.x);
    if(columns.some(x=>!Number.isFinite(x))||columns.some((x,i)=>i&&x<=columns[i-1])){fail('Chưa nhận diện đủ các cột tiền CIGNA.');continue;}
    const left=columns.map(x=>x-12),toothLeft=(items.find(i=>i.str==='Tooth')?.x??NaN)-10;
    const totals=page.lines.filter(l=>/^Totals\b/.test(l.text));
    const amounts=lines=>left.map((x,i)=>lines.flatMap(l=>l.items).filter(t=>t.x>=x&&t.x<(left[i+1]??page.width)&&currency.test(t.str)).map(t=>value(t.str)));
    for(let n=0;n<codeLines.length;n++){
      const row=codeLines[n],next=Math.min(codeLines[n+1]?.y??Infinity,...totals.filter(l=>l.y>row.y).map(l=>l.y),page.height);
      const block=page.lines.filter(l=>l.y>=row.y&&l.y<next),a=amounts(block);
      const code=row.items.find(i=>/^D\d{4}\b/.test(i.str)).str.match(/D\d{4}/)[0];
      const dates=unique([...block.map(l=>l.text).join(' ').matchAll(/\b\d{2}\/\d{2}\/\d{4}\b/g)].map(m=>isoDate(m[0])));
      const rawTooth=row.items.find(i=>i.x>=toothLeft&&i.x<left[0]&&/^(?:0?[1-9]|[12]\d|3[0-2]|[A-T])$/.test(i.str))?.str||'';
      const tooth=/^\d+$/.test(rawTooth)?String(Number(rawTooth)):rawTooth;
      if(a.some(v=>v.length!==1)||dates.length!==1||!dates[0]){fail(`${code}: thiếu ngày hoặc cột tiền CIGNA không rõ.`);continue;}
      const [charged,notAllowed,deductible,covered,contracted,paid]=a.map(v=>v[0]);
      const percent=Number(/(\d+(?:\.\d+)?)%\s*=/.exec(block.map(l=>l.text).join(' '))?.[1]);
      if(!Number.isFinite(percent)||percent<0||percent>100||Math.round(covered*percent/100)!==paid){fail(`${code}: Plan Coinsurance Paid không khớp tỷ lệ và Covered Balance.`);continue;}
      current.rawProcedures.push({code,date:dates[0],tooth,feeCents:charged,notAllowedCents:notAllowed,deductibleCents:deductible,coveredCents:covered,contractedCents:contracted,benefitCents:paid,percent,page:page.page});
    }
    if(totals.length){const a=amounts([totals.at(-1)]);if(a.every(v=>v.length===1))current.printedTotals=a.map(v=>v[0]);else fail('Thiếu tổng cột CIGNA.');}
  }
  for(const claim of claims){
    if(!claim.patient.firstName||!claim.patient.lastName||!claim.date||claim.headerPaidCents===null||!claim.rawProcedures.length||!claim.printedTotals)fail(`Claim ${claim.claimNumber}: thiếu thông tin bắt buộc.`);
    if(claim.status!=='PROCESSED')fail(`Claim ${claim.claimNumber}: trạng thái chưa được xác nhận PROCESSED.`);
    const raw=claim.rawProcedures,keys=['feeCents','notAllowedCents','deductibleCents','coveredCents','contractedCents','benefitCents'];
    const sums=keys.map(k=>raw.reduce((n,p)=>n+p[k],0));
    if(claim.printedTotals&&sums.slice(0,5).some((v,i)=>v!==claim.printedTotals[i]))fail(`Claim ${claim.claimNumber}: tổng cột dịch vụ không khớp Totals.`);
    const paid=sums[5];
    if((claim.headerPaidCents>0&&claim.headerPaidCents!==paid)||(claim.printedTotals?.[5]>0&&claim.printedTotals[5]!==paid))fail(`Claim ${claim.claimNumber}: tổng thanh toán khác các dòng Plan Coinsurance Paid.`);
    if(paid>0&&(claim.headerPaidCents===0||claim.printedTotals?.[5]===0))warnings.push(`Claim ${claim.claimNumber}: lấy ${money(paid)} theo Plan Coinsurance Paid từng dòng, theo quy tắc CIGNA đã xác nhận; phần tổng trang ghi 0.`);
    const used=new Set(),normalized=[];
    for(const p of raw.filter(p=>p.benefitCents>0)){
      let target=p;
      if(p.feeCents===0){
        const originals=raw.filter(r=>r.date===p.date&&r.tooth===p.tooth&&r.feeCents>0&&r.benefitCents===0);
        if(originals.length!==1){fail(`${p.code}: chưa xác định duy nhất dịch vụ gốc cho mức hưởng thay thế.`);continue;}
        target=originals[0];
      }
      if(used.has(target)){fail('Dịch vụ gốc có nhiều dòng thay thế; cần đối chiếu.');continue;}
      used.add(target);used.add(p);normalized.push({...target,benefitCents:p.benefitCents,coveredCents:p.coveredCents,percent:p.percent,deductibleCents:p.deductibleCents,notAllowedCents:target===p?p.notAllowedCents:target.notAllowedCents+p.notAllowedCents,allowedCents:p.coveredCents,alternateCode:target===p?null:p.code});
    }
    normalized.push(...raw.filter(p=>!used.has(p)).map(p=>({...p,allowedCents:p.coveredCents})));
    claim.procedures=normalized.map((p,i)=>({...p,line:i+1,copayCents:0,coinsuranceCents:0,patientDueCents:Math.max(0,p.feeCents-p.benefitCents),status:p.benefitCents>0?'Approved':'Denied'}));
    claim.totals={planPaidCents:paid};claim.plan={carrier:'CIGNA',group:''};claim.check={number:'',date:claim.date};
    claim.paymentPayload={payType:'Insurance Paid',checkNum:'',claimNum:claim.claimNumber,payDate:claim.date,payNote:`Claim number: ${claim.claimNumber}`,amountCents:paid,amount:money(paid),splits:claim.procedures.filter(p=>p.benefitCents>0).map(p=>({code:p.code,tooth:p.tooth,date:p.date,amountCents:p.benefitCents,amount:money(p.benefitCents)}))};
  }
  if(!claims.length)fail('Không nhận diện được mẫu claim CIGNA.');
  const paid=claims.reduce((n,c)=>n+(c.totals?.planPaidCents||0),0);
  return {carrier:'CIGNA',parserVersion:1,sha256:extracted.sha256,pageCount:extracted.pages.length,claimsCount:claims.length,claims,check:{number:'',date:claims[0]?.date,netPaymentCents:paid},settlementBasis:'Plan Coinsurance Paid',errors:unique(errors),warnings:unique(warnings)};
}
