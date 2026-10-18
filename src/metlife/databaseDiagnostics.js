import {directWritesEnabled,paymentRows} from './directPayment.js';

export const postingTables=['patient','definition','procedurelog','procedurecode','provider','payment','paysplit','claimproc','claimpayment','preference'];
export const postingPreferences=['ProgramVersion','DataBaseVersion','RandomPrimaryKeys','AccountingSoftware','AccountingAutomaticPaymentEntry','AllowFuturePayments','DateLock','DateLockLimitDays'];
// Metadata only: no patient/payment rows, passwords, tokens or connection strings.
export async function databaseDiagnostics(pool,{enabled=directWritesEnabled}={}){
 const [tables]=await pool.execute(`SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${postingTables.map(()=>'?').join(',')})`,postingTables);
 const [columns]=await pool.execute("SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLUMN_DEFAULT,IS_NULLABLE,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('payment','paysplit') ORDER BY TABLE_NAME,ORDINAL_POSITION");
 const [preferences]=await pool.execute(`SELECT PrefName,ValueString FROM preference WHERE PrefName IN (${postingPreferences.map(()=>'?').join(',')})`,postingPreferences);
 const schemaProblems=[];
 for(const table of postingTables){const meta=tables.find(t=>t.TABLE_NAME===table);if(!meta)schemaProblems.push(`Thiếu bảng ${table}.`);else if(meta.ENGINE?.toUpperCase()!=='INNODB')schemaProblems.push(`${table} dùng ${meta.ENGINE}; adapter hiện cần InnoDB.`);}
 const sample=paymentRows({splits:[{date:'2000-01-01',amountCents:1}],patNum:'1'},'1','0');
 for(const table of ['payment','paysplit']){
  const selected=columns.filter(c=>c.TABLE_NAME===table),names=new Set(selected.map(c=>c.COLUMN_NAME)),pk=table==='payment'?'PayNum':'SplitNum';
  if(!selected.find(c=>c.COLUMN_NAME===pk)?.EXTRA?.includes('auto_increment'))schemaProblems.push(`${table}.${pk} cần AUTO_INCREMENT.`);
  const expected=table==='payment'?['PayType','PayDate','PayAmt','CheckNum','PayNote','PatNum','ClinicNum','SecUserNumEntry','DateEntry']:['SplitAmt','PatNum','PayNum','ProvNum','DatePay','ProcNum','UnearnedType','ClinicNum','SecUserNumEntry','DateEntry'];
  for(const field of expected)if(!names.has(field))schemaProblems.push(`Thiếu ${table}.${field}.`);
  const supplied=new Set([...Object.keys(table==='payment'?sample.payment:sample.splits[0]),'PayNum','DateEntry']);
  for(const col of selected)if(col.COLUMN_NAME!==pk&&!supplied.has(col.COLUMN_NAME)&&col.IS_NULLABLE==='NO'&&col.COLUMN_DEFAULT===null&&!/GENERATED|auto_increment/.test(col.EXTRA||''))schemaProblems.push(`Chưa hỗ trợ trường bắt buộc ${table}.${col.COLUMN_NAME}.`);
 }
 for(const p of preferences){
  if(['RandomPrimaryKeys','AccountingAutomaticPaymentEntry','DateLock','DateLockLimitDays','AccountingSoftware'].includes(p.PrefName)&&!['','0','false','0001-01-01','0000-00-00'].includes(String(p.ValueString).toLowerCase()))schemaProblems.push(`Cấu hình ${p.PrefName} chưa được adapter hỗ trợ.`);
 }
 const configurationProblems=[];
 if(!enabled())configurationProblems.push('Chưa bật ENABLE_OPEN_DENTAL_WRITES và METLIFE_DIRECT_DB_ENABLED trên SERVER.');
 return {capturedAt:new Date().toISOString(),readOnly:true,schemaCompatible:!schemaProblems.length,writeConfigured:!configurationProblems.length,ready:!schemaProblems.length&&!configurationProblems.length,tables,columns,preferences,schemaProblems,configurationProblems,limitations:['Payment/Splits theo quy trình Insurance Paid; không đổi claim/claimproc.','Nhật ký tích hợp riêng; không tự sinh OD Audit Trail hoặc tính lại aging/balance.','Cần nghiệm thu Account/báo cáo/số dư trên clone trước khi dùng dữ liệu thật.']};
}
