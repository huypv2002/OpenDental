import assert from 'node:assert/strict';
const clone=v=>JSON.parse(JSON.stringify(v));
export function fixture({target=false}={}){
 const state={
  patients:[{PatNum:690,FName:'MINH',LName:'BUI',BalTotal:'435.00',InsEst:10,SecDateTEdit:'2026-10-30 01:00:00'}],
  payments:[{PayNum:1202,PatNum:690,PayDate:'2025-10-15',PayAmt:'77.20',PayType:10,PayNote:'Claims #5101035732',ExternalId:'',CheckNum:'',DepositNum:4}],
  splits:[{SplitNum:1,PatNum:690,PayNum:1202,ProcNum:11,SplitAmt:'38.00',ProcDate:'2025-09-19',DatePay:'2025-10-15',ProvNum:1,ClinicNum:0,SecurityHash:'old-fixed'},
    {SplitNum:2,PatNum:690,PayNum:1202,ProcNum:12,SplitAmt:'39.20',ProcDate:'2025-09-19',DatePay:'2025-10-15',ProvNum:1,ClinicNum:0,SecurityHash:'old-moving',SecDateTEdit:'2026-10-30 01:00:00'}],
  otherSplits:[{SplitNum:5,PatNum:690,PayNum:1500,ProcNum:12,SplitAmt:10}],
  codes:[{CodeNum:101,ProcCode:'D0150',ProcCat:11},{CodeNum:102,ProcCode:'D0120',ProcCat:11},{CodeNum:103,ProcCode:'D0210',ProcCat:11,TreatArea:3}],
  codeCategories:[{DefNum:11,ItemName:'Diagnostic',IsHidden:0}],
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
   if(sql.includes('AS RepairAuditTime'))return [[{RepairAuditTime:'2026-10-30 12:00:00'}]];
   if(sql.includes('LAST_INSERT_ID'))return [[{id:String(lastId)}]];
   if(sql.includes('FROM securitylog WHERE'))return [clone(tables.securitylog.filter(r=>sql.includes('LogText IN')?String(r.PatNum)===String(args[0])&&args.slice(1).includes(r.LogText):String(r.SecurityLogNum)===String(args[0])).map(r=>({...r,HashLogDateTime:r.LogDateTime,HashDateTPrevious:r.DateTPrevious})))];
   if(sql.includes('FROM securityloghash WHERE'))return [clone(tables.securityloghash.filter(r=>String(r.SecurityLogNum)===String(args[0])))];
   const key=sql.includes('FROM patient WHERE')?'patients':sql.includes('FROM payment WHERE')?'payments':sql.includes('PayNum<>')?'otherSplits':sql.includes('FROM paysplit WHERE')?'splits':sql.includes('FROM procedurecode')?'codes':sql.includes('FROM procedurelog')?'procedures':sql.includes('FROM claimproc')?'claimprocs':sql.includes('FROM definition WHERE Category=11')?'codeCategories':sql.includes('FROM definition')?'types':sql.includes('FROM provider')?'providers':null;
   if(key)return [clone(state[key])];
  }
  assert(locked,'Clinical mutations must have table locks');assert(journal?.status==='intent','Durable intent must precede every mutation');
  if(sql.startsWith('UPDATE securitylog SET')){
   const row=tables.securitylog.find(r=>String(r.SecurityLogNum)===String(args[1])&&r.PatNum===args[2]&&r.LogDateTime===args[3]);
   if(!row)return [{affectedRows:0}];row.LogDateTime=args[0];return [{affectedRows:1}];
  }
  if(sql.startsWith('INSERT INTO')){
   const table=sql.match(/INSERT INTO\s+`?(\w+)/)[1];
   const names=[...sql.slice(sql.indexOf('('),sql.indexOf(') VALUES')).matchAll(/`(\w+)`/g)].map(m=>m[1]);
   const row=Object.fromEntries(names.map((n,i)=>[n,args[i]]));lastId=table==='procedurelog'?100:table==='securitylog'?200+tables.securitylog.length:300+tables.securityloghash.length;
   const pk=table==='procedurelog'?'ProcNum':table==='securitylog'?'SecurityLogNum':'SecurityLogHashNum';row[pk]=lastId;
   if(table==='securitylog')assert.equal(row.LogDateTime,'2026-10-30 12:00:00','audit timestamp must be explicitly supplied, not inherited from a DB default');tables[table].push(row);
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
 return {state,db,options,events,tables,get journal(){return journal;},setJournal:value=>{journal=clone(value);},onLock:f=>{mutateOnLock=f;},failUpdate:()=>{failUpdate=true;},get locked(){return locked;}};
}
