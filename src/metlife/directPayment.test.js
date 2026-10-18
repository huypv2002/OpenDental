import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDirectPaymentWriter,paymentRows,insertFinancialRow} from './directPayment.js';
import {createPostingCoordinator,validatePostingPlan} from './posting.js';
const hash='a'.repeat(64);
function context(){return {capturedAt:new Date().toISOString(),patNum:'99',warnings:[],tables:{patient:[{PatNum:'99',ClinicNum:'2'}],definition:[{DefNum:'10',Category:10,ItemName:'Insurance Paid',IsHidden:0}],procedurelog:[{PatNum:'99',ProcNum:'51',CodeNum:'1',ProvNum:'3',ClinicNum:'2',ProcStatus:2,ProcDate:'2026-09-13',ToothNum:'13'}],procedurecode:[{CodeNum:'1',ProcCode:'D2392',Descript:'Composite'}],provider:[{ProvNum:'3',Abbr:'DOC'}],claimproc:[],payment:[],paysplit:[],claimpayment:[]}};}
function draft(){return {patNum:'99',sha256:hash,amount:'35.00',date:'2026-09-24',note:'group number : TEST',checkNum:'TEST-TRACE',paymentType:'Insurance Paid',splits:[{ProcNum:'51',ProvNum:'3',ClinicNum:'2',code:'D2392',date:'2026-09-13',tooth:'13',providerAbbr:'DOC',description:'Composite',amountCents:3500}]};}
function fixture(options={}){
 const before=context(),plan=validatePostingPlan(before,draft()),calls=[],rows={payment:[],paysplit:[]};let id=80,receipt=null;
 const maps=paymentRows(plan,'7','2');
 const columns=Object.entries({payment:{...maps.payment,PayNum:0,DateEntry:''},paysplit:{...maps.splits[0],PayNum:0,SplitNum:0,DateEntry:''}}).flatMap(([table,map])=>Object.keys(map).map(k=>({TABLE_NAME:table,COLUMN_NAME:k,COLUMN_DEFAULT:null,IS_NULLABLE:'NO',EXTRA:k===(table==='payment'?'PayNum':'SplitNum')?'auto_increment':''})));
 const conn={
  query:async sql=>{calls.push(sql);},beginTransaction:async()=>calls.push('begin'),
  execute:async({sql},args)=>{
   calls.push(sql);
   if(sql.includes('INFORMATION_SCHEMA.TABLES'))return [args.map(t=>({TABLE_NAME:t,ENGINE:options.engine||'InnoDB'}))];
   if(sql.includes('FROM luk_metlife_postings'))return [receipt?[receipt]:[]];
   if(sql.includes('FROM userod'))return [[{UserNum:7}]];
   if(sql.includes('FROM preference'))return [options.prefs||[]];
   if(sql.includes('CURDATE() AS')||sql.includes('AS today'))return [[{today:'2026-10-18'}]];
   if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [columns];
   if(sql.startsWith('INSERT INTO `')){
    const table=sql.match(/INSERT INTO `(\w+)`/)[1];
    if(options.failSplit&&table==='paysplit')throw new Error('injected split failure');
    const names=sql.match(/\((.*?)\) VALUES/)[1].replaceAll('`','').split(',');
    const row=Object.fromEntries(names.map((n,i)=>[n,args[i]??'2026-10-18']));row[table==='payment'?'PayNum':'SplitNum']=String(++id);rows[table].push(row);return [{}];
   }
   if(sql.includes('LAST_INSERT_ID'))return [[{id:String(id)}]];
   if(sql.startsWith('INSERT INTO luk_metlife_postings')){receipt={PayNum:args[4],PlanJson:args[5]};return [{}];}
   throw new Error('Unexpected fixture SQL: '+sql);
  },
  commit:async()=>{calls.push('commit');if(options.commitError)throw new Error('lost COMMIT response');},
  rollback:async()=>{calls.push('rollback');},release:()=>calls.push('release'),destroy:()=>calls.push('destroy')
 };
 const pool={query:async sql=>{calls.push(sql);},getConnection:async()=>conn};
 const readContext=async(_pool,_pat,opt)=>{assert.equal(opt.connection,conn);assert.equal(opt.forUpdate,true);const s=context();s.tables.payment=structuredClone(rows.payment);s.tables.paysplit=structuredClone(rows.paysplit);if(options.wrongReadback&&rows.paysplit.length)s.tables.paysplit[0].ProcNum='999';return s;};
 const writer=createDirectPaymentWriter(pool,{enabled:()=>true,userNum:()=>7,readContext});
 return {writer,args:{id:'11111111-1111-4111-8111-111111111111',patNum:'99',docNum:'1',plan,before},calls,rows,columns,conn};
}
test('direct transaction writes exact procedure split and journal before commit',async()=>{
 const f=fixture();const r=await f.writer(f.args);
 assert.equal(r.payNum,'81');assert.equal(f.rows.paysplit[0].PayNum,'81');assert.equal(f.rows.paysplit[0].SplitAmt,'35.00');assert.equal(f.rows.paysplit[0].ProcNum,'51');assert.equal(f.rows.payment[0].SecUserNumEntry,'7');
 assert.ok(f.calls.findIndex(s=>s.startsWith('INSERT INTO luk_metlife_postings'))<f.calls.indexOf('commit'));
 assert.equal(f.calls.at(-1),'release');
 const writes=f.calls.filter(s=>s.startsWith('INSERT')).length;assert.equal((await f.writer(f.args)).replayed,true);assert.equal(f.calls.filter(s=>s.startsWith('INSERT')).length,writes);
});
test('nontransactional OD tables stop before clinical inserts',async()=>{
 const f=fixture({engine:'MyISAM'});await assert.rejects(f.writer(f.args),/InnoDB/);assert.ok(!f.calls.some(s=>s.startsWith('INSERT')));
});
test('split failure and failed readback both rollback rather than commit',async()=>{
 for(const options of [{failSplit:true},{wrongReadback:true}]){
  const f=fixture(options);await assert.rejects(f.writer(f.args),e=>e.noWrite===true);assert.ok(f.calls.includes('rollback'));assert.ok(!f.calls.includes('commit'));
 }
});
test('COMMIT transport failure is never labeled as a safe retry',async()=>{
 const f=fixture({commitError:true});await assert.rejects(f.writer(f.args),e=>e.message==='lost COMMIT response'&&!e.noWrite);
});
test('unknown required schema columns are rejected',async()=>{
 const f=fixture();await assert.rejects(insertFinancialRow(f.conn,'payment',paymentRows(f.args.plan,'7','2').payment,[...f.columns.filter(c=>c.TABLE_NAME==='payment'),{COLUMN_NAME:'NewRequiredField',COLUMN_DEFAULT:null,IS_NULLABLE:'NO',EXTRA:''}]),/NewRequiredField/);
});
test('accounting and date locks block SQL writes requiring native business logic',async()=>{
 for(const name of ['AccountingAutomaticPaymentEntry','AccountingSoftware','DateLockLimitDays','RandomPrimaryKeys']){
  const f=fixture({prefs:[{PrefName:name,ValueString:'1'}]});await assert.rejects(f.writer(f.args));assert.ok(!f.calls.some(s=>s.startsWith('INSERT')));
 }
});
test('disabled adapter is a confirmed pre-write failure',async()=>{
 const writer=createDirectPaymentWriter({},{enabled:()=>false});await assert.rejects(writer({}),e=>e.noWrite===true);
});
test('changed tooth is rejected even if code/date/provider still match',()=>{
 const d=draft();d.splits[0].tooth='14';assert.throws(()=>validatePostingPlan(context(),d),/tooth/);
});
test('posting coordinator never repeats an uncertain commit, including after restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-direct-'));let count=0;
 const repo={context:async()=>context(),pdf:async()=>({sha256:hash}),postDirect:async()=>{count++;throw new Error('timeout');},directReceipt:async()=>null};
 try{
  let c=createPostingCoordinator({repository:repo,directory:dir});const op=await c.prepare({patNum:'99',docNum:'1',draft:draft(),transport:'direct-db'});
  await assert.rejects(c.post(op.operationId),/timeout/);c=createPostingCoordinator({repository:repo,directory:dir});
  await assert.rejects(c.post(op.operationId),/không gửi lại/);assert.equal(count,1);assert.equal((await c.abort(op.operationId)).released,false);assert.equal((await c.verify(op.operationId)).verified,false);assert.equal((await c.patientPending('99')).pending,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('confirmed pre-write failure can release patient lock',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-direct-abort-'));
 const c=createPostingCoordinator({repository:{context:async()=>context(),pdf:async()=>({sha256:hash}),postDirect:async()=>{throw Object.assign(new Error('disabled'),{noWrite:true});}},directory:dir});
 try{const op=await c.prepare({patNum:'99',docNum:'1',draft:draft(),transport:'direct-db'});await assert.rejects(c.post(op.operationId));assert.equal((await c.abort(op.operationId)).released,true);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
