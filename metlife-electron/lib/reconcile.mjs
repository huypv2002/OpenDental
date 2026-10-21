import { cents, money } from './metlife.mjs';
import path from 'node:path';
import {DEFAULT_CONFIG} from './config.mjs';
const norm=s=>String(s??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const amount=v=>{try{return cents(v)}catch{return null}};
export function validateSnapshot(s) {
  if(!s?.tables || !s.readOnly || !/^\d+$/.test(String(s.patNum)) || !Array.isArray(s.tables.patient) || s.tables.patient.length!==1) throw new Error('Cần snapshot read-only từ capture-db.mjs cho đúng một bệnh nhân.');
  if(String(s.tables.patient[0].PatNum)!==String(s.patNum)) throw new Error('PatNum trong snapshot không nhất quán.');
  const required=['document','definition','patplan','inssub','insplan','carrier','procedurelog','procedurecode','payment','paysplit','claim','claimproc','claimpayment'];
  if(required.some(k=>!Array.isArray(s.tables[k]))) throw new Error('Snapshot thiếu bảng cần đối chiếu.');
  if(s.warnings?.length) throw new Error('Snapshot có cảnh báo thiếu/truncated dữ liệu; hãy lấy lại bản đầy đủ.');
  if(!Number.isFinite(Date.parse(s.capturedAt))) throw new Error('Snapshot thiếu thời gian hợp lệ.');
  return s;
}
export function reconcile(pdf, snapshot, filePath, now=Date.now(), {verifyUncPath=true}={}) {
  const blocks=[...pdf.errors], warnings=[...pdf.warnings];
  const output={blocks,warnings,patient:null,document:null,plan:null,splits:[],duplicates:[],snapshotAgeMinutes:null};
  if(!snapshot) {blocks.push(`PDF${pdf.group?' đã đọc được Group Number '+pdf.group:''}; chưa có snapshot OD tương ứng để đối chiếu bệnh nhân, hợp đồng và khoản đã nhập. Nạp JSON snapshot tạo trên SERVER; bản này chưa tự kết nối database OD.`);return output;}
  validateSnapshot(snapshot);
  const t=snapshot.tables, patient=t.patient[0]; output.patient=patient;
  const age=(now-Date.parse(snapshot.capturedAt))/60000;output.snapshotAgeMinutes=Math.floor(age);
  if(age>30 || age< -5) blocks.push('Snapshot đã quá 30 phút hoặc sai giờ; lấy bản mới trước khi điền OD.');
  const defs=new Set(t.definition.filter(d=>/^(FINISHED CLAM|FINISHED CLAIMS)$/i.test(String(d.ItemName).trim())).map(d=>String(d.DefNum)));
  const basename=String(filePath).split(/[\\/]/).at(-1).toLowerCase();
  const docs=t.document.filter(d=>String(d.PatNum)===String(patient.PatNum)&&String(d.FileName).split(/[\\/]/).at(-1).toLowerCase()===basename&&defs.has(String(d.DocCategory)));
  if(docs.length!==1) blocks.push('PDF chưa khớp duy nhất với tài liệu FINISHED CLAM của bệnh nhân trong OD.');else output.document=docs[0];
  if(norm(pdf.patient)!==norm(patient.FName)) blocks.push('Tên patient trong PDF không khớp FName của bệnh nhân OD.');
  const plans=[];
  for(const pp of t.patplan.filter(r=>String(r.PatNum)===String(patient.PatNum))) {
    const sub=t.inssub.find(r=>String(r.InsSubNum)===String(pp.InsSubNum));
    const plan=t.insplan.find(r=>String(r.PlanNum)===String(sub?.PlanNum));
    const carrier=t.carrier.find(r=>String(r.CarrierNum)===String(plan?.CarrierNum));
    if(plan && norm(plan.GroupNum)===norm(pdf.group) && /metlife/i.test(carrier?.CarrierName||'')) plans.push({...plan,InsSubNum:sub.InsSubNum,subscriberPatNum:sub.Subscriber,SubscriberID:sub.SubscriberID,CarrierName:carrier.CarrierName});
  }
  if(plans.length!==1) blocks.push('Không tìm thấy một hợp đồng MetLife duy nhất khớp Group Number.');else {
    output.plan=plans[0];
    if(String(plans[0].subscriberPatNum)===String(patient.PatNum)) {
      const a=norm(`${patient.FName} ${patient.MiddleI||''} ${patient.LName}`), b=norm(`${patient.LName} ${patient.FName} ${patient.MiddleI||''}`);
      if(![a,b].includes(norm(pdf.subscriber))) blocks.push('Tên subscriber không khớp bệnh nhân đứng hợp đồng.');
    } else {
      const sub=(t.subscriberpatient||[]).find(r=>String(r.PatNum)===String(plans[0].subscriberPatNum));
      const names=sub?[norm(`${sub.FName} ${sub.MiddleI||''} ${sub.LName}`),norm(`${sub.LName} ${sub.FName} ${sub.MiddleI||''}`)]:[];
      if(!names.includes(norm(pdf.subscriber)))blocks.push('Chưa xác minh được tên subscriber của người phụ thuộc.');
    }
  }
  const needles=[pdf.claimRaw,pdf.claimBase,pdf.payment?.trace].filter(Boolean);
  for(const row of t.payment) {
    const text=`${row.PayNote||''} ${row.CheckNum||''}`;
    if(needles.some(n=>text.includes(n)) || (amount(row.PayAmt)===pdf.payment?.amountCents&&[pdf.processed,pdf.payment?.date].filter(Boolean).includes(String(row.PayDate).slice(0,10)))) output.duplicates.push({table:'payment',id:row.PayNum});
  }
  for(const row of t.claim) if(needles.some(n=>`${row.ClaimIdentifier||''} ${row.ClaimNote||''}`.includes(n)) && amount(row.InsPayAmt)>0) output.duplicates.push({table:'claim',id:row.ClaimNum});
  for(const row of t.claimpayment) if(needles.some(n=>`${row.Note||''} ${row.CheckNum||''}`.includes(n)) || (amount(row.CheckAmt)===pdf.payment?.amountCents && [pdf.processed,pdf.payment?.date].filter(Boolean).includes(String(row.CheckDate).slice(0,10)))) output.duplicates.push({table:'claimpayment',id:row.ClaimPaymentNum});
  if(output.duplicates.length) blocks.push('Phát hiện giao dịch đã nhập hoặc có khả năng trùng; không điền lại.');
  const dates=[...new Set(pdf.procedures.map(p=>p.date).filter(Boolean))];
  const codes=new Map(t.procedurecode.map(r=>[String(r.CodeNum),r.ProcCode]));
  for(const p of pdf.procedures.filter(r=>r.benefitCents>0)) {
    const date=p.date || (p.bundled&&dates.length===1?dates[0]:null);
    const candidates=t.procedurelog.filter(r=>String(r.PatNum)===String(patient.PatNum)&&Number(r.ProcStatus)===2&&codes.get(String(r.CodeNum))===p.code&&(!p.tooth||String(r.ToothNum)===p.tooth)&&String(r.ProcDate).slice(0,10)===date);
    if(candidates.length!==1) {blocks.push(`${p.code}: chưa khớp duy nhất procedure hoàn tất theo ngày điều trị.`);continue;}
    const r=candidates[0];
    if(t.claimproc.some(cp=>String(cp.ProcNum)===String(r.ProcNum)&&String(cp.PlanNum)===String(output.plan?.PlanNum)&&amount(cp.InsPayAmt)>0)) blocks.push(`${p.code}: procedure đã có khoản bảo hiểm trả, cần kiểm tra trùng.`);
    output.splits.push({code:p.code,ProcNum:String(r.ProcNum),ProvNum:String(r.ProvNum),ClinicNum:String(r.ClinicNum||0),providerAbbr:t.provider?.find(v=>String(v.ProvNum)===String(r.ProvNum))?.Abbr||'',tooth:String(r.ToothNum||''),description:t.procedurecode.find(v=>String(v.CodeNum)===String(r.CodeNum))?.Descript||'',feeCents:amount(r.ProcFee),amountCents:p.benefitCents,date,bundled:p.bundled});
  }
  if(pdf.payment && output.splits.reduce((n,r)=>n+r.amountCents,0)!==pdf.payment.amountCents) blocks.push('Tổng phân bổ dự kiến chưa khớp số tiền thực trả.');
  if(output.document&&verifyUncPath){try{output.sourcePath=sourceDocumentPath(snapshot,output);}catch(e){blocks.push(e.message);}}
  output.blocks=[...new Set(blocks)]; return output;
}
export function draftOf(pdf, result, config={}) {
  if(result.blocks.length) throw new Error('Còn lỗi đối chiếu; không tạo bản điền.');
  if(!pdf.processed)throw new Error('Thiếu ngày PROCESSED on của MetLife.');
  const note=`Claim number: ${pdf.claimRaw}`;
  return {patNum:String(result.patient.PatNum),patientName:`${result.patient.LName}, ${result.patient.FName}`,splitPatientName:`${result.patient.LName}, ${result.patient.FName}${result.patient.MiddleI?' '+result.patient.MiddleI:''}`,amount:money(pdf.payment.amountCents),date:pdf.processed,checkNum:'',note,claimRaw:pdf.claimRaw,sha256:pdf.sha256,paymentType:config.paymentType||DEFAULT_CONFIG.paymentType,paymentTypeDefNum:result.paymentTypeDefNum||null,splits:result.splits,mode:'preview-only'};
}

export function sourceDocumentPath(snapshot, result) {
 const root=snapshot.tables.preference?.find(r=>/^AtoZfolder$/i.test(r.PrefName))?.ValueString;
 const folder=result.patient?.ImageFolder;
 const filename=result.document?.FileName;
 if(!root||!folder||!filename||!/^\\\\[^\\]+\\[^\\]+/.test(root)) throw new Error('Snapshot cần AtoZfolder dạng UNC để xác minh PDF gốc trên SERVER.');
 if(/[\\/]/.test(folder)||folder==='.'||folder==='..'||/[\\/]/.test(filename)||filename==='..') throw new Error('Đường dẫn tài liệu OD không hợp lệ.');
 return path.win32.join(root,folder.slice(0,1).toUpperCase(),folder,filename);
}
