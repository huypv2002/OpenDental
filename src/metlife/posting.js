import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validId} from './repository.js';
const cents=v=>{const s=String(v??'');if(!/^-?\d+(\.\d{1,2})?$/.test(s))throw new Error('Invalid financial amount');const n=Math.round(Number(s)*100);if(!Number.isSafeInteger(n))throw new Error('Invalid financial amount');return n;};
const norm=s=>String(s??'').trim().toLowerCase();
export function validatePostingPlan(context,draft){
 if(!draft||!validId(draft.patNum)||String(context.patNum)!==String(draft.patNum)||!/^\d+\.\d{2}$/.test(draft.amount)||cents(draft.amount)<=0||!/^[a-f0-9]{64}$/.test(draft.sha256)||!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)||typeof draft.note!=='string'||draft.note.length>2000||typeof draft.checkNum!=='string'||!draft.checkNum||draft.checkNum.length>100)throw new Error('Invalid posting plan');
 if(!Number.isFinite(Date.parse(context.capturedAt||''))||Math.abs(Date.now()-Date.parse(context.capturedAt))>60000)throw new Error('OD context is not fresh');
 const validDate=new Date(draft.date+'T12:00:00Z');if(!Number.isFinite(+validDate)||validDate.toISOString().slice(0,10)!==draft.date)throw new Error('Invalid payment date');
 if(context.warnings?.length)throw new Error('OD data incomplete; posting stopped');
 const t=context.tables;
 const types=t.definition.filter(d=>Number(d.Category)===10&&!Number(d.IsHidden)&&norm(d.ItemName)==='insurance paid');
 if(types.length!==1||norm(draft.paymentType)!=='insurance paid')throw new Error('Need one visible Insurance Paid payment definition');
 if(!Array.isArray(draft.splits)||draft.splits.length<1||draft.splits.length>50||new Set(draft.splits.map(s=>String(s.ProcNum))).size!==draft.splits.length)throw new Error('Invalid allocation list');
 let total=0;
 for(const split of draft.splits){
  const proc=t.procedurelog.find(p=>String(p.ProcNum)===String(split.ProcNum)&&String(p.PatNum)===String(draft.patNum));
  const code=t.procedurecode.find(c=>String(c.CodeNum)===String(proc?.CodeNum));
  if(!validId(split.ProcNum)||!validId(split.ProvNum)||!/^\d{1,18}$/.test(String(split.ClinicNum))||String(proc?.ToothNum||'')!==String(split.tooth||''))throw new Error('Procedure tooth or identity changed');
  if(!proc||Number(proc.ProcStatus)!==2||String(proc.ProvNum)!==String(split.ProvNum)||String(proc.ClinicNum||0)!==String(split.ClinicNum||0)||String(proc.ProcDate).slice(0,10)!==split.date||code?.ProcCode!==split.code||!Number.isSafeInteger(split.amountCents)||split.amountCents<=0||!split.providerAbbr||!split.description)throw new Error('Procedure allocation no longer matches OD');
  // Same code/date/provider/tooth must be unique because the picker does not expose ProcNum.
  const matches=t.procedurelog.filter(p=>String(p.PatNum)===String(draft.patNum)&&Number(p.ProcStatus)===2&&String(p.ProcDate).slice(0,10)===split.date&&String(p.ProvNum)===String(split.ProvNum)&&String(p.ToothNum||'')===String(split.tooth||'')&&t.procedurecode.find(c=>String(c.CodeNum)===String(p.CodeNum))?.ProcCode===split.code);
  if(matches.length!==1)throw new Error('UI procedure identity is ambiguous');
  const provider=t.provider?.find(p=>String(p.ProvNum)===String(proc.ProvNum));
  if(!provider||norm(provider.Abbr)!==norm(split.providerAbbr)||code.Descript!==split.description)throw new Error('Provider or description metadata changed');
  if(t.claimproc.some(cp=>String(cp.ProcNum)===String(split.ProcNum)&&cents(cp.InsPayAmt||'0')>0))throw new Error('Procedure already has insurance payment');
  total+=split.amountCents;
 }
 if(total!==cents(draft.amount))throw new Error('Allocation total mismatch');
 const duplicate=t.payment.some(p=>String(p.CheckNum||'')===draft.checkNum||(String(p.PayDate).slice(0,10)===draft.date&&cents(p.PayAmt)===total))||t.claimpayment.some(p=>String(p.CheckNum||'')===draft.checkNum||(String(p.CheckDate).slice(0,10)===draft.date&&cents(p.CheckAmt)===total));
 if(duplicate)throw new Error('Existing payment or possible duplicate');
 return {...draft,paymentTypeDefNum:String(types[0].DefNum),mode:'save-authorized'};
}
export function verifyPostedPayment(before,after,plan){
 const beforeIds=new Set(before.tables.payment.map(p=>String(p.PayNum)));
 const rows=after.tables.payment.filter(p=>!beforeIds.has(String(p.PayNum))&&String(p.PatNum)===plan.patNum&&String(p.PayDate).slice(0,10)===plan.date&&cents(p.PayAmt)===cents(plan.amount)&&String(p.PayType)===plan.paymentTypeDefNum&&String(p.CheckNum||'')===plan.checkNum&&String(p.PayNote||'').trimEnd()===plan.note.trimEnd());
 if(rows.length!==1)return {verified:false,reason:'Không tìm thấy đúng một Payment mới khớp toàn bộ trường.'};
 const payment=rows[0],splits=after.tables.paysplit.filter(s=>String(s.PayNum)===String(payment.PayNum));
 if(splits.length!==plan.splits.length)return {verified:false,reason:'Số lượng Splits khác kế hoạch.'};
 for(const expected of plan.splits){const found=splits.filter(s=>String(s.PatNum)===plan.patNum&&String(s.ProcNum)===expected.ProcNum&&String(s.ProvNum)===expected.ProvNum&&String(s.ClinicNum||0)===String(expected.ClinicNum||0)&&cents(s.SplitAmt)===expected.amountCents&&Number(s.UnearnedType)===0&&Number(s.AdjNum||0)===0&&Number(s.PayPlanNum||0)===0&&Number(s.PayPlanChargeNum||0)===0&&String(s.DatePay).slice(0,10)===plan.date);if(found.length!==1)return {verified:false,reason:'Split không khớp patient/procedure/provider/clinic/amount/date hoặc còn Unearned Type.'};}
 return {verified:true,payNum:String(payment.PayNum),splitNums:splits.map(s=>String(s.SplitNum)),amount:plan.amount};
}
export function createPostingCoordinator({repository,directory}){
 const dir=path.resolve(directory);let chain=Promise.resolve();
 const serial=fn=>{const task=chain.then(fn);chain=task.catch(()=>{});return task;};
 const save=async op=>{const file=path.join(dir,op.id+'.json'),temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(op),{mode:0o600});await fs.rename(temp,file);};
 const read=async id=>{if(!/^[a-f0-9-]{36}$/.test(String(id)))throw new Error('Invalid operation');return JSON.parse(await fs.readFile(path.join(dir,id+'.json'),'utf8'));};
 async function ensureDirectory(){await fs.mkdir(dir,{recursive:true});}
 return {
  prepare:args=>serial(async()=>{
   await ensureDirectory();const {patNum,docNum,draft,transport='od-ui'}=args||{};
   if(!['od-ui','direct-db'].includes(transport))throw new Error('Invalid posting transport');
   if(!validId(patNum)||!validId(docNum)||String(draft?.patNum)!==String(patNum))throw new Error('Invalid document identity');
   const lock=path.join(dir,'patient-'+patNum+'.lock');let handle;
   try{handle=await fs.open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('Bệnh nhân đang có lượt ghi chưa xác minh. Kiểm tra lượt trước; không ghi lại.');throw e;}
   let retained=false;
   try{
    const before=await repository.context(patNum),plan=validatePostingPlan(before,draft),pdf=await repository.pdf(patNum,docNum);
    if(pdf.sha256!==plan.sha256)throw new Error('PDF changed on SERVER');
    const op={id:randomUUID(),patNum:String(patNum),docNum:String(docNum),transport,state:'prepared',at:new Date().toISOString(),before,plan};
    await save(op);await handle.writeFile(op.id);retained=true;return {operationId:op.id,plan};
   }finally{await handle.close();if(!retained)await fs.unlink(lock).catch(()=>{});}
  }),
  recheck:id=>serial(async()=>{
   const op=await read(id);if(op.state!=='prepared')throw new Error('Operation is not ready to save');
   const fresh=await repository.context(op.patNum),pdf=await repository.pdf(op.patNum,op.docNum);
   const plan=validatePostingPlan(fresh,op.plan);
   if(pdf.sha256!==op.plan.sha256)throw new Error('PDF changed before Save');
   const financial=s=>JSON.stringify({payment:s.tables.payment,paysplit:s.tables.paysplit,claimpayment:s.tables.claimpayment,claimproc:s.tables.claimproc});
   if(financial(op.before)!==financial(fresh))throw new Error('Dữ liệu tài chính thay đổi trong khi điền OD; không Save.');
   op.checkedBeforeSaveAt=new Date().toISOString();await save(op);return {ready:true,plan};
  }),
  beginUiSave:id=>serial(async()=>{
   const op=await read(id);
   if(op.transport!=='od-ui'||op.state!=='prepared')throw new Error('Lượt lưu trên OD không sẵn sàng; kiểm tra kết quả trước.');
   const fresh=await repository.context(op.patNum),pdf=await repository.pdf(op.patNum,op.docNum);
   validatePostingPlan(fresh,op.plan);
   if(pdf.sha256!==op.plan.sha256)throw new Error('PDF changed before Save');
   const financial=s=>JSON.stringify({payment:s.tables.payment,paysplit:s.tables.paysplit,claimpayment:s.tables.claimpayment,claimproc:s.tables.claimproc});
   if(financial(op.before)!==financial(fresh))throw new Error('Dữ liệu tài chính thay đổi trong khi điền OD; không Save.');
   // Persist before authorizing the client click. A lost response must never
   // make this operation eligible for a second click or a no-change abort.
   op.state='ui-saving';op.checkedBeforeSaveAt=new Date().toISOString();await save(op);
   return {ready:true,plan:op.plan};
  }),
  post:id=>serial(async()=>{
   const op=await read(id);
   if(op.state==='verified')return op.result;
   if(op.transport!=='direct-db'||op.state!=='prepared'||!repository.postDirect)throw new Error('Lượt ghi không sẵn sàng. Kiểm tra kết quả, không gửi lại.');
   const pdf=await repository.pdf(op.patNum,op.docNum);
   if(pdf.sha256!==op.plan.sha256)throw new Error('PDF changed before posting');
   op.state='posting';await save(op);
   try{op.receipt=await repository.postDirect(op);op.state='posted';await save(op);return {posted:true,...op.receipt};}
   catch(e){op.state=e.noWrite?'failed-no-write':'unverified';op.error=e.message;await save(op);throw e;}
  }),
  verify:id=>serial(async()=>{
   const op=await read(id);if(op.state==='verified')return op.result;if(op.state==='aborted-no-change')throw new Error('Operation was aborted; cannot verify it as a new save');
   if(op.transport==='direct-db'){
    const receipt=await repository.directReceipt(op.id);
    if(!receipt)return {verified:false,reason:'Chưa có biên nhận transaction trên SERVER; không tự gửi lại lệnh ghi.'};
    op.receipt=receipt;
   }
   const after=await repository.context(op.patNum);let result=verifyPostedPayment(op.before,after,op.plan);
   if(result.verified&&op.receipt&&String(op.receipt.payNum)!==result.payNum)result={verified:false,reason:'PayNum khác biên nhận transaction.'};
   op.checkedAt=new Date().toISOString();op.result=result;op.state=result.verified?'verified':(op.transport==='od-ui'&&op.state==='prepared'?'prepared':'unverified');await save(op);
   if(result.verified)await fs.unlink(path.join(dir,'patient-'+op.patNum+'.lock')).catch(()=>{});
   return result;
  }),
  abort:id=>serial(async()=>{
   const op=await read(id);if(op.state==='aborted-no-change')return {released:true};if(op.state==='verified')return {released:false,reason:'Already verified'};
   if(op.transport==='od-ui'&&['ui-saving','unverified'].includes(op.state))return {released:false,reason:'Đã cấp quyền Save trên OD; chỉ kiểm tra kết quả, không ghi lại.'};
   if(op.transport==='direct-db'&&!['prepared','failed-no-write'].includes(op.state))return {released:false,reason:'Transaction có thể đã commit; chỉ xác minh, không ghi lại.'};
   const after=await repository.context(op.patNum);
   // Only release a pre-save failure when financial records are byte-for-byte unchanged.
   const financial=s=>JSON.stringify({payment:s.tables.payment,paysplit:s.tables.paysplit,claimpayment:s.tables.claimpayment,claimproc:s.tables.claimproc});
   if(financial(op.before)!==financial(after))return {released:false,reason:'Dữ liệu tài chính đã thay đổi; cần xác minh thay vì thử lại.'};
   op.state='aborted-no-change';await save(op);await fs.unlink(path.join(dir,'patient-'+op.patNum+'.lock')).catch(()=>{});return {released:true};
  }),
  patientPending:patNum=>serial(async()=>{if(!validId(patNum))throw new Error('Invalid PatNum');try{const id=(await fs.readFile(path.join(dir,'patient-'+patNum+'.lock'),'utf8')).trim();if(!id)return {pending:true,operationId:null};const op=await read(id);return {pending:true,operationId:op.id,state:op.state};}catch(e){if(e.code==='ENOENT')return {pending:false};throw e;}}),
  status:id=>serial(async()=>{const op=await read(id);return {operationId:op.id,patNum:op.patNum,transport:op.transport||'od-ui',state:op.state,result:op.result||null};})
 };
}
