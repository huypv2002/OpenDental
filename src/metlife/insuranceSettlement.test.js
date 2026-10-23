import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareInsuranceSettlement,applyInsuranceSettlement,verifiedInsurancePayment,recordInsuranceResult,insuranceZeroFields} from './insuranceSettlement.js';

function ledger(){
 const rows=[1,2,3,4].map((id)=>({ClaimProcNum:id,PatNum:id===4?8:7,ProcNum:id===3?99:id,ClaimNum:id===3?20:10,PlanNum:1,InsSubNum:1,Status:0,InsPayAmt:0,ClaimPaymentNum:0,...Object.fromEntries(insuranceZeroFields.map(k=>[k,80]))}));
 const events=[];let corrupt=false;
 const db={execute:async(sql,args)=>{
  events.push([sql,args]);
  if(sql.includes('FROM claimproc cp'))return [rows.filter(r=>String(r.PatNum)===String(args[0])&&args.slice(1,-1).map(String).includes(String(r.ProcNum))).map(r=>({...r}))];
  if(sql.startsWith('SELECT')&&sql.includes('ClaimProcNum IN'))return [rows.filter(r=>String(r.PatNum)===String(args[0])&&args.slice(1).includes(r.ClaimProcNum)).map(r=>({...r,...(corrupt?{WriteOffEst:5}:{})}))];
  if(sql.startsWith('UPDATE claimproc SET')){assert.match(sql,/WHERE PatNum=\? AND ClaimProcNum IN/);for(const r of rows)if(String(r.PatNum)===String(args[0])&&args.slice(1).includes(r.ClaimProcNum))for(const k of insuranceZeroFields)r[k]=0;return [{affectedRows:2}];}
  if(sql.includes('COALESCE(SUM(InsPayEst)')){const selected=rows.filter(r=>String(r.ClaimNum)===String(args[0])&&String(r.PatNum)===String(args[1]));return [[{InsPayEst:selected.reduce((n,r)=>n+r.InsPayEst,0),WriteOff:selected.reduce((n,r)=>n+r.WriteOff,0)}]];}
  if(sql.startsWith('UPDATE claim SET')){assert.deepEqual(args,['2026-10-21',0,0,'10',7]);return [{affectedRows:1}];}
  throw Error('Unexpected query '+sql);
 }};
 return {db,rows,events,corruptReadback:()=>{corrupt=true;}};
}
const options={patNum:7,carrier:'CIGNA',procedures:[{code:'D0150',date:'2026-10-18',benefitCents:3000},{code:'D1110',date:'2026-10-18',benefitCents:0}],dbProcs:[{ProcNum:1,ProcCode:'D0150',ProcDate:'2026-10-18'},{ProcNum:2,ProcCode:'D1110',ProcDate:'2026-10-18'}],splits:[{ProcNum:1}]};

test('zero estimate/writeoff, including overrides and denied services, preserves other claims and patients',async()=>{
 const f=ledger(),before=f.rows.map(r=>({...r}));const plan=await prepareInsuranceSettlement(f.db,options);assert.deepEqual(plan.claimIds,['10']);assert.equal(plan.rows.length,2);
 assert.match(f.events[0][0],/UPPER\(ca.CarrierName\) LIKE \?/);assert.equal(f.events[0][1].at(-1),'%CIGNA%');
 await applyInsuranceSettlement(f.db,plan,'2026-10-21');
 assert.ok(f.rows.slice(0,2).every(r=>insuranceZeroFields.every(k=>r[k]===0)));assert.deepEqual(f.rows.slice(2),before.slice(2));
 assert.ok(f.events.some(([sql])=>sql.startsWith('SELECT ClaimProcNum,InsPayEst')),'readback verifies the saved defaults');
 assert.ok(f.events.every(([sql])=>!sql.includes('SET InsPayAmt')&&!sql.startsWith('DELETE')));
});

