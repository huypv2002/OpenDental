import test from 'node:test';
import assert from 'node:assert/strict';
import {repairClaim690,planClaim690Repair,summarizeClaim690Splits} from './repairClaim690.js';
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture({target=false}={}){
 const state={
  patients:[{PatNum:690,FName:'MINH',LName:'BUI',BalTotal:'435.00',InsEst:10,SecDateTEdit:'2026-10-30 01:00:00'}],
  payments:[{PayNum:1202,PatNum:690,PayDate:'2025-10-15',PayAmt:'77.20',PayType:10,PayNote:'Claims #5101035732',ExternalId:'',CheckNum:'',DepositNum:4}],
  splits:[{SplitNum:1,PatNum:690,PayNum:1202,ProcNum:11,SplitAmt:'38.00',ProcDate:'2025-09-19',DatePay:'2025-10-15',ProvNum:1,ClinicNum:0,SecurityHash:'old-fixed'},
    {SplitNum:2,PatNum:690,PayNum:1202,ProcNum:12,SplitAmt:'39.20',ProcDate:'2025-09-19',DatePay:'2025-10-15',ProvNum:1,ClinicNum:0,SecurityHash:'old-moving',SecDateTEdit:'2026-10-30 01:00:00'}],
  otherSplits:[{SplitNum:5,PatNum:690,PayNum:1500,ProcNum:12,SplitAmt:10}],
  codes:[{CodeNum:101,ProcCode:'D0150'},{CodeNum:102,ProcCode:'D0120'},{CodeNum:103,ProcCode:'D0210',IsHidden:0,TreatArea:3}],
  procedures:[{ProcNum:11,PatNum:690,CodeNum:101,ProcDate:'2025-09-19',ProcStatus:2,ProcFee:'38.00',ProvNum:1,ClinicNum:0},
    {ProcNum:12,PatNum:690,CodeNum:102,ProcDate:'2025-09-19',ProcStatus:2,ProcFee:'74.00',ProvNum:1,ClinicNum:0}],
  claimprocs:[{ClaimProcNum:10,PatNum:690,ProcNum:12,InsPayAmt:0,ClaimPaymentNum:0,InsPayEst:99}],
  types:[{DefNum:10,ItemName:'Insurance paid'}],providers:[{ProvNum:1,IsHidden:0}]
 };
 if(target)state.procedures.push({ProcNum:13,PatNum:690,CodeNum:103,ProcDate:'2025-09-19',ProcStatus:2,ProcFee:'74.00',ProvNum:1,ClinicNum:0,ToothNum:'',Surf:''});
 const tables={procedurelog:state.procedures,securitylog:[],securityloghash:[]};
 const type=(name)=>/Date/.test(name)?(/Time|Sec/.test(name)?'datetime':'date'):/Fee|Amt/.test(name)?'double':/Note|Text|Hash|Name|Tooth|Surf/.test(name)?'text':'bigint';
 const columns=(table)=>{
  const names=table==='procedurelog'?['ProcNum','PatNum','CodeNum','ProcStatus','ProcDate','ProcFee','ProvNum','ClinicNum','ToothNum','Surf','UnitQty','BaseUnits','DateTP','DateComplete','SecDateEntry','SecDateTEdit','BillingNote']:
   table==='securitylog'?['SecurityLogNum','PermType','UserNum','LogText','PatNum','CompName','FKey','LogSource','DefNum','DefNumError','DateTPrevious','LogDateTime']:
   table==='securityloghash'?['SecurityLogHashNum','SecurityLogNum','LogHash']:['SplitNum','SecurityHash'];
  return names.map((COLUMN_NAME,i)=>({TABLE_NAME:table,COLUMN_NAME,DATA_TYPE:type(COLUMN_NAME),EXTRA:i===0?'auto_increment':'',IS_NULLABLE:'NO',COLUMN_DEFAULT:COLUMN_NAME==='LogDateTime'?'CURRENT_TIMESTAMP':null}));
 };
 const events=[];let locked=false,lastId=0,journal=null,mutateOnLock=null,failUpdate=false;
 const db={query:async sql=>{events.push(sql);if(sql.startsWith('LOCK TABLES')){locked=true;mutateOnLock?.();}if(sql==='UNLOCK TABLES')locked=false;return [[]];},execute:async(input,args=[])=>{
  const sql=typeof input==='string'?input:input.sql;events.push(sql);
  if(sql.startsWith('SELECT')){
   if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [clone(args[0]?columns(args[0]):['paysplit','securitylog','securityloghash'].flatMap(columns))];
   if(sql.includes('FROM preference'))return [[{PrefName:'ProgramVersion',ValueString:'24.3.88.0'},{PrefName:'DataBaseVersion',ValueString:'24.3.88.0'}]];
   if(sql.includes('LAST_INSERT_ID'))return [[{id:String(lastId)}]];
   if(sql.includes('FROM securitylog WHERE'))return [clone(tables.securitylog.filter(r=>String(r.SecurityLogNum)===String(args[0])))];
   const key=sql.includes('FROM patient WHERE')?'patients':sql.includes('FROM payment WHERE')?'payments':sql.includes('PayNum<>')?'otherSplits':sql.includes('FROM paysplit WHERE')?'splits':sql.includes('FROM procedurecode')?'codes':sql.includes('FROM procedurelog')?'procedures':sql.includes('FROM claimproc')?'claimprocs':sql.includes('FROM definition')?'types':sql.includes('FROM provider')?'providers':null;
   if(key)return [clone(state[key])];
  }
  assert(locked,'Clinical mutations must have table locks');assert(journal?.status==='intent','Durable intent must precede every mutation');
  if(sql.startsWith('INSERT INTO')){
   const table=sql.match(/INSERT INTO\s+`?(\w+)/)[1];
   const names=[...sql.slice(sql.indexOf('('),sql.indexOf(') VALUES')).matchAll(/`(\w+)`/g)].map(m=>m[1]);
   const row=Object.fromEntries(names.map((n,i)=>[n,args[i]]));lastId=table==='procedurelog'?100:table==='securitylog'?200+tables.securitylog.length:300+tables.securityloghash.length;
   const pk=table==='procedurelog'?'ProcNum':table==='securitylog'?'SecurityLogNum':'SecurityLogHashNum';row[pk]=lastId;
   if(table==='securitylog')row.LogDateTime='2026-10-30 12:00:00';tables[table].push(row);
   return [{insertId:lastId,affectedRows:1}];
  }
  if(sql.startsWith('UPDATE patient SET')){state.patients[0].BalTotal=args[0];state.patients[0].SecDateTEdit='2026-10-30 12:00:00';return [{affectedRows:1}];}
  if(sql.startsWith('UPDATE paysplit SET')){
   if(failUpdate)throw Error('simulated write failure');
   const row=state.splits.find(s=>s.SplitNum===args[2]);row.ProcNum=args[0];row.SecurityHash=args[1];row.SecDateTEdit='2026-10-30 12:00:00';return [{affectedRows:1}];
  }
  throw Error('Unexpected query '+sql);
 }};
 const options={apply:true,hashSplits:async p=>{assert.equal(p.date,'2025-10-15');assert.equal(p.splits[0].amountCents,3920);assert.equal(locked,false);return ['native-hash'];},readJournal:async()=>journal,writeJournal:async v=>{journal=clone(v);}};
 return {state,db,options,events,tables,get journal(){return journal;},onLock:f=>{mutateOnLock=f;},failUpdate:()=>{failUpdate=true;},get locked(){return locked;}};
}

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
test('hidden, missing, tooth/arch/surface treatment areas still block and show actual catalog',async()=>{
 for(const override of [{IsHidden:1},{IsHidden:null},{TreatArea:1},{TreatArea:2},{TreatArea:4},{TreatArea:6},{TreatArea:null}]){
  const f=fixture();Object.assign(f.state.codes[2],override);
  await assert.rejects(repairClaim690(f.db),e=>e.message.includes('D0210 catalog')&&e.repairCatalog.some(c=>c.ProcCode==='D0210'));
  assert(f.events.every(s=>s.startsWith('SELECT')));
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
});
