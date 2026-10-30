import {createHash} from 'node:crypto';
import os from 'node:os';
import {cents} from './parser.js';
import {readClaim690RepairState,planClaim690Repair,changedClaim690PatientFields} from './repairClaim690.js';
import {financialInsert,insertFinancialRow,odSecurityLogHash} from './directPayment.js';

const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same=(a,b)=>String(a)===String(b);
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const marker='Clinic-approved EOB repair; claim 5101035732 89; reallocate existing Payment 1202; no new payment.';

export function validateClaim690AuditRecovery(state,journal){
  check(journal?.repair==='690-1202-D0120-to-D0210'&&['intent','complete'].includes(journal.status),'Missing or unexpected original repair journal.');
  const before=journal.before,plan=planClaim690Repair(before),live=planClaim690Repair(state);
  check(plan.status==='ready'&&fingerprint(plan)===fingerprint(journal.plan),'Original repair intent does not match its before snapshot.');
  check(live.status==='already-correct','Financial repair is not complete; audit-only recovery cannot modify it.');
  check(fingerprint(state.payments)===fingerprint(before.payments)&&fingerprint(state.claimprocs)===fingerprint(before.claimprocs)&&fingerprint(state.otherSplits)===fingerprint(before.otherSplits),'Payment/claimproc/other splits differ from the original backup.');
  check(cents(state.patients[0].BalTotal)===plan.afterBalanceCents,'Balance differs from intended repair balance; no recovery write.');
  const patientChangedFields=changedClaim690PatientFields(state.patients[0],before.patients[0]);
  // Audit completion does not rewrite patient rows. Preserve later clinic
  // edits/aging, while still binding the recovery to the original identity
  // and exact intended balance. The entire current snapshot is READ locked
  // and checked byte-for-byte unchanged again after audit writes below.
  const identityChanges=patientChangedFields.filter(key=>['PatNum','FName','LName','Birthdate'].includes(key));
  check(!identityChanges.length,`Patient identity changed since repair: ${identityChanges.join(', ')}; review before recovering.`);
  check(before.procedures.every(p=>fingerprint(state.procedures.find(r=>same(r.ProcNum,p.ProcNum)))===fingerprint(p)),'An original procedure changed.');
  const added=state.procedures.filter(p=>!before.procedures.some(r=>same(r.ProcNum,p.ProcNum)));
  check(added.length===(plan.targetProcNum?0:1),'Unexpected number of newly added procedures.');
  if(added.length)check(same(added[0].ProcNum,live.targetProcNum)&&added[0].BillingNote===marker,'New D0210 is not the repair-created record.');
  const expected=before.splits.map(s=>{
    if(!same(s.SplitNum,plan.splitNum))return s;
    const current=state.splits.find(r=>same(r.SplitNum,s.SplitNum));
    check(current&&typeof current.SecurityHash==='string'&&current.SecurityHash.length>0,'Repaired split lacks SecurityHash.');
    return {...s,ProcNum:current.ProcNum,SecurityHash:current.SecurityHash,...(Object.hasOwn(s,'SecDateTEdit')?{SecDateTEdit:current.SecDateTEdit}:{})};
  });
  check(fingerprint(expected)===fingerprint(state.splits),'A split field other than the repaired link/hash/edit time changed.');
  return {plan,targetProcNum:live.targetProcNum,patientChangedFields,
    createText:`Completed D0210 created by clinic-approved claim 5101035732 89 repair, ProcNum ${live.targetProcNum}, date 2025-09-19, fee $74.00.`,
    editText:`Payment 1202 split ${plan.splitNum} reallocated from D0120 ProcNum ${plan.oldProcNum} to D0210 ProcNum ${live.targetProcNum}; amount $39.20, total payment $77.20 and other split unchanged. Clinic-approved repair.`};
}

