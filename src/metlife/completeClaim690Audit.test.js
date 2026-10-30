import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './testSupport/claim690RepairFixture.js';
import {repairClaim690} from './repairClaim690.js';
import {completeClaim690Audit,validateClaim690AuditRecovery} from './completeClaim690Audit.js';
const copy=v=>JSON.parse(JSON.stringify(v));
async function interrupted(){
 const f=fixture();await repairClaim690(f.db,f.options);
 const original={...copy(f.journal),status:'intent'};delete original.after;delete original.completedAt;delete original.targetProcNum;
 f.setJournal(original);
 f.tables.securitylog.splice(1,1);f.tables.securitylog[0].SecurityLogNum=145427;f.tables.securitylog[0].LogDateTime='0000-00-00 00:00:00';
 f.tables.securityloghash.splice(0);
 let recovery=null;
 const options={journal:original,writeJournal:f.options.writeJournal,readRecovery:async()=>recovery,writeRecovery:async value=>{recovery=copy(value);}};
 return {f,original,options,get recovery(){return recovery;}};
}
test('observed zero-time/no-hash audit is repaired without changing any clinical/financial rows, then replays without writes',async()=>{
 const x=await interrupted(),{f}=x,before=copy(f.state),oldLog=copy(f.tables.securitylog[0]);
 const start=f.events.length;
 const result=await completeClaim690Audit(f.db,x.options);
 assert.equal(result.verified,true);assert.equal(result.financialRecordsUnchanged,true);
 assert.deepEqual(copy(f.state),before);assert.equal(f.tables.securitylog[0].SecurityLogNum,145427);
 assert.equal(f.tables.securitylog[0].LogText,oldLog.LogText);assert.equal(f.tables.securitylog[0].LogDateTime,'2026-10-30 12:00:00');
 assert.equal(f.tables.securitylog.length,2);assert.equal(f.tables.securityloghash.length,2);
 assert.equal(f.journal.status,'complete');assert.equal(x.recovery.status,'complete');
 assert.equal(x.recovery.logsBefore[0].HashLogDateTime,'0000-00-00 00:00:00');
 assert(f.events.slice(start).some(sql=>sql.includes('patient READ,payment READ,paysplit READ,procedurelog READ')));
 assert(f.events.slice(start).filter(s=>/^INSERT|^UPDATE|^DELETE/.test(s)).every(s=>/^(INSERT INTO `securitylog(?:hash)?`|UPDATE securitylog SET)/.test(s)));
 const count=f.events.length;
 const replay=await completeClaim690Audit(f.db,{...x.options,journal:f.journal});
 assert.equal(replay.alreadyComplete,true);assert(f.events.slice(count).every(s=>!/^INSERT|^UPDATE|^DELETE/.test(s)));
});
test('changed balance or split, missing/foreign journal, duplicate audit or conflicting hash stop before recovery writes',async()=>{
 for(const mode of ['balance','split','journal','duplicate','hash']){
  const x=await interrupted(),{f}=x;
  if(mode==='balance')f.state.patients[0].BalTotal=1000;
  if(mode==='split')f.state.splits[1].ProcNum=12;
  if(mode==='journal')x.options.journal={...x.original,repair:'other'};
  if(mode==='duplicate')f.tables.securitylog.push({...f.tables.securitylog[0],SecurityLogNum:999});
  if(mode==='hash')f.tables.securityloghash.push({SecurityLogHashNum:1,SecurityLogNum:145427,LogHash:'foreign-hash'});
  const start=f.events.length;
  await assert.rejects(completeClaim690Audit(f.db,x.options));
  assert(f.events.slice(start).every(s=>!/^INSERT|^UPDATE|^DELETE/.test(s)));
 }
});
test('backup failure and stale financial snapshot cause no audit writes',async()=>{
 for(const mode of ['backup','stale']){
  const x=await interrupted(),{f}=x;
  if(mode==='backup')x.options.writeRecovery=async()=>{throw Error('disk full');};
  else f.onLock(()=>{f.state.payments[0].PayAmt=88;});
  const start=f.events.length;
  await assert.rejects(completeClaim690Audit(f.db,x.options));
  assert(f.events.slice(start).every(s=>!/^INSERT|^UPDATE|^DELETE/.test(s)));
 }
});
test('an interrupted recovery keeps original journal pending and refuses an automatic retry',async()=>{
 const x=await interrupted(),{f}=x,base=f.db.execute;
 const db={...f.db,execute:async(input,args)=>{
  const sql=typeof input==='string'?input:input.sql;
  if(sql.startsWith('INSERT INTO `securityloghash`'))throw Error('simulated audit hash failure');
  return base(input,args);
 }};
 await assert.rejects(completeClaim690Audit(db,x.options),/Audit recovery may be partial/);
 assert.equal(f.journal.status,'intent');assert.equal(x.recovery.status,'intent');
 const count=f.events.length;
 await assert.rejects(completeClaim690Audit(f.db,x.options),/previously interrupted/);
 assert(f.events.slice(count).every(s=>s.startsWith('SELECT')));
});
