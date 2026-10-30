import {createHash} from 'node:crypto';
import os from 'node:os';
import {cents} from './parser.js';
import {procedureModelColumns,insertProcedureModel} from './missingProcedures.js';
import {insertFinancialRow,financialInsert,odSecurityLogHash} from './directPayment.js';

const timestamp=v=>v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')} ${String(v.getHours()).padStart(2,'0')}:${String(v.getMinutes()).padStart(2,'0')}:${String(v.getSeconds()).padStart(2,'0')}`
  : String(v||'');
const day=v=>timestamp(v).slice(0,10);
const same=(a,b)=>String(a)===String(b);
const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};
const keys=['PayPlanNum','FSplitNum','AdjNum','PayPlanChargeNum','PayPlanDebitType','UnearnedType','IsDiscount','DiscountType'];
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function summarizeClaim690Splits(state){
  return state.splits.map(s=>{
    const proc=state.procedures.find(p=>same(p.ProcNum,s.ProcNum));
    return {SplitNum:s.SplitNum,PatNum:s.PatNum,PayNum:s.PayNum,Amount:s.SplitAmt,
      DatePay:timestamp(s.DatePay),SplitProcDate:timestamp(s.ProcDate),ProcNum:s.ProcNum,
      Code:state.codes.find(c=>same(c.CodeNum,proc?.CodeNum))?.ProcCode||'(not found)',
      ActualServiceDate:timestamp(proc?.ProcDate),ProcStatus:proc?.ProcStatus,
      ProvNum:s.ProvNum,ClinicNum:s.ClinicNum};
  });
}

export async function readClaim690RepairState(db){
  const query=async(sql,args=[])=> (await db.execute({sql,dateStrings:true},args))[0];
  const patients=await query('SELECT * FROM patient WHERE PatNum=?',[690]);
  const payments=await query('SELECT * FROM payment WHERE PayNum=?',[1202]);
  const splits=await query('SELECT * FROM paysplit WHERE PayNum=? ORDER BY SplitNum',[1202]);
  const otherSplits=await query('SELECT * FROM paysplit WHERE PatNum=? AND PayNum<>? ORDER BY SplitNum',[690,1202]);
  const codes=await query("SELECT * FROM procedurecode WHERE ProcCode IN ('D0150','D0120','D0210') ORDER BY CodeNum");
  const procedures=await query('SELECT * FROM procedurelog WHERE PatNum=? ORDER BY ProcNum',[690]);
  const claimprocs=await query('SELECT * FROM claimproc WHERE PatNum=? ORDER BY ClaimProcNum',[690]);
  const types=await query('SELECT DefNum,ItemName FROM definition WHERE Category=10');
  const providers=await query('SELECT ProvNum,IsHidden FROM provider');
  return {patients,payments,splits,otherSplits,codes,procedures,claimprocs,types,providers};
}

