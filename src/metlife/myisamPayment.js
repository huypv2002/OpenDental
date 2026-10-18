import {contextTables,readPatientContext} from './context.js';
import {validatePostingPlan,verifyPostedPayment} from './posting.js';
import {paymentRows,financialInsert} from './directPayment.js';
import {nativeSplitHashes} from './nativeSplitHashes.js';
export const myisamJournal='luk_metlife_myisam_jobs';
const execute=(conn,sql,args=[])=>conn.execute({sql,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},args);
const financial=s=>JSON.stringify({payment:s.tables.payment,paysplit:s.tables.paysplit,claimpayment:s.tables.claimpayment,claimproc:s.tables.claimproc});
export function verifyMyisamIntent(after,intent){
 const result=verifyPostedPayment(intent.before,after,intent.plan);
 if(!result.verified||result.payNum!==intent.payment.PayNum)return {verified:false};
 for(const split of intent.splits){
  const row=after.tables.paysplit.find(s=>String(s.SplitNum)===split.SplitNum&&String(s.PayNum)===intent.payment.PayNum);
  if(!row||String(row.ProcNum)!==String(split.ProcNum)||row.SecurityHash!==split.SecurityHash)return {verified:false};
 }
 return result;
}
export function createMyisamWriter(pool,{readContext=readPatientContext,hashSplits=nativeSplitHashes}={}){
 return async(op,entryUser,conn)=>{
  let locked=false,mayHaveWritten=false;
  try{
   const [meta]=await execute(conn,`SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${contextTables.map(()=>'?').join(',')})`,contextTables);
   if(contextTables.some(t=>!['MYISAM','INNODB'].includes(meta.find(m=>m.TABLE_NAME===t)?.ENGINE?.toUpperCase())))throw new Error('MyISAM adapter thiếu bảng hoặc gặp engine chưa hỗ trợ.');
   const [columns]=await execute(conn,"SELECT TABLE_NAME,COLUMN_NAME,COLUMN_DEFAULT,IS_NULLABLE,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('payment','paysplit')");
   if(!columns.some(c=>c.TABLE_NAME==='paysplit'&&c.COLUMN_NAME==='SecurityHash'))throw new Error('MyISAM adapter cần schema OD 24.3 có SecurityHash.');
   const [versions]=await execute(conn,"SELECT PrefName,ValueString FROM preference WHERE PrefName IN ('ProgramVersion','DataBaseVersion')");
   if(['ProgramVersion','DataBaseVersion'].some(n=>!/^24\.3\.\d+\.\d+$/.test(versions.find(v=>v.PrefName===n)?.ValueString||'')))throw new Error('MyISAM adapter chỉ hỗ trợ phiên bản OD/DB 24.3 đã đối chiếu.');
   // Native hashing happens before taking table locks: never hold clinic-wide locks
   // while launching PowerShell or loading OD/CDT assemblies.
   const hashes=await hashSplits(op.plan);
   if(!Array.isArray(hashes)||hashes.length!==op.plan.splits.length||hashes.some(h=>typeof h!=='string'||h.length<16||/Exception$|\s/.test(h)))throw new Error('OD không trả đủ hash cho các Split mới.');
   await conn.query(`CREATE TABLE IF NOT EXISTS ${myisamJournal} (OperationId CHAR(36) PRIMARY KEY,PatNum BIGINT NOT NULL,DocNum BIGINT NOT NULL,PdfHash CHAR(64) NOT NULL,PayNum BIGINT NOT NULL,State VARCHAR(32) NOT NULL,IntentJson LONGTEXT NOT NULL,CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY uq_patient_pdf (PatNum,PdfHash)) ENGINE=InnoDB`);
   // SQL table locks protect writes by OD itself as well as other Bridge processes.
   // A short lock wait fails before clinical mutations; session state is restored.
   await conn.query('SET SESSION lock_wait_timeout=5');
   await conn.query('SET SESSION autocommit=1');
   const lockedTables=[...contextTables,...(entryUser==='0'?[]:['userod']),myisamJournal];
   await conn.query('LOCK TABLES '+lockedTables.map(t=>'`'+t+'` '+(['payment','paysplit',myisamJournal].includes(t)?'WRITE':'READ')).join(','));locked=true;
   const [existing]=await execute(conn,`SELECT OperationId,State,IntentJson FROM ${myisamJournal} WHERE OperationId=? OR (PatNum=? AND PdfHash=?)`,[op.id,op.patNum,op.plan.sha256]);
   if(existing.length){
    const old=existing.find(r=>r.OperationId===op.id);
    if(!old)throw new Error('PDF đã có lượt ghi MyISAM; cần xác minh lượt trước.');
    const intent=JSON.parse(old.IntentJson);
    if(JSON.stringify(intent.plan)!==JSON.stringify(op.plan))throw new Error('Operation không khớp kế hoạch đã lưu.');
    // Restart/replay never creates any clinical rows. Only an exact complete intent
    // can be recovered, including interruption after last split before journal update.
    mayHaveWritten=true;
    const result=verifyMyisamIntent(await readContext(pool,op.patNum,{connection:conn}),intent);
    if(!result.verified)throw new Error('Lượt MyISAM chưa đủ Payment/Splits; giữ khóa và cần kỹ thuật viên kiểm tra, không tự ghi lại.');
    await execute(conn,`UPDATE ${myisamJournal} SET State='complete' WHERE OperationId=?`,[op.id]);
    return {payNum:result.payNum,splitNums:result.splitNums,replayed:true};
   }
   const [prefs]=await execute(conn,"SELECT PrefName,ValueString FROM preference WHERE PrefName IN ('RandomPrimaryKeys','AccountingSoftware','AccountingAutomaticPaymentEntry','AllowFuturePayments','DateLock','DateLockLimitDays')");
   if(prefs.some(p=>['RandomPrimaryKeys','AccountingSoftware','AccountingAutomaticPaymentEntry','DateLock','DateLockLimitDays'].includes(p.PrefName)&&!['','0','false','0001-01-01','0000-00-00'].includes(String(p.ValueString).toLowerCase())))throw new Error('MyISAM: chưa hỗ trợ random keys, khóa ngày hoặc đồng bộ kế toán đang bật.');
   const [[today]]=await execute(conn,"SELECT DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS today");
   if(op.plan.date>today.today&&!prefs.some(p=>p.PrefName==='AllowFuturePayments'&&['1','true'].includes(String(p.ValueString).toLowerCase())))throw new Error('Ngày Payment ở tương lai chưa được OD cho phép.');
   if(entryUser!=='0'){const [users]=await execute(conn,'SELECT UserNum FROM userod WHERE UserNum=? AND IsHidden=0',[entryUser]);if(users.length!==1)throw new Error('Tài khoản OD tích hợp không hợp lệ.');}
   const fresh=await readContext(pool,op.patNum,{connection:conn});
   const plan=validatePostingPlan(fresh,op.plan);
   if(financial(fresh)!==financial(op.before))throw new Error('Dữ liệu tài chính đã đổi; tải lại để đối chiếu.');
   const rows=paymentRows(plan,entryUser,String(fresh.tables.patient[0].ClinicNum||0));
   // Reserve exact future identities while exclusive SQL locks are held. Durable
   // intent is persisted before INSERT, so a lost insert response cannot lose IDs.
   async function nextId(table,pk){
    const [[max]]=await execute(conn,`SELECT CAST(COALESCE(MAX(\`${pk}\`),0)+1 AS CHAR) AS id FROM \`${table}\``);
    const [[counter]]=await execute(conn,'SELECT CAST(AUTO_INCREMENT AS CHAR) AS id FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table]);
    return String(BigInt(max.id)>BigInt(counter?.id||'1')?BigInt(max.id):BigInt(counter?.id||'1'));
   }
   const payNum=await nextId('payment','PayNum'),firstSplit=BigInt(await nextId('paysplit','SplitNum'));
   rows.payment.PayNum=payNum;
   rows.splits.forEach((row,i)=>{row.PayNum=payNum;row.SplitNum=String(firstSplit+BigInt(i));row.SecurityHash=hashes[i];});
   const paymentStatement=financialInsert('payment',rows.payment,columns.filter(c=>c.TABLE_NAME==='payment'));
   const splitStatements=rows.splits.map(row=>financialInsert('paysplit',row,columns.filter(c=>c.TABLE_NAME==='paysplit')));
   const intent={plan,before:op.before,payment:rows.payment,splits:rows.splits};
   await execute(conn,`INSERT INTO ${myisamJournal} (OperationId,PatNum,DocNum,PdfHash,PayNum,State,IntentJson) VALUES (?,?,?,?,?,'intent',?)`,[op.id,op.patNum,op.docNum,plan.sha256,payNum,JSON.stringify(intent)]);
   mayHaveWritten=true;
   await execute(conn,paymentStatement.sql,paymentStatement.values);
   for(const statement of splitStatements)await execute(conn,statement.sql,statement.values);
   const after=await readContext(pool,op.patNum,{connection:conn});
   const result=verifyMyisamIntent(after,intent);
   if(!result.verified)throw new Error('MyISAM readback không khớp; giữ khóa để kiểm tra, không ghi lại.');
   await execute(conn,`UPDATE ${myisamJournal} SET State='complete' WHERE OperationId=?`,[op.id]);
   return {payNum,splitNums:result.splitNums,storage:'myisam'};
  }catch(e){
   // MyISAM rollback does not undo an INSERT. Never call it, delete financial rows,
   // mark a possible partial write as no-change, or automatically resume inserts.
   if(!mayHaveWritten)e.noWrite=true;
   throw e;
  }finally{
   let reusable=true;
   if(locked){try{await conn.query('UNLOCK TABLES');}catch{reusable=false;conn.destroy();}}
   if(reusable)try{await conn.query('SET SESSION lock_wait_timeout=DEFAULT');}catch{conn.destroy();}
  }
 };
}

export async function myisamReceipt(pool,id){
 let rows;
 try{[rows]=await pool.execute(`SELECT State,PayNum,IntentJson FROM ${myisamJournal} WHERE OperationId=?`,[id]);}
 catch(e){if(e.code==='ER_NO_SUCH_TABLE')return null;throw e;}
 if(!rows.length)return null;
 const intent=JSON.parse(rows[0].IntentJson),after=await readPatientContext(pool,intent.plan.patNum);
 const result=verifyMyisamIntent(after,intent);
 if(!result.verified)return null;
 return {payNum:String(rows[0].PayNum),storage:'myisam'};
}