test('ambiguous claims/subscriptions and actual insurance payments stop before financial writes',async()=>{
 for(const change of [r=>{r[1].ClaimNum=11;},r=>{r[1].InsSubNum=2;},r=>{r[0].InsPayAmt=5;},r=>{r[0].ClaimPaymentNum=8;}]){
  const f=ledger();change(f.rows);await assert.rejects(prepareInsuranceSettlement(f.db,options),e=>e.code==='EOB_REVIEW_REQUIRED');assert.ok(f.events.every(([sql])=>sql.startsWith('SELECT')));
 }
});

test('changed claim association and failed zero readback are reported for review',async()=>{
 const f=ledger(),plan=await prepareInsuranceSettlement(f.db,options);f.rows[0].ClaimNum=77;
 await assert.rejects(applyInsuranceSettlement(f.db,plan,'2026-10-21'),e=>e.code==='EOB_REVIEW_REQUIRED');assert.ok(f.events.every(([sql])=>sql.startsWith('SELECT')));
 const g=ledger(),next=await prepareInsuranceSettlement(g.db,options);g.corruptReadback();await assert.rejects(applyInsuranceSettlement(g.db,next,'2026-10-21'),/Chưa xác minh/);
});

const paymentPlan={patNum:7,claimNumber:'CLAIM7',date:'2026-10-21',amountCents:3000,splits:[{ProcNum:1,ProvNum:2,ClinicNum:0,date:'2026-10-18',amount:'30.00'}]};
function previousDb({payment={},split={},extra=false,missing=false}={}){
 return {execute:async(sql,args)=>{
  assert.match(sql,/^SELECT/);
  if(sql.includes('FROM payment WHERE')){assert.deepEqual(args,[7,'CLAIM7','CLAIM7']);return [[{PayNum:18,PatNum:7,PayDate:'2026-10-21',PayAmt:'30.00',...payment}]];}
  const row={PatNum:7,ProcNum:1,ProvNum:2,ClinicNum:0,ProcDate:'2026-10-18',DatePay:'2026-10-21',SplitAmt:'30.00',...split};return [missing?[]:extra?[row,{...row,ProcNum:2,SplitAmt:'1.00'}]:[row]];
 }};
}
test('a verified existing payment is reused without any mutations',async()=>{
 assert.equal((await verifiedInsurancePayment(previousDb(),paymentPlan)).PayNum,18);
});
test('conflicting or incomplete existing payments are never deleted/replaced',async()=>{
 for(const variant of [{payment:{PatNum:8}},{payment:{PayDate:'2026-10-22'}},{payment:{PayAmt:31}},{split:{PatNum:8}},{split:{ProcNum:2}},{split:{ProvNum:3}},{split:{ClinicNum:1}},{split:{ProcDate:'2026-10-17'}},{split:{SplitAmt:29}},{extra:true},{missing:true}])await assert.rejects(verifiedInsurancePayment(previousDb(variant),paymentPlan),e=>e.code==='EOB_REVIEW_REQUIRED');
});
test('retry updates original history defaults while preserving original source metadata',async()=>{
 const previous={carrier:'CIGNA',archivePath:'original.pdf',sourceProcedures:[{code:'D2391'}]};let inserted=0,saved;
 const values=['new.pdf','newhash',7,'TEST','CLAIM7','',30,1,'',18,9,'success',JSON.stringify({insuranceDefaults:{estimate:0,writeOff:0}})];
 const db={execute:async(sql,args)=>{if(sql.startsWith('SELECT Id,Details'))return [[{Id:3,Details:JSON.stringify(previous)}]];if(sql.startsWith('INSERT'))inserted++;saved=JSON.parse(args[0]);return [{affectedRows:1}];}};
 const result=await recordInsuranceResult(db,values);assert.equal(result.reused,true);assert.equal(inserted,0);assert.equal(saved.archivePath,'original.pdf');assert.deepEqual(saved.sourceProcedures,previous.sourceProcedures);assert.deepEqual(saved.insuranceDefaults,{estimate:0,writeOff:0});
});