export function planClaim690Repair(state){
  const {patients,payments,splits,codes,procedures,claimprocs,types,providers}=state;
  requireThat(patients.length===1&&same(patients[0].PatNum,690),'Expected exactly patient #690.');
  const p=patients[0];
  requireThat(String(p.FName).trim().toUpperCase()==='MINH'&&String(p.LName).trim().toUpperCase()==='BUI','Patient #690 name does not match MINH BUI.');
  requireThat(payments.length===1,'Payment #1202 not found uniquely.');
  const payment=payments[0];
  requireThat(same(payment.PatNum,690)&&same(payment.PayNum,1202)&&cents(payment.PayAmt)===7720&&day(payment.PayDate)==='2025-10-15','Payment #1202 patient/date/amount changed.');
  requireThat(/(?:^|\D)5101035732(?:\D|$)/.test(payment.PayNote||'')||String(payment.ExternalId||'').startsWith('5101035732'),'Payment #1202 does not identify claim 5101035732.');
  requireThat(types.some(t=>same(t.DefNum,payment.PayType)&&/^insurance paid$/i.test(String(t.ItemName).trim())),'Payment #1202 is not Insurance Paid.');
  requireThat(splits.length===2,`Expected exactly 2 splits for Payment 1202; found ${splits.length}.`);
  requireThat(splits.every(s=>same(s.PatNum,690)&&same(s.PayNum,1202)),'A split belongs to a different patient/payment.');
  requireThat(splits.every(s=>day(s.DatePay)==='2025-10-15'),'A split DatePay differs from 2025-10-15; inspect Actual Split Values below.');
  // OD can leave the split's optional ProcDate at its empty sentinel even
  // when ProcNum links to a dated procedure. Validate the linked service
  // below and preserve the original split date in the UPDATE/readback.
  requireThat(splits.every(s=>['2025-09-19','0001-01-01'].includes(day(s.ProcDate))),'A split ProcDate is neither 2025-09-19 nor the empty 0001-01-01 sentinel; inspect Actual Split Values below.');
  requireThat(splits.every(s=>keys.every(k=>Number(s[k]||0)===0)),'Payment split has an adjustment, transfer, unearned or payment-plan link.');
  requireThat(splits.reduce((n,s)=>n+cents(s.SplitAmt),0)===7720,'Split total does not equal $77.20.');
  const fixed=splits.filter(s=>cents(s.SplitAmt)===3800),moving=splits.filter(s=>cents(s.SplitAmt)===3920);
  requireThat(fixed.length===1&&moving.length===1,'Expected one $38 split and one $39.20 split.');
  const codeOf=row=>codes.find(c=>same(c.CodeNum,row?.CodeNum))?.ProcCode;
  const procOf=split=>procedures.find(r=>same(r.ProcNum,split.ProcNum));
  const fixedProc=procOf(fixed[0]),oldProc=procOf(moving[0]);
  requireThat(codeOf(fixedProc)==='D0150'&&Number(fixedProc.ProcStatus)===2&&day(fixedProc.ProcDate)==='2025-09-19','The $38 split must link to the completed D0150 dated 2025-09-19.');
  requireThat(oldProc&&['D0120','D0210'].includes(codeOf(oldProc))&&Number(oldProc.ProcStatus)===2&&day(oldProc.ProcDate)==='2025-09-19','The $39.20 split is not on the expected completed service/date.');
  requireThat([fixed[0],moving[0]].every(s=>same(s.ProvNum,procOf(s).ProvNum)&&same(s.ClinicNum||0,procOf(s).ClinicNum||0)),'Existing split provider/clinic differs from its procedure.');
  const d0210codes=codes.filter(c=>c.ProcCode==='D0210');
  requireThat(d0210codes.length===1,'Need exactly one D0210 in the OD code catalog.');
  const catalog=d0210codes[0];
  requireThat(!Number(catalog.IsHidden||0)&&Number(catalog.TreatArea)===3,'D0210 catalog code is hidden or not a mouth-level service.');
  const matches=procedures.filter(r=>same(r.CodeNum,catalog.CodeNum)&&day(r.ProcDate)==='2025-09-19'&&Number(r.ProcStatus)!==6);
  requireThat(matches.length<=1,'Multiple D0210 records exist on 2025-09-19.');
  const target=matches[0];
  if(target)requireThat(Number(target.ProcStatus)===2&&cents(target.ProcFee)===7400&&!target.ToothNum&&!target.Surf&&same(target.ProvNum,moving[0].ProvNum)&&same(target.ClinicNum||0,moving[0].ClinicNum||0),'Existing D0210 is not the expected completed $74 service/provider/clinic.');
  requireThat(!target||!(state.otherSplits||[]).some(s=>same(s.ProcNum,target.ProcNum)&&cents(s.SplitAmt)!==0),'D0210 already has other allocated payments; manual review required.');
  requireThat(providers.some(r=>same(r.ProvNum,moving[0].ProvNum)&&!Number(r.IsHidden)),'Split provider is missing/hidden.');
  const touchedIds=[oldProc.ProcNum,...(target?[target.ProcNum]:[])];
  requireThat(!claimprocs.some(r=>touchedIds.some(id=>same(id,r.ProcNum))&&(cents(r.InsPayAmt||0)!==0||Number(r.ClaimPaymentNum)>0)),'Related procedure already has an actual claimproc insurance payment.');
  if(codeOf(oldProc)==='D0210'){
    requireThat(target&&same(target.ProcNum,oldProc.ProcNum),'The repaired split is not attached to the unique D0210.');
    return {status:'already-correct',payNum:1202,patNum:690,splitNum:moving[0].SplitNum,targetProcNum:target.ProcNum,balanceIncreaseCents:0};
  }
  requireThat(cents(oldProc.ProcFee)===7400,'Existing D0120 fee changed from $74.');
  return {status:'ready',patNum:690,payNum:1202,splitNum:moving[0].SplitNum,oldProcNum:oldProc.ProcNum,
    targetProcNum:target?.ProcNum||null,codeNum:catalog.CodeNum,providerNum:moving[0].ProvNum,clinicNum:moving[0].ClinicNum||0,
    serviceDate:'2025-09-19',procedureFeeCents:7400,splitAmountCents:3920,paymentDate:'2025-10-15',
    balanceIncreaseCents:target?0:7400,beforeBalanceCents:cents(p.BalTotal),
    afterBalanceCents:cents(p.BalTotal)+(target?0:7400)};
}

