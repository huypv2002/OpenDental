import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {planMissingProcedures,createMissingProcedures} from './missingProcedures.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';

const paid={code:'D0210',date:'2026-04-26',tooth:'',benefitCents:7300,feeCents:14300};
const denied={...paid,code:'D0220',benefitCents:0};
test('only paid missing services are planned; existing/ambiguous rows are not replaced',()=>{
 const p=planMissingProcedures([], [paid,denied]);assert.equal(p.additions.length,1);assert.equal(p.procs[0].ProcFee,'73.00');assert.ok(p.procs[0].ProcNum<0);
 const existing={...p.procs[0],ProcNum:123};assert.equal(planMissingProcedures([existing],[paid]).additions.length,0);
 assert.throws(()=>planMissingProcedures([existing,{...existing,ProcNum:124}],[paid]),/trùng ngày/);
 assert.throws(()=>planMissingProcedures([],[paid,{...paid}]),/nhiều dòng/);
 for(const change of [{date:''},{date:'2026-02-30'},{code:'bad'},{tooth:'???'}])assert.throws(()=>planMissingProcedures([],[{...paid,...change}]),e=>e.code==='EOB_REVIEW_REQUIRED');
});

test('missing service uses existing catalog code, creates a completed paid procedure once, audits and reuses it',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eob-added-'));
 const f=await insuranceLedger(root,[{patNum:99,firstName:'PERSON',lastName:'TEST',procedures:[paid],serviceDate:paid.date}]);
 f.procs.splice(0,1);
 try{
  const plan=planMissingProcedures(f.procs,[paid,denied]);const saved=await createMissingProcedures(f.pool,{plan,patient:f.patients[0],claimNumber:'TEST1',carrier:'DELTA DENTAL'});
  assert.equal(saved.length,1);assert.equal(saved[0].newCode,false);assert.equal(f.addedAudit.length,1);
  const row=f.procs.find(p=>p.ProcNum===saved[0].procNum);assert.equal(row.ProcFee,'73.00');assert.equal(row.ProcStatus,2);assert.equal(row.PatNum,99);assert.equal(row.ProvNum,1);assert.equal(row.UnitQty,1);
  const again=planMissingProcedures([], [paid]);const reused=await createMissingProcedures(f.pool,{plan:again,patient:f.patients[0],claimNumber:'TEST1',carrier:'DELTA DENTAL'});
  assert.equal(reused[0].procNum,row.ProcNum);assert.equal(reused[0].reused,true);assert.equal(f.addedAudit.length,1);assert.ok(!f.procs.some(p=>p.ProcCode==='D0220'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('new catalog code and tooth are preserved; pending service prevents duplicate completion',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eob-catalog-')),p={...paid,code:'D2950',tooth:'03'};
 const f=await insuranceLedger(root,[{patNum:99,firstName:'PERSON',lastName:'TEST',procedures:[paid],serviceDate:paid.date}]);
 try{
  const plan=planMissingProcedures(f.procs,[p]);const saved=await createMissingProcedures(f.pool,{plan,patient:f.patients[0],claimNumber:'TEST2',carrier:'CIGNA'});
  assert.equal(saved[0].newCode,true);assert.equal(plan.procs.at(-1).ToothNum,'3');assert.equal(f.codes.find(c=>c.ProcCode==='D2950').TreatArea,2);
  const row=f.procs.find(r=>r.ProcNum===saved[0].procNum);row.ProcStatus=1;
  await assert.rejects(createMissingProcedures(f.pool,{plan:planMissingProcedures([],[p]),patient:f.patients[0],claimNumber:'TEST3',carrier:'CIGNA'}),/không thêm lặp/);
  assert.equal(f.addedAudit.length,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('unsupported schema and changed provider stop before insert; failed readback stops before audit/payment',async()=>{
 for(const mode of ['schema','provider','readback']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'eob-add-fail-'));
  const f=await insuranceLedger(root,[{patNum:99,firstName:'PERSON',lastName:'TEST',procedures:[paid],serviceDate:paid.date}]);f.procs.splice(0,1);
  const base=await f.pool.getConnection();
  const pool={getConnection:async()=>({...base,execute:async(sql,args)=>{
   const answer=await base.execute(sql,args);
   if(mode==='schema'&&sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [answer[0].map(r=>({...r,EXTRA:''}))];
   if(mode==='provider'&&sql.includes('FROM provider WHERE'))return [[]];
   if(mode==='readback'&&sql.startsWith('SELECT ProcNum,PatNum,CodeNum'))return [answer[0].map(r=>({...r,ProcFee:999}))];
   return answer;
  }})};
  try{
   await assert.rejects(createMissingProcedures(pool,{plan:planMissingProcedures(f.procs,[paid]),patient:f.patients[0],claimNumber:'FAIL',carrier:'DELTA DENTAL'}),e=>e.code==='EOB_REVIEW_REQUIRED');
   assert.equal(f.addedAudit.length,0);assert.equal(f.payments.length,0);
   assert.equal(f.events.filter(([sql])=>sql.startsWith('INSERT INTO procedurelog')).length,mode==='readback'?1:0);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});

test('quadrant and arch go into OD surface fields rather than invalid tooth numbers',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eob-anatomy-'));
 const f=await insuranceLedger(root,[{patNum:99,firstName:'PERSON',lastName:'TEST',procedures:[paid],serviceDate:paid.date}]);
 try{
  const plan=planMissingProcedures(f.procs,[{...paid,code:'D4341',tooth:'Q01'},{...paid,code:'D5120',tooth:'LA'}]);
  await createMissingProcedures(f.pool,{plan,patient:f.patients[0],claimNumber:'AREA',carrier:'LIBERTY Dental Plan'});
  assert.deepEqual(plan.procs.slice(-2).map(p=>[p.ToothNum,p.Surf]),[['','UR'],['','L']]);
  assert.deepEqual(f.codes.slice(-2).map(c=>c.TreatArea),[4,6]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
