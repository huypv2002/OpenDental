// Read-only patient context, reused by the MetLife API. No file export or DB writes.
export const contextTables=['patient','patplan','inssub','insplan','carrier','document','definition','procedurelog','procedurecode','claim','claimproc','claimpayment','payment','paysplit','adjustment','preference','provider'];
export async function readPatientContext(pool, patArg, {connection=null,forUpdate=false}={}) {
 if(!/^[1-9]\d{0,17}$/.test(String(patArg))) throw new Error('Invalid PatNum');
 const pat=String(patArg),conn=connection||await pool.getConnection();
 const execute=(sql,values)=>conn.execute({sql,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},values);
const names=contextTables;
const snapshot={capturedAt:new Date().toISOString(),patNum:pat,label:'live-metlife-api',readOnly:true,schema:[],tables:{},warnings:[]};
let tx=false;
try {
 if(!connection){await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
 await conn.query('START TRANSACTION READ ONLY');tx=true;}
 const [meta]=await execute(`SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLUMN_KEY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(()=>'?').join(',')}) ORDER BY TABLE_NAME,ORDINAL_POSITION`,names);
 snapshot.schema=meta;
 const cols=new Map(names.map(n=>[n,new Set(meta.filter(m=>m.TABLE_NAME===n).map(m=>m.COLUMN_NAME))]));
 async function read(table, fields, key, values) {
  const available=cols.get(table);
  if (!available?.size) {snapshot.warnings.push(`Missing table ${table}`);return [];}
  const selected=fields.split(',').filter(f=>available.has(f));
  if (!selected.length || !available.has(key)) {snapshot.warnings.push(`Missing fields in ${table}`);return [];}
  const vals=[...new Set(values.filter(v=>v!==null && v!==undefined && String(v)!=='0').map(String))];
  if (!vals.length) return [];
  const rows=[];
  for(let i=0;i<vals.length;i+=500) {
   const chunk=vals.slice(i,i+500);
   const [part]=await execute(`SELECT ${selected.map(f=>'`'+f+'`').join(',')} FROM \`${table}\` WHERE \`${key}\` IN (${chunk.map(()=>'?').join(',')}) LIMIT 5001${forUpdate?' FOR UPDATE':''}`,chunk);
   if(part.length>5000) snapshot.warnings.push(`${table} result TRUNCATED to 5000 rows in one chunk`);
   rows.push(...part.slice(0,5000));
  }
  return rows;
 }
 const t=snapshot.tables;
 t.patient=await read('patient','PatNum,ChartNumber,FName,LName,MiddleI,Birthdate,Guarantor,PatStatus,ImageFolder,BalTotal,EstBalance,ClinicNum','PatNum',[pat]);
 if (t.patient.length!==1) throw new Error('Patient did not resolve to exactly one row.');
 t.preference=await read('preference','PrefName,ValueString','PrefName',['ProgramVersion','DataBaseVersion','DocPath','AtoZfolderUsed','AtoZfolder','AtoZFolder','ImageStore','ClaimPaymentBatchOnly','RigorousAccounting']);
 t.definition=await read('definition','DefNum,Category,ItemName,ItemOrder,IsHidden,ItemValue','Category',[10,18,32]);
 t.document=await read('document','DocNum,PatNum,DocCategory,FileName,Description,DateCreated,DateTStamp,ImgType,Note','PatNum',[pat]);
 t.patplan=await read('patplan','PatPlanNum,PatNum,InsSubNum,Ordinal,IsPending','PatNum',[pat]);
 t.inssub=await read('inssub','InsSubNum,PlanNum,Subscriber,SubscriberID','InsSubNum',t.patplan.map(r=>r.InsSubNum));
 t.subscriberpatient=await read('patient','PatNum,FName,LName,MiddleI','PatNum',t.inssub.map(r=>r.Subscriber));
 t.insplan=await read('insplan','PlanNum,CarrierNum,GroupNum,GroupName,PlanType,FeeSched,EmployerNum','PlanNum',t.inssub.map(r=>r.PlanNum));
 t.carrier=await read('carrier','CarrierNum,CarrierName,ElectID','CarrierNum',t.insplan.map(r=>r.CarrierNum));
 t.procedurelog=await read('procedurelog','ProcNum,PatNum,CodeNum,ProcDate,ProcStatus,ProcFee,ToothNum,Surf,ProvNum,ClinicNum','PatNum',[pat]);
 t.provider=await read('provider','ProvNum,Abbr,FName,LName','ProvNum',t.procedurelog.map(r=>r.ProvNum));
 t.procedurecode=await read('procedurecode','CodeNum,ProcCode,Descript,AbbrDesc','CodeNum',t.procedurelog.map(r=>r.CodeNum));
 t.claim=await read('claim','ClaimNum,PatNum,PlanNum,InsSubNum,DateService,DateSent,DateReceived,ClaimStatus,ClaimType,ClaimIdentifier,ClaimFee,InsPayEst,InsPayAmt,DedApplied,WriteOff,ClaimNote','PatNum',[pat]);
 t.claimproc=await read('claimproc','ClaimProcNum,ProcNum,ClaimNum,PatNum,PlanNum,InsSubNum,ProvNum,Status,FeeBilled,InsPayEst,InsPayAmt,DedApplied,WriteOff,ClaimPaymentNum,DateCP,ProcDate,CodeSent,Remarks','PatNum',[pat]);
 t.claimpayment=await read('claimpayment','ClaimPaymentNum,CheckDate,DateIssued,CheckAmt,CheckNum,BankBranch,CarrierName,PayType,Note,IsPartial,SecDateEntry,SecDateTEdit','ClaimPaymentNum',t.claimproc.map(r=>r.ClaimPaymentNum));
 t.paysplit=await read('paysplit','SplitNum,PayNum,PatNum,ProcNum,ProvNum,ClinicNum,SplitAmt,DatePay,DateEntry,UnearnedType,AdjNum,PayPlanNum,PayPlanChargeNum,FkcType,FkToothNum,SecurityHash','PatNum',[pat]);
 const own=await read('payment','PayNum,PatNum,PayDate,DateEntry,PayAmt,PayType,CheckNum,BankBranch,PayNote,DepositNum,SecDateTEdit','PatNum',[pat]);
 const splitPayments=await read('payment','PayNum,PatNum,PayDate,DateEntry,PayAmt,PayType,CheckNum,BankBranch,PayNote,DepositNum,SecDateTEdit','PayNum',t.paysplit.map(r=>r.PayNum));
 t.payment=[...new Map([...own,...splitPayments].map(r=>[String(r.PayNum),r])).values()];
 t.adjustment=await read('adjustment','AdjNum,PatNum,AdjDate,AdjAmt,AdjType,ProcNum,ProvNum,AdjNote','PatNum',[pat]);
 if(tx){await conn.rollback();tx=false;}
 return snapshot;

} finally {if(tx) await conn.rollback().catch(()=>{});if(!connection)conn.release();}
}
