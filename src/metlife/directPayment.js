import {readPatientContext} from './context.js';
import {validatePostingPlan,verifyPostedPayment} from './posting.js';

// Deliberately opt-in: this adapter has not been accepted against the clinic's OD
// schema. Never silently convert MyISAM tables or fall back to UI automation.
export const directWritesEnabled=()=>process.env.ENABLE_OPEN_DENTAL_WRITES==='true'&&process.env.METLIFE_DIRECT_DB_ENABLED==='true';
const journal='luk_metlife_postings';
const money=n=>(n/100).toFixed(2);
const execute=(c,sql,values=[])=>c.execute({sql,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},values);
export function paymentRows(plan,userNum,clinicNum){
 return {
  payment:{PayType:plan.paymentTypeDefNum,PayDate:plan.date,PayAmt:plan.amount,CheckNum:plan.checkNum,BankBranch:'',PayNote:plan.note,IsSplit:Number(plan.splits.length>1),PatNum:plan.patNum,ClinicNum:clinicNum,DepositNum:0,Receipt:'',IsRecurringCC:0,SecUserNumEntry:userNum,PaymentSource:0,ProcessStatus:0,RecurringChargeDate:'0001-01-01',IsCcCompleted:0,MerchantFee:'0.00'},
  splits:plan.splits.map(s=>({SplitAmt:money(s.amountCents),PatNum:plan.patNum,ProcDate:s.date,IsDiscount:0,DiscountType:0,ProvNum:s.ProvNum,PayPlanNum:0,DatePay:plan.date,ProcNum:s.ProcNum,UnearnedType:0,ClinicNum:s.ClinicNum,SecUserNumEntry:userNum,FSplitNum:0,AdjNum:0,PayPlanChargeNum:0,PayPlanDebitType:0}))
 };
}
export async function insertFinancialRow(conn,table,row,columns){
 const available=new Map(columns.map(c=>[c.COLUMN_NAME,c]));
 const primary=table==='payment'?'PayNum':'SplitNum';
 if(!available.get(primary)?.EXTRA?.includes('auto_increment'))throw new Error(`${table}: cần khóa AUTO_INCREMENT; không hỗ trợ replication/random keys.`);
 const required=table==='payment'?['PayType','PayDate','PayAmt','CheckNum','PayNote','PatNum','ClinicNum','SecUserNumEntry']:['SplitAmt','PatNum','PayNum','ProvNum','DatePay','ProcNum','UnearnedType','ClinicNum','SecUserNumEntry'];
 if(required.some(k=>!available.has(k)||row[k]===undefined))throw new Error(`${table}: schema thiếu trường bắt buộc.`);
 const entries=Object.entries(row).filter(([k])=>available.has(k));
 const supplied=new Set([...entries.map(([k])=>k),'DateEntry']);
 for(const c of columns){
  if(c.COLUMN_NAME===primary||c.EXTRA?.includes('GENERATED')||c.EXTRA?.includes('auto_increment')||supplied.has(c.COLUMN_NAME))continue;
  if(c.IS_NULLABLE==='NO'&&c.COLUMN_DEFAULT===null)throw new Error(`${table}: chưa hỗ trợ trường bắt buộc ${c.COLUMN_NAME}.`);
 }
 if(!available.has('DateEntry'))throw new Error(`${table}: thiếu DateEntry.`);
 await execute(conn,`INSERT INTO \`${table}\` (${entries.map(([k])=>'`'+k+'`').join(',')},DateEntry) VALUES (${entries.map(()=>'?').join(',')},CURDATE())`,entries.map(([,v])=>v));
 const [ids]=await execute(conn,'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
 if(!/^[1-9]\d*$/.test(ids[0]?.id))throw new Error('Không đọc được khóa bản ghi vừa tạo.');
 return ids[0].id;
}
export function createDirectPaymentWriter(pool,{enabled=directWritesEnabled,userNum=()=>process.env.METLIFE_OD_USER_NUM||'',readContext=readPatientContext}={}){
 let setup;
 async function ensureJournal(){
  if(!setup)setup=pool.query(`CREATE TABLE IF NOT EXISTS ${journal} (OperationId CHAR(36) NOT NULL PRIMARY KEY,PatNum BIGINT NOT NULL,DocNum BIGINT NOT NULL,PdfHash CHAR(64) NOT NULL,PayNum BIGINT NOT NULL,PlanJson LONGTEXT NOT NULL,CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY uq_patient_pdf (PatNum,PdfHash)) ENGINE=InnoDB`).catch(e=>{setup=null;throw e;});
  await setup;
 }
 return async function post({id,patNum,docNum,plan:approved,before}){
  if(!enabled())throw Object.assign(new Error('Ghi DB MetLife chưa bật trên SERVER. Cần kiểm chứng trên DB clone trước khi bật METLIFE_DIRECT_DB_ENABLED.'),{noWrite:true});
  if(!/^[1-9]\d{0,17}$/.test(String(userNum())))throw Object.assign(new Error('Cần METLIFE_OD_USER_NUM của tài khoản OD dùng cho tích hợp.'),{noWrite:true});
  try{await ensureJournal();}catch(e){e.noWrite=true;throw e;}
  const conn=await pool.getConnection();let started=false,commitAttempted=false;
  try{
   // All observed financial rows must participate in the same transaction.
   const tables=['patient','definition','procedurelog','procedurecode','provider','payment','paysplit','claimproc','claimpayment','preference','userod',journal];
   const [engines]=await execute(conn,`SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(()=>'?').join(',')})`,tables);
   if(tables.some(t=>engines.find(e=>e.TABLE_NAME===t)?.ENGINE?.toUpperCase()!=='INNODB'))throw new Error('Ghi DB cần InnoDB cho các bảng liên quan. SERVER không tự đổi engine; chưa hỗ trợ MyISAM.');
   await conn.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');await conn.beginTransaction();started=true;
   const [old]=await execute(conn,`SELECT CAST(PayNum AS CHAR) AS PayNum,PlanJson FROM ${journal} WHERE OperationId=? FOR UPDATE`,[id]);
   if(old.length){
    if(old[0].PlanJson!==JSON.stringify(approved))throw new Error('Operation không khớp kế hoạch đã lưu.');
    await conn.rollback();started=false;return {payNum:old[0].PayNum,replayed:true};
   }
   const [users]=await execute(conn,'SELECT UserNum FROM userod WHERE UserNum=? AND IsHidden=0 FOR UPDATE',[String(userNum())]);
   if(users.length!==1)throw new Error('Tài khoản OD tích hợp không tồn tại hoặc đã ẩn.');
   const [prefs]=await execute(conn,"SELECT PrefName,ValueString FROM preference WHERE PrefName IN ('RandomPrimaryKeys','AccountingSoftware','AccountingAutomaticPaymentEntry','AllowFuturePayments','DateLock','DateLockLimitDays') FOR UPDATE");
   if(prefs.some(p=>['RandomPrimaryKeys','AccountingAutomaticPaymentEntry'].includes(p.PrefName)&&!['','0','false'].includes(String(p.ValueString).toLowerCase())))throw new Error('Chưa hỗ trợ random keys hoặc đồng bộ kế toán tự động.');
   // Date locks/accounting integrations require OD business logic, not SQL.
   if(prefs.some(p=>['DateLock','DateLockLimitDays','AccountingSoftware'].includes(p.PrefName)&&!['','0','false','0001-01-01','0000-00-00'].includes(String(p.ValueString).toLowerCase())))throw new Error('Chưa hỗ trợ khóa ngày hoặc tích hợp kế toán trên đường ghi DB.');
   const [[today]]=await execute(conn,"SELECT DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS today");
   if(approved.date>today.today&&!prefs.some(p=>p.PrefName==='AllowFuturePayments'&&['1','true'].includes(String(p.ValueString).toLowerCase())))throw new Error('Ngày Payment ở tương lai chưa được OD cho phép.');
   const context=await readContext(pool,patNum,{connection:conn,forUpdate:true});
   const plan=validatePostingPlan(context,approved);
   const financial=s=>JSON.stringify({payment:s.tables.payment,paysplit:s.tables.paysplit,claimpayment:s.tables.claimpayment,claimproc:s.tables.claimproc});
   if(financial(context)!==financial(before))throw new Error('Dữ liệu tài chính đã đổi sau khi đối chiếu; tải lại hồ sơ.');
   const [columns]=await execute(conn,"SELECT TABLE_NAME,COLUMN_NAME,COLUMN_DEFAULT,IS_NULLABLE,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('payment','paysplit')");
   const rows=paymentRows(plan,String(userNum()),String(context.tables.patient[0].ClinicNum||0));
   const payNum=await insertFinancialRow(conn,'payment',rows.payment,columns.filter(c=>c.TABLE_NAME==='payment'));
   for(const row of rows.splits)await insertFinancialRow(conn,'paysplit',{...row,PayNum:payNum},columns.filter(c=>c.TABLE_NAME==='paysplit'));
   const after=await readContext(pool,patNum,{connection:conn,forUpdate:true});
   const result=verifyPostedPayment(before,after,plan);
   if(!result.verified||result.payNum!==payNum)throw new Error('Payment/Splits vừa ghi không khớp kế hoạch; rollback.');
   // Durable idempotency and integration audit are committed with the payment.
   // This is not an Open Dental securitylog entry and must not be presented as one.
   await execute(conn,`INSERT INTO ${journal} (OperationId,PatNum,DocNum,PdfHash,PayNum,PlanJson) VALUES (?,?,?,?,?,?)`,[id,patNum,docNum,plan.sha256,payNum,JSON.stringify(approved)]);
   commitAttempted=true;await conn.commit();started=false;
   return {payNum,splitNums:result.splitNums};
  }catch(e){
   let rolledBack=!started;
   if(started){try{await conn.rollback();rolledBack=true;}catch{conn.destroy();}}
   // A transport failure during COMMIT is uncertain; never release/retry it.
   if(!commitAttempted&&rolledBack)e.noWrite=true;
   throw e;
  }finally{conn.release();}
 };
}