export async function completeClaim690Audit(db,{journal,writeRecovery,writeJournal,readRecovery=async()=>null}={}){
  check(typeof writeRecovery==='function'&&typeof writeJournal==='function','Durable recovery/original journal writers are required.');
  const execute=async(sql,args=[])=>db.execute({sql,dateStrings:true},args);
  const before=await readClaim690RepairState(db),intent=validateClaim690AuditRecovery(before,journal);
  const recovery=await readRecovery();
  check(!recovery||recovery.status==='complete','Recovery was previously interrupted. Inspect its recovery-journal.json before retrying.');
  const [metadata]=await execute("SELECT TABLE_NAME,COLUMN_NAME,COLUMN_DEFAULT,IS_NULLABLE,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('securitylog','securityloghash')");
  const logColumns=metadata.filter(c=>c.TABLE_NAME==='securitylog'),hashColumns=metadata.filter(c=>c.TABLE_NAME==='securityloghash');
  financialInsert('securitylog',{PermType:16,UserNum:0,LogDateTime:'2000-01-01 00:00:00',LogText:'preflight',PatNum:690,CompName:os.hostname().slice(0,255),FKey:0,LogSource:0,DefNum:0,DefNumError:0,DateTPrevious:'0001-01-01 00:00:00'},logColumns);
  financialInsert('securityloghash',{SecurityLogNum:1,LogHash:'preflight'},hashColumns);
  let locked=false,started=false;
  try{
    await db.query('SET SESSION lock_wait_timeout=5');await db.query('SET SESSION autocommit=1');
    // Financial tables are READ locked: this recovery cannot mutate them.
    await db.query('LOCK TABLES patient READ,payment READ,paysplit READ,procedurelog READ,procedurecode READ,claimproc READ,definition READ,provider READ,securitylog WRITE,securityloghash WRITE');locked=true;
    const current=await readClaim690RepairState(db);
    check(fingerprint(current)===fingerprint(before),'Financial records changed while preparing recovery.');
    const [rows]=await execute("SELECT *,DATE_FORMAT(LogDateTime,'%Y-%m-%d %H:%i:%s') AS HashLogDateTime,DATE_FORMAT(DateTPrevious,'%Y-%m-%d %H:%i:%s') AS HashDateTPrevious FROM securitylog WHERE PatNum=? AND LogText IN (?,?) ORDER BY SecurityLogNum",[690,intent.createText,intent.editText]);
    check(rows.every(r=>same(r.UserNum,0)&&same(r.PatNum,690)&&Number(r.PermType)===(r.LogText===intent.createText?23:16)),'Unexpected audit identity/permission.');
    const createRows=rows.filter(r=>r.LogText===intent.createText),editRows=rows.filter(r=>r.LogText===intent.editText);
    check(createRows.length===(intent.plan.targetProcNum?0:1)&&editRows.length<=1,'Unexpected or duplicate repair audit records.');
    const auditHashes=[];
    for(const row of rows){
      const [hashes]=await execute('SELECT * FROM securityloghash WHERE SecurityLogNum=?',[row.SecurityLogNum]);
      check(hashes.length<=1,'Multiple hashes for a repair log.');auditHashes.push(...hashes);
    }
    const expectedHash=row=>odSecurityLogHash({permType:row.PermType,userNum:row.UserNum,logDateTime:row.HashLogDateTime,logText:row.LogText,patNum:row.PatNum,dateTPrevious:row.HashDateTPrevious});
    const isValidTime=row=>/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.HashLogDateTime||'')&&Number(row.HashLogDateTime.slice(0,4))>=1880;
    for(const row of rows){
      const hash=auditHashes.find(h=>same(h.SecurityLogNum,row.SecurityLogNum));
      if(hash)check(isValidTime(row)&&hash.LogHash===expectedHash(row),'Existing audit hash conflicts; do not overwrite it.');
      if(!isValidTime(row))check(row.HashLogDateTime==='0000-00-00 00:00:00'&&!hash,'Unexpected invalid audit time.');
    }
    if(journal.status==='complete'){
      check(editRows.length===1&&rows.every(r=>isValidTime(r)&&auditHashes.some(h=>same(h.SecurityLogNum,r.SecurityLogNum)&&h.LogHash===expectedHash(r))),'Completed journal has incomplete audits.');
      return {verified:true,alreadyComplete:true,targetProcNum:intent.targetProcNum,patientChangedFields:intent.patientChangedFields};
    }
    const [clock]=await execute("SELECT DATE_FORMAT(NOW(),'%Y-%m-%d %H:%i:%s') AS RepairAuditTime");
    const now=clock[0]?.RepairAuditTime;
    check(/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(now||''),'Invalid SQL audit time.');
    const recoveryIntent={status:'intent',kind:'690-1202-audit-only',createdAt:now,originalJournal:journal,before,patientChangedFields:intent.patientChangedFields,logsBefore:JSON.parse(JSON.stringify(rows)),hashesBefore:JSON.parse(JSON.stringify(auditHashes))};
    await writeRecovery(recoveryIntent,{create:true});started=true;
    for(const row of rows){
      if(!isValidTime(row)){
        const [updated]=await execute("UPDATE securitylog SET LogDateTime=? WHERE SecurityLogNum=? AND PatNum=? AND DATE_FORMAT(LogDateTime,'%Y-%m-%d %H:%i:%s')=?",[now,row.SecurityLogNum,690,'0000-00-00 00:00:00']);
        check(updated.affectedRows===1,'Audit timestamp update did not match exactly one record.');row.HashLogDateTime=now;
      }
      if(!auditHashes.some(h=>same(h.SecurityLogNum,row.SecurityLogNum)))await insertFinancialRow(db,'securityloghash',{SecurityLogNum:row.SecurityLogNum,LogHash:expectedHash(row)},hashColumns);
    }
    if(!editRows.length){
      const log={PermType:16,UserNum:0,LogDateTime:now,LogText:intent.editText,PatNum:690,CompName:os.hostname().slice(0,255),FKey:0,LogSource:0,DefNum:0,DefNumError:0,DateTPrevious:'0001-01-01 00:00:00'};
      const id=await insertFinancialRow(db,'securitylog',log,logColumns);
      await insertFinancialRow(db,'securityloghash',{SecurityLogNum:id,LogHash:odSecurityLogHash({permType:16,userNum:0,logDateTime:now,logText:log.LogText,patNum:690,dateTPrevious:log.DateTPrevious})},hashColumns);
    }
    const after=await readClaim690RepairState(db);
    check(fingerprint(after)===fingerprint(before),'Financial/clinical snapshot changed during audit-only recovery.');
    const [saved]=await execute("SELECT *,DATE_FORMAT(LogDateTime,'%Y-%m-%d %H:%i:%s') AS HashLogDateTime,DATE_FORMAT(DateTPrevious,'%Y-%m-%d %H:%i:%s') AS HashDateTPrevious FROM securitylog WHERE PatNum=? AND LogText IN (?,?) ORDER BY SecurityLogNum",[690,intent.createText,intent.editText]);
    check(saved.length===(intent.plan.targetProcNum?1:2),'Audit log readback count is wrong.');
    for(const row of saved){
      const [hashes]=await execute('SELECT * FROM securityloghash WHERE SecurityLogNum=?',[row.SecurityLogNum]);
      check(isValidTime(row)&&hashes.length===1&&hashes[0].LogHash===expectedHash(row),'Audit/hash readback failed.');
    }
    await writeRecovery({...recoveryIntent,status:'complete',logsAfter:saved,after});
    await writeJournal({...journal,status:'complete',completedAt:now,targetProcNum:intent.targetProcNum,after,auditRecovery:{completedAt:now,originalInvalidTimes:recoveryIntent.logsBefore.filter(r=>r.LogDateTime==='0000-00-00 00:00:00'||r.HashLogDateTime==='0000-00-00 00:00:00').map(r=>r.SecurityLogNum)}});
    return {verified:true,alreadyComplete:false,targetProcNum:intent.targetProcNum,financialRecordsUnchanged:true,patientChangedFields:intent.patientChangedFields};
  }catch(error){
    if(started)error.message+=' Audit recovery may be partial; keep both journals and inspect before retrying.';
    throw error;
  }finally{if(locked)await db.query('UNLOCK TABLES');await db.query('SET SESSION lock_wait_timeout=DEFAULT');}
}
