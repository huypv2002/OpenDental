import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {validatePostingPlan,verifyPostedPayment,createPostingCoordinator} from './posting.js';
const hash='a'.repeat(64);
function before(){return {capturedAt:new Date().toISOString(),patNum:'99',warnings:[],tables:{definition:[{DefNum:'10',Category:10,ItemName:'Insurance Paid',IsHidden:0}],procedurelog:[{PatNum:'99',ProcNum:'51',CodeNum:'1',ProvNum:'3',ClinicNum:'0',ProcStatus:2,ProcDate:'2026-09-13',ToothNum:'13'}],procedurecode:[{CodeNum:'1',ProcCode:'D2392',Descript:'Composite'}],provider:[{ProvNum:'3',Abbr:'DOC'}],claimproc:[],payment:[],paysplit:[],claimpayment:[]}};}
function draft(){return {patNum:'99',sha256:hash,amount:'35.00',date:'2026-09-24',note:'group number : 217117',checkNum:'000012345',paymentType:'Insurance Paid',splits:[{ProcNum:'51',ProvNum:'3',ClinicNum:'0',code:'D2392',date:'2026-09-13',tooth:'13',providerAbbr:'DOC',description:'Composite',amountCents:3500}]};}
function posted(plan){const after=before();after.tables.payment=[{PayNum:'88',PatNum:'99',PayDate:plan.date,PayAmt:plan.amount,PayType:plan.paymentTypeDefNum,CheckNum:plan.checkNum,PayNote:plan.note}];after.tables.paysplit=[{SplitNum:'89',PayNum:'88',PatNum:'99',ProcNum:'51',ProvNum:'3',ClinicNum:0,SplitAmt:'35.00',UnearnedType:0,AdjNum:0,PayPlanNum:0,PayPlanChargeNum:0,DatePay:plan.date}];return after;}
test('preflight assigns exact Insurance Paid definition and validates procedure allocation',()=>{const p=validatePostingPlan(before(),draft());assert.equal(p.paymentTypeDefNum,'10');assert.equal(p.mode,'save-authorized');});
test('preflight rejects wrong type, ambiguous UI identity, stale provider and amount mismatch',()=>{
 for(const change of [s=>s.tables.definition[0].IsHidden=1,s=>s.tables.definition.push({...s.tables.definition[0],DefNum:'11'}),s=>s.tables.procedurelog.push({...s.tables.procedurelog[0],ProcNum:'52'}),s=>s.tables.provider[0].Abbr='OTHER',s=>s.tables.procedurecode[0].Descript='Different']){const s=before();change(s);assert.throws(()=>validatePostingPlan(s,draft()));}
 const d=draft();d.splits[0].amountCents=3000;assert.throws(()=>validatePostingPlan(before(),d));
});
test('preflight rejects old payment, old claim payment and already paid procedure',()=>{
 for(const change of [s=>s.tables.payment.push({CheckNum:'000012345'}),s=>s.tables.claimpayment.push({CheckNum:'000012345'}),s=>s.tables.claimproc.push({ProcNum:'51',InsPayAmt:'35.00'})]){const s=before();change(s);assert.throws(()=>validatePostingPlan(s,draft()));}
});
test('readback verifies only new payment plus exact split identity',()=>{
 const b=before(),p=validatePostingPlan(b,draft()),a=posted(p);assert.equal(verifyPostedPayment(b,a,p).verified,true);
 for(const change of [s=>s.tables.payment[0].PayNote='different',s=>s.tables.payment[0].PayType='11',s=>s.tables.paysplit[0].ProcNum='52',s=>s.tables.paysplit[0].ProvNum='4',s=>s.tables.paysplit[0].SplitAmt='34.99',s=>s.tables.paysplit[0].UnearnedType=9,s=>s.tables.paysplit[0].PayPlanNum=1,s=>s.tables.paysplit.push({...s.tables.paysplit[0],SplitNum:'90'})]){const wrong=posted(p);change(wrong);assert.equal(verifyPostedPayment(b,wrong,p).verified,false);}
 b.tables.payment=[{PayNum:'88'}];assert.equal(verifyPostedPayment(b,a,p).verified,false);
});
test('persistent patient lock prevents double writes across coordinator restart; successful readback releases it',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-post-'));let context=before();const repository={context:async()=>context,pdf:async()=>({sha256:hash})};
 try{
  const coordinator=createPostingCoordinator({repository,directory:dir});const first=await coordinator.prepare({patNum:'99',docNum:'1',draft:draft()});
  const restarted=createPostingCoordinator({repository,directory:dir});await assert.rejects(restarted.prepare({patNum:'99',docNum:'1',draft:draft()}),/chưa xác minh/);
  assert.equal((await restarted.verify(first.operationId)).verified,false);
  await assert.rejects(restarted.prepare({patNum:'99',docNum:'1',draft:draft()}));
  context=posted(first.plan);assert.equal((await restarted.verify(first.operationId)).verified,true);
  assert.equal((await restarted.verify(first.operationId)).verified,true);
  await assert.rejects(fs.stat(path.join(dir,'patient-99.lock')),{code:'ENOENT'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('abort releases only when no financial state changed; altered state stays locked',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-abort-'));let context=before();const repository={context:async()=>context,pdf:async()=>({sha256:hash})};
 try{
  const c=createPostingCoordinator({repository,directory:dir});const first=await c.prepare({patNum:'99',docNum:'1',draft:draft()});assert.equal((await c.abort(first.operationId)).released,true);
  const second=await c.prepare({patNum:'99',docNum:'1',draft:draft()});context=before();context.tables.payment.push({PayNum:'100',PayAmt:'1.00'});assert.equal((await c.abort(second.operationId)).released,false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('PDF content mismatch releases preflight lock without starting operation',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-hash-'));const c=createPostingCoordinator({repository:{context:async()=>before(),pdf:async()=>({sha256:'b'.repeat(64)})},directory:dir});
 try{await assert.rejects(c.prepare({patNum:'99',docNum:'1',draft:draft()}),/PDF changed/);await assert.rejects(fs.stat(path.join(dir,'patient-99.lock')),{code:'ENOENT'});}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('immediate pre-Save recheck blocks financial state drift and file replacement',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-recheck-'));let context=before(),sha=hash;
 const c=createPostingCoordinator({repository:{context:async()=>context,pdf:async()=>({sha256:sha})},directory:dir});
 try{const op=await c.prepare({patNum:'99',docNum:'1',draft:draft()});assert.equal((await c.recheck(op.operationId)).ready,true);sha='b'.repeat(64);await assert.rejects(c.recheck(op.operationId),/PDF changed/);sha=hash;context=before();context.tables.paysplit.push({SplitNum:'77'});await assert.rejects(c.recheck(op.operationId),/thay đổi/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('pending operation can be recovered by patient without local journal',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-pending-'));const c=createPostingCoordinator({repository:{context:async()=>before(),pdf:async()=>({sha256:hash})},directory:dir});
 try{assert.equal((await c.patientPending('99')).pending,false);const op=await c.prepare({patNum:'99',docNum:'1',draft:draft()});assert.equal((await c.patientPending('99')).operationId,op.operationId);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('UI Save authorization survives restart, cannot be issued twice or aborted after an uncertain click',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-ui-save-'));let context=before();
 const repository={context:async()=>context,pdf:async()=>({sha256:hash}),postDirect:async()=>{throw new Error('Direct write must not run');}};
 try{
  const c=createPostingCoordinator({repository,directory:dir});const op=await c.prepare({patNum:'99',docNum:'1',draft:draft(),transport:'od-ui'});
  assert.equal((await c.recheck(op.operationId)).ready,true);
  assert.equal((await c.beginUiSave(op.operationId)).ready,true);
  const restarted=createPostingCoordinator({repository,directory:dir});
  assert.equal((await restarted.status(op.operationId)).state,'ui-saving');
  await assert.rejects(restarted.beginUiSave(op.operationId));
  await assert.rejects(restarted.post(op.operationId));
  assert.equal((await restarted.abort(op.operationId)).released,false);
  assert.equal((await restarted.verify(op.operationId)).verified,false);
  assert.equal((await restarted.abort(op.operationId)).released,false);
  context=posted(op.plan);assert.equal((await restarted.verify(op.operationId)).verified,true);
  await assert.rejects(fs.stat(path.join(dir,'patient-99.lock')),{code:'ENOENT'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('UI Save authorization rejects financial drift and does not advance a prepared operation',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-ui-drift-'));let context=before();
 const c=createPostingCoordinator({repository:{context:async()=>context,pdf:async()=>({sha256:hash})},directory:dir});
 try{
  const op=await c.prepare({patNum:'99',docNum:'1',draft:draft(),transport:'od-ui'});
  context=before();context.tables.paysplit.push({SplitNum:'7'});
  await assert.rejects(c.beginUiSave(op.operationId),/thay đổi/);
  assert.equal((await c.status(op.operationId)).state,'prepared');
  context=before();assert.equal((await c.abort(op.operationId)).released,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('API partial failure persists created receipt and blocks replay/abort after coordinator restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-api-post-'));let context=before(),apiCalls=0;
 const repository={context:async()=>context,pdf:async()=>({sha256:hash}),postApi:async(_op,progress)=>{apiCalls++;await progress({payNum:'88',stage:'created'});throw Object.assign(new Error('Synthetic partial request failure'),{noWrite:false});}};
 try{
  const c=createPostingCoordinator({repository,directory:dir});const op=await c.prepare({patNum:'99',docNum:'1',draft:draft(),transport:'od-api'});
  await assert.rejects(c.post(op.operationId));
  const saved=JSON.parse(await fs.readFile(path.join(dir,op.operationId+'.json'),'utf8'));assert.equal(saved.receipt.payNum,'88');assert.equal(saved.receipt.stage,'created');
  const restart=createPostingCoordinator({repository,directory:dir});await assert.rejects(restart.post(op.operationId));assert.equal(apiCalls,1);assert.equal((await restart.abort(op.operationId)).released,false);
  context=posted(saved.plan);assert.equal((await restart.verify(op.operationId)).verified,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('blank CheckNum remains blank; unrelated blank checks do not block, same claim still does',()=>{
 const s=before(),d={...draft(),checkNum:'',claimRaw:'TESTCLAIM',note:'Claim number: TESTCLAIM'};
 s.tables.payment=[{PayNum:'2',CheckNum:'',PayDate:'2026-09-01',PayAmt:'1.00',PayNote:'Claim number: OTHER'}];
 s.tables.claimpayment=[{CheckNum:'',CheckDate:'2026-09-01',CheckAmt:'1.00'}];
 const p=validatePostingPlan(s,d);assert.equal(p.checkNum,'');assert.equal(d.checkNum,'');
 const after=posted(p);after.tables.payment.push(...s.tables.payment);
 assert.equal(verifyPostedPayment(s,after,p).verified,true);
 for(const identity of [{ExternalId:'TESTCLAIM'},{PayNote:'Claim number: TESTCLAIM'}]){
  const dup=before();dup.tables.payment=[{...identity,CheckNum:'',PayDate:'2026-01-01',PayAmt:'1.00'}];
  assert.throws(()=>validatePostingPlan(dup,d),/duplicate/);
 }
});
