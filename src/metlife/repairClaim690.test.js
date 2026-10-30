import test from 'node:test';
import assert from 'node:assert/strict';
import {repairClaim690,planClaim690Repair,summarizeClaim690Splits,inspectClaim690Repair} from './repairClaim690.js';
const clone=v=>JSON.parse(JSON.stringify(v));
import {fixture} from './testSupport/claim690RepairFixture.js';

test('preview is SELECT-only and discloses the $74 balance increase',async()=>{
 const f=fixture();const result=await repairClaim690(f.db);
 assert.equal(result.applied,false);assert.equal(result.plan.balanceIncreaseCents,7400);assert.equal(result.plan.afterBalanceCents,50900);
 assert(f.events.every(s=>s.startsWith('SELECT')));assert.equal(f.journal,null);
});

test('MySQL Date objects and SQL date strings produce the same repair plan',()=>{
 const f=fixture();const expected=planClaim690Repair(f.state);
 f.state.payments[0].PayDate=new Date(2025,9,15);
 for(const split of f.state.splits){split.DatePay=new Date(2025,9,15);split.ProcDate=new Date(2025,8,19);}
 for(const proc of f.state.procedures)proc.ProcDate=new Date(2025,8,19);
 assert.deepEqual(planClaim690Repair(f.state),expected);
 assert.equal(summarizeClaim690Splits(f.state)[0].SplitProcDate,'2025-09-19 00:00:00');
});
test('a conflicting non-empty split date reports actual rows without writes',async()=>{
 const f=fixture();f.state.splits[1].ProcDate='2025-09-20';
 await assert.rejects(repairClaim690(f.db),e=>/split ProcDate is neither/.test(e.message)&&e.repairSplits[1].SplitProcDate==='2025-09-20'&&e.repairSplits[1].ActualServiceDate==='2025-09-19');
 assert(f.events.every(s=>s.startsWith('SELECT')));assert.equal(f.journal,null);
});
test('live split IDs/order and empty ProcDate sentinel are preserved through repair and replay',async()=>{
 const f=fixture();
 f.state.procedures[0].ProcNum=5734;f.state.procedures[1].ProcNum=10646;
 f.state.claimprocs[0].ProcNum=10646;
 f.state.splits[0].SplitNum=3102;f.state.splits[0].ProcNum=5734;
 f.state.splits[1].SplitNum=3101;f.state.splits[1].ProcNum=10646;
 f.state.splits.reverse();
 for(const split of f.state.splits)split.ProcDate='0001-01-01';
 const fixed=clone(f.state.splits.find(s=>s.SplitNum===3102));
 const preview=await repairClaim690(f.db);
 assert.equal(preview.plan.splitNum,3101);assert.equal(preview.plan.oldProcNum,10646);
 const result=await repairClaim690(f.db,f.options);assert(result.verified);
 assert.equal(f.state.splits.find(s=>s.SplitNum===3101).ProcNum,100);
 assert.deepEqual(f.state.splits.find(s=>s.SplitNum===3102),fixed);
 assert(f.state.splits.every(s=>s.ProcDate==='0001-01-01'&&s.DatePay==='2025-10-15'));
 assert.equal((await repairClaim690(f.db,f.options)).plan.status,'already-correct');
});
test('empty split ProcDate never bypasses linked service date checks',()=>{
 for(const index of [0,1]){
  const f=fixture();for(const split of f.state.splits)split.ProcDate='0001-01-01';
  f.state.procedures[index].ProcDate='2025-09-20';
  assert.throws(()=>planClaim690Repair(f.state),/completed D0150|completed service/);
 }
});
test('D0210 catalog None=0 and Mouth=3 both support area-free creation without changing catalog',async()=>{
 for(const TreatArea of [0,3]){
  const f=fixture();f.state.codes[2].TreatArea=TreatArea;
  const before=clone(f.state.codes);
  assert.equal(planClaim690Repair(f.state).status,'ready');
  assert.equal((await repairClaim690(f.db,f.options)).verified,true);
  assert.deepEqual(f.state.codes,before);
 }
});
test('missing catalog category and tooth/arch/surface treatment areas still block and show actual catalog',async()=>{
 for(const override of [{ProcCat:999},{TreatArea:1},{TreatArea:2},{TreatArea:4},{TreatArea:6},{TreatArea:null}]){
  const f=fixture();Object.assign(f.state.codes[2],override);
  await assert.rejects(repairClaim690(f.db),e=>e.message.includes('D0210 catalog')&&e.repairCatalog.some(c=>c.ProcCode==='D0210'));
  assert(f.events.every(s=>s.startsWith('SELECT')));
 }
});
test('procedurecode without IsHidden is supported; hidden or missing category remains blocked',async()=>{
 const f=fixture();assert.equal(Object.hasOwn(f.state.codes[2],'IsHidden'),false);
 f.state.codes[2].TreatArea=0;
 assert.equal((await repairClaim690(f.db,f.options)).verified,true);
 for(const value of [1,null]){
  const blocked=fixture();blocked.state.codeCategories[0].IsHidden=value;
  await assert.rejects(repairClaim690(blocked.db),e=>/category is hidden or unknown/.test(e.message)&&e.repairCatalog[2].CategoryHidden===value);
  assert(blocked.events.every(s=>s.startsWith('SELECT')));
 }
});
for(const target of [false,true])test(`repair ${target?'reuses':'adds'} D0210, changes only the split link/hash and authorized balance, then replays without writes`,async()=>{
 const f=fixture({target}),before=clone(f.state);
 const result=await repairClaim690(f.db,f.options);assert(result.verified);
 assert.deepEqual(f.state.payments,before.payments);assert.deepEqual(f.state.claimprocs,before.claimprocs);assert.deepEqual(f.state.otherSplits,before.otherSplits);
 assert.deepEqual(f.state.splits[0],before.splits[0]);assert.equal(f.state.splits[1].ProcNum,target?13:100);assert.equal(f.state.splits[1].SecurityHash,'native-hash');
 assert.equal(Number(f.state.patients[0].BalTotal),target?435:509);assert.equal(f.state.patients[0].InsEst,10);
 assert.deepEqual(f.state.procedures.slice(0,before.procedures.length),before.procedures);
 assert.equal(f.tables.securitylog.length,target?1:2);assert.equal(f.tables.securityloghash.length,target?1:2);
 assert(f.tables.securitylog.some(r=>r.PermType===16));assert.equal(f.journal.status,'complete');assert.equal(f.locked,false);
 const count=f.events.length;assert.equal((await repairClaim690(f.db,f.options)).plan.status,'already-correct');
 assert(f.events.slice(count).every(s=>s.startsWith('SELECT')));
});

