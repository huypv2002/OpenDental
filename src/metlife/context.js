// Read-only patient context. Capture every column of OD tables used to plan and
// verify a payment. No file export or DB writes.
export const contextTables=['patient','patplan','inssub','insplan','carrier','document','definition','procedurelog','procedurecode','claim','claimproc','claimpayment','payment','paysplit','adjustment','preference','provider'];
export const captureTables=[...contextTables,'clinic','securitylog','securityloghash'];
export async function readPatientContext(pool, patArg, {connection=null,forUpdate=false}={}) {
 if(!/^[1-9]\d{0,17}$/.test(String(patArg))) throw new Error('Invalid PatNum');
 const pat=String(patArg),conn=connection||await pool.getConnection();
 const execute=(sql,values)=>conn.execute({sql,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},values);
const names=captureTables;
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
  const selected=fields==='*'?[...available]:fields.split(',').filter(f=>available.has(f));
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
 t.patient=await read('patient','*','PatNum',[pat]);
 if (t.patient.length!==1) throw new Error('Patient did not resolve to exactly one row.');
 t.preference=await read('preference','PrefName,ValueString','PrefName',['ProgramVersion','DataBaseVersion','DocPath','AtoZfolderUsed','AtoZfolder','AtoZFolder','ImageStore','ClaimPaymentBatchOnly','RigorousAccounting']);
 t.definition=await read('definition','*','Category',[10,18,32]);
 t.document=await read('document','*','PatNum',[pat]);
 t.patplan=await read('patplan','*','PatNum',[pat]);
 t.inssub=await read('inssub','*','InsSubNum',t.patplan.map(r=>r.InsSubNum));
 t.subscriberpatient=await read('patient','*','PatNum',t.inssub.map(r=>r.Subscriber));
 t.insplan=await read('insplan','*','PlanNum',t.inssub.map(r=>r.PlanNum));
 t.carrier=await read('carrier','*','CarrierNum',t.insplan.map(r=>r.CarrierNum));
 t.procedurelog=await read('procedurelog','*','PatNum',[pat]);
 t.provider=await read('provider','*','ProvNum',t.procedurelog.map(r=>r.ProvNum));
 t.procedurecode=await read('procedurecode','*','CodeNum',t.procedurelog.map(r=>r.CodeNum));
 t.claim=await read('claim','*','PatNum',[pat]);
 t.claimproc=await read('claimproc','*','PatNum',[pat]);
 t.claimpayment=await read('claimpayment','*','ClaimPaymentNum',t.claimproc.map(r=>r.ClaimPaymentNum));
 t.paysplit=await read('paysplit','*','PatNum',[pat]);
 const own=await read('payment','*','PatNum',[pat]);
 const splitPayments=await read('payment','*','PayNum',t.paysplit.map(r=>r.PayNum));
 t.payment=[...new Map([...own,...splitPayments].map(r=>[String(r.PayNum),r])).values()];
 t.adjustment=await read('adjustment','*','PatNum',[pat]);
 t.clinic=await read('clinic','*','ClinicNum',[t.patient[0].ClinicNum]);
 t.securitylog=await read('securitylog','*','PatNum',[pat]);
 t.securityloghash=await read('securityloghash','*','SecurityLogNum',t.securitylog.map(r=>r.SecurityLogNum));
 if(tx){await conn.rollback();tx=false;}
 return snapshot;

} finally {if(tx) await conn.rollback().catch(()=>{});if(!connection)conn.release();}
}