export async function repairClaim690(db,{apply=false,hashSplits,writeJournal,readJournal=async()=>null}={}){
  const before=await readClaim690RepairState(db);
  let plan;
  try{plan=planClaim690Repair(before);}catch(error){error.repairSplits=summarizeClaim690Splits(before);throw error;}
  if(!apply)return {applied:false,plan};
  requireThat(typeof writeJournal==='function','A durable backup journal is required.');
  const previous=await readJournal();
  requireThat(!previous||previous.status==='complete','An earlier repair intent may have partially written. Review its backup; do not rerun automatically.');
  if(plan.status==='already-correct')return {applied:false,plan};
  requireThat(!previous,'Completed repair journal exists but live data no longer matches it.');
  const execute=async(sql,values=[])=>db.execute({sql,dateStrings:true},values);
  const [versions]=await execute("SELECT PrefName,ValueString FROM preference WHERE PrefName IN ('ProgramVersion','DataBaseVersion','RandomPrimaryKeys','AccountingSoftware','AccountingAutomaticPaymentEntry','DateLock','DateLockLimitDays')");
  requireThat(['ProgramVersion','DataBaseVersion'].every(n=>/^24\.3\.\d+\.\d+$/.test(versions.find(r=>r.PrefName===n)?.ValueString||'')),'This repair supports the checked OD/DB 24.3 schema only.');
  requireThat(versions.filter(r=>!['ProgramVersion','DataBaseVersion'].includes(r.PrefName)).every(r=>['','0','false','0001-01-01','0000-00-00'].includes(String(r.ValueString).toLowerCase())),'Random keys, accounting integration or date locks require manual OD review.');
  const procMeta=await procedureModelColumns(db,'procedurelog');
  const [meta]=await execute("SELECT TABLE_NAME,COLUMN_NAME,COLUMN_DEFAULT,IS_NULLABLE,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('paysplit','securitylog','securityloghash')");
  requireThat(meta.some(c=>c.TABLE_NAME==='paysplit'&&c.COLUMN_NAME==='SecurityHash'),'Expected paysplit.SecurityHash.');
  // Validate both audit inserts before the first procedure/split write.
  financialInsert('securitylog',{PermType:16,UserNum:0,LogText:'preflight',PatNum:690,CompName:os.hostname().slice(0,255),FKey:0,LogSource:0,DefNum:0,DefNumError:0,DateTPrevious:'0001-01-01 00:00:00'},meta.filter(c=>c.TABLE_NAME==='securitylog'));
  financialInsert('securityloghash',{SecurityLogNum:1,LogHash:'preflight'},meta.filter(c=>c.TABLE_NAME==='securityloghash'));
  const hashes=await hashSplits({patNum:690,date:plan.paymentDate,splits:[{amountCents:3920}]});
  requireThat(hashes?.length===1&&typeof hashes[0]==='string'&&hashes[0].length>0&&hashes[0].length<=4096&&!/\s|Exception$/.test(hashes[0]),'Native OD hash helper failed.');
  const journal={status:'intent',repair:'690-1202-D0120-to-D0210',createdAt:new Date().toISOString(),plan,before};
  let locked=false,writesStarted=false;
  try{
    await db.query('SET SESSION lock_wait_timeout=5');
    await db.query('SET SESSION autocommit=1');
    await db.query('LOCK TABLES patient WRITE,payment READ,paysplit WRITE,procedurelog WRITE,procedurecode READ,claimproc READ,definition READ,provider READ,securitylog WRITE,securityloghash WRITE');locked=true;
    const fresh=await readClaim690RepairState(db);
    requireThat(fingerprint(fresh)===fingerprint(before),'Clinic data changed since preview. No repair was written; rerun preview.');
    await writeJournal(journal,{create:true}); // fsync before any MyISAM mutation.
    let target=plan.targetProcNum;
    writesStarted=true;
    if(!target){
      target=await insertProcedureModel(db,'procedurelog',procMeta,{
        PatNum:690,CodeNum:plan.codeNum,ProcStatus:2,ProcDate:plan.serviceDate,DateTP:plan.serviceDate,DateComplete:plan.serviceDate,
        ProcFee:'74.00',ProvNum:plan.providerNum,ClinicNum:plan.clinicNum,ToothNum:'',Surf:'',UnitQty:1,BaseUnits:0,
        SecDateEntry:new Date(),SecDateTEdit:new Date(),BillingNote:'Clinic-approved EOB repair; claim 5101035732 89; reallocate existing Payment 1202; no new payment.'
      });
      // Only the newly added $74 charge changes the cached total. Do not
      // replace unrelated balances with an incomplete payments-only formula.
      await execute('UPDATE patient SET BalTotal=? WHERE PatNum=?',[(plan.afterBalanceCents/100).toFixed(2),690]);
    }
    const [updated]=await execute('UPDATE paysplit SET ProcNum=?,SecurityHash=? WHERE SplitNum=? AND PayNum=? AND PatNum=? AND ProcNum=? AND SplitAmt=?',
      [target,hashes[0],plan.splitNum,1202,690,plan.oldProcNum,'39.20']);
    requireThat(updated.affectedRows===1,'Expected exactly one updated split.');
    const addLog=async(permType,text)=>{
      const log={PermType:permType,UserNum:0,LogText:text,PatNum:690,CompName:os.hostname().slice(0,255),FKey:0,LogSource:0,DefNum:0,DefNumError:0,DateTPrevious:'0001-01-01 00:00:00'};
      const id=await insertFinancialRow(db,'securitylog',log,meta.filter(c=>c.TABLE_NAME==='securitylog'));
      const [rows]=await execute('SELECT * FROM securitylog WHERE SecurityLogNum=?',[id]);
      requireThat(rows.length===1,'Audit log readback failed.');
      const row=rows[0];
      await insertFinancialRow(db,'securityloghash',{SecurityLogNum:id,LogHash:odSecurityLogHash({permType:row.PermType,userNum:row.UserNum,logDateTime:timestamp(row.LogDateTime),logText:row.LogText,patNum:row.PatNum,dateTPrevious:timestamp(row.DateTPrevious)})},meta.filter(c=>c.TABLE_NAME==='securityloghash'));
    };
    if(!plan.targetProcNum)await addLog(23,`Completed D0210 created by clinic-approved claim 5101035732 89 repair, ProcNum ${target}, date 2025-09-19, fee $74.00.`);
    await addLog(16,`Payment 1202 split ${plan.splitNum} reallocated from D0120 ProcNum ${plan.oldProcNum} to D0210 ProcNum ${target}; amount $39.20, total payment $77.20 and other split unchanged. Clinic-approved repair.`);
    const after=await readClaim690RepairState(db),verified=planClaim690Repair(after);
    requireThat(verified.status==='already-correct','Repair readback failed.');
    requireThat(fingerprint(after.payments)===fingerprint(before.payments),'Payment row changed unexpectedly.');
    const expectedSplits=before.splits.map(s=>{
      if(!same(s.SplitNum,plan.splitNum))return s;
      const saved=after.splits.find(r=>same(r.SplitNum,s.SplitNum));
      return {...s,ProcNum:saved.ProcNum,SecurityHash:hashes[0],...(Object.hasOwn(s,'SecDateTEdit')?{SecDateTEdit:saved.SecDateTEdit}:{})};
    });
    requireThat(fingerprint(after.splits)===fingerprint(expectedSplits),'A split field other than ProcNum/SecurityHash changed unexpectedly.');
    requireThat(fingerprint(after.claimprocs)===fingerprint(before.claimprocs),'Claimproc rows changed unexpectedly.');
    requireThat(fingerprint(after.otherSplits)===fingerprint(before.otherSplits),'Other payments/splits changed unexpectedly.');
    requireThat(before.procedures.every(p=>fingerprint(after.procedures.find(r=>same(r.ProcNum,p.ProcNum)))===fingerprint(p)),'An existing procedure changed unexpectedly.');
    const expectedPatient={...before.patients[0],BalTotal:after.patients[0].BalTotal,...(Object.hasOwn(before.patients[0],'SecDateTEdit')?{SecDateTEdit:after.patients[0].SecDateTEdit}:{})};
    requireThat(cents(after.patients[0].BalTotal)===plan.afterBalanceCents&&fingerprint(after.patients[0])===fingerprint(expectedPatient),'Patient fields/balance changed unexpectedly.');
    await writeJournal({...journal,status:'complete',completedAt:new Date().toISOString(),targetProcNum:target,after});
    return {applied:true,plan,targetProcNum:target,verified:true};
  }catch(error){
    if(writesStarted)error.message+=' Partial MyISAM writes are possible. Keep the backup and inspect before retrying; no automatic rollback was attempted.';
    throw error;
  }finally{
    if(locked)await db.query('UNLOCK TABLES');
    await db.query('SET SESSION lock_wait_timeout=DEFAULT');
  }
}