test('wrong payment/splits/identity/ambiguous target fail closed in preview',()=>{
 for(const change of [s=>s.patients[0].FName='OTHER',s=>s.payments[0].PayAmt=80,s=>s.payments[0].PayNote='different claim',s=>s.splits[1].PatNum=691,
  s=>s.splits[1].AdjNum=5,s=>s.splits[1].ProcNum=999,s=>s.procedures[1].ProcFee=75,s=>s.procedures.push({...s.procedures[1],CodeNum:103,ProcNum:99,ProcStatus:1}),
  s=>s.splits.push({...s.splits[1],SplitNum:3}),s=>s.claimprocs[0].InsPayAmt=1]){
  const f=fixture();change(f.state);assert.throws(()=>planClaim690Repair(f.state));
 }
 const f=fixture({target:true});f.state.otherSplits.push({ProcNum:13,SplitAmt:1});assert.throws(()=>planClaim690Repair(f.state),/other allocated/);
});
test('changed live state, failed hash helper and failed durable backup prevent all clinical writes',async()=>{
 for(const mode of ['changed','hash','backup']){
  const f=fixture();
  if(mode==='changed')f.onLock(()=>{f.state.patients[0].BalTotal=999;});
  if(mode==='hash')f.options.hashSplits=async()=>{throw Error('hash unavailable');};
  if(mode==='backup')f.options.writeJournal=async()=>{throw Error('disk full');};
  await assert.rejects(repairClaim690(f.db,f.options));
  assert.equal(f.events.some(s=>/^INSERT|^UPDATE/.test(s)),false);assert.equal(f.locked,false);
 }
});
test('partial MyISAM write leaves intent and blocks automatic retry',async()=>{
 const f=fixture();f.failUpdate();await assert.rejects(repairClaim690(f.db,f.options),/Partial MyISAM/);
 assert.equal(f.journal.status,'intent');assert.equal(f.state.procedures.filter(p=>p.CodeNum===103).length,1);
 assert.equal(f.state.splits[1].ProcNum,12);assert.equal(f.locked,false);
 await assert.rejects(repairClaim690(f.db,f.options),/earlier repair intent/);
 const report=inspectClaim690Repair(f.state,f.journal);
 assert.equal(report.journalStatus,'intent');assert.equal(report.paymentUnchanged,true);assert.equal(report.d0210.length,1);
 assert.equal(report.currentBalance,'509.00');assert.equal(report.intendedBalance,'509.00');
 assert.equal(report.splits.find(s=>s.Amount==='39.20').Code,'D0120');
});
