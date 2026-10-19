import {test} from 'node:test';import assert from 'node:assert/strict';
import {createOdApiPaymentWriter,apiPaymentStatus,supportsExactApiSplits} from './odApiPayment.js';
function fixture({version='25.1.11.0',enabled=true,failAt=0}={}){
 const context={capturedAt:new Date().toISOString(),patNum:'99',warnings:[],tables:{definition:[{DefNum:'10',Category:10,ItemName:'Insurance Paid',IsHidden:0}],procedurelog:[{PatNum:'99',ProcNum:'51',CodeNum:'1',ProvNum:'3',ClinicNum:0,ProcStatus:2,ProcDate:'2026-09-13',ToothNum:'13'}],procedurecode:[{CodeNum:'1',ProcCode:'D2392',Descript:'Composite'}],provider:[{ProvNum:'3',Abbr:'DOC'}],payment:[],paysplit:[],claimproc:[],claimpayment:[]}};
 const plan={patNum:'99',sha256:'a'.repeat(64),amount:'35.00',date:'2026-09-24',note:'group number : SYNTHETIC',checkNum:'SYNTHETIC-CHECK',paymentType:'Insurance Paid',splits:[{ProcNum:'51',ProvNum:'3',ClinicNum:0,code:'D2392',date:'2026-09-13',tooth:'13',providerAbbr:'DOC',description:'Composite',amountCents:3500}]};
 const config={enabled,baseUrl:'http://127.0.0.1:30223/api/v1',developerKey:'synthetic-dev-key',customerKey:'synthetic-customer-key'};
 const calls=[],progress=[];
 const pool={execute:async sql=>{assert.ok(sql.startsWith('SELECT '),'API writer must not execute SQL writes');return [[{ValueString:version}]];}};
 const writer=createOdApiPaymentWriter(pool,{getConfig:()=>config,readContext:async()=>context,fetchApi:async(url,options)=>{calls.push({url,...options,body:JSON.parse(options.body)});if(calls.length===failAt)throw new Error('Synthetic network interruption');return {ok:true,status:200,text:async()=>JSON.stringify({PayNum:777})};}});
 return {pool,config,calls,progress,writer,op:{id:'synthetic-operation',patNum:'99',before:context,plan}};
}
test('exact API allocation requires supported version and credentials; no request for 24.3 or disabled API',async()=>{
 assert.equal(supportsExactApiSplits('24.3.61.0'),false);assert.equal(supportsExactApiSplits('25.1.10.0'),false);assert.equal(supportsExactApiSplits('25.1.11.0'),true);assert.equal(supportsExactApiSplits('25.2.0.0'),true);
 for(const options of [{version:'24.3.61.0'},{enabled:false}]){
  const f=fixture(options);assert.equal((await apiPaymentStatus(f.pool,{getConfig:()=>f.config})).ready,false);
  await assert.rejects(f.writer(f.op),e=>e.noWrite===true);assert.equal(f.calls.length,0);
 }
});
test('API creates one payment and allocates exact reviewed amounts without SQL writes',async()=>{
 const f=fixture();const receipt=await f.writer(f.op,r=>f.progress.push(r));
 assert.equal(receipt.payNum,'777');assert.deepEqual(f.progress.map(r=>r.stage),['created','allocated']);
 assert.deepEqual(f.calls.map(c=>c.method),['POST','PUT']);assert.ok(f.calls[0].url.endsWith('/payments'));assert.ok(f.calls[1].url.endsWith('/payments/777/Partial'));
 assert.equal(f.calls[0].body.PayType,10);assert.equal(f.calls[0].body.CheckNum,'SYNTHETIC-CHECK');assert.equal(f.calls[0].body.isPatientPreferred,'true');
 assert.deepEqual(f.calls[1].body,{procNumsAndAmounts:[{ProcNum:51,Amount:35}]});
 assert.ok(!JSON.stringify(f.calls.map(c=>c.body)).includes('SecurityHash'));
});
test('API create/partial failures retain uncertain state; no automatic retry or compensating delete',async()=>{
 for(const failAt of [1,2]){
  const f=fixture({failAt});await assert.rejects(f.writer(f.op,r=>f.progress.push(r)),e=>e.noWrite===false);
  assert.equal(f.calls.length,failAt);assert.deepEqual(f.progress.map(r=>r.stage),failAt===1?[]:['created']);assert.ok(f.calls.every(c=>c.method!=='DELETE'));
 }
});
test('API credentials require HTTPS or loopback; invalid identity is rejected before the write',async()=>{
 const f=fixture();f.config.baseUrl='http://example.invalid/api/v1';await assert.rejects(f.writer(f.op),e=>e.noWrite===true);assert.equal(f.calls.length,0);
});
