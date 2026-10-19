import {directWritesEnabled,paymentRows,writeTables} from './directPayment.js';
import {nativeSplitHashes} from './nativeSplitHashes.js';

export const postingTables=['patient','definition','procedurelog','procedurecode','provider','payment','paysplit','claimproc','claimpayment','preference','securitylog','securityloghash'];
export const postingPreferences=['ProgramVersion','DataBaseVersion','RandomPrimaryKeys','AccountingSoftware','AccountingAutomaticPaymentEntry','AllowFuturePayments','DateLock','DateLockLimitDays'];
// Metadata only: no patient/payment rows, passwords, tokens or connection strings.
export async function databaseDiagnostics(pool,{enabled=directWritesEnabled,hashSplits=nativeSplitHashes}={}){
 const [tables]=await pool.execute(`SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${postingTables.map(()=>'?').join(',')})`,postingTables);
 const [columns]=await pool.execute(`SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLUMN_DEFAULT,IS_NULLABLE,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${writeTables.map(()=>'?').join(',')}) ORDER BY TABLE_NAME,ORDINAL_POSITION`,writeTables);
 const [preferences]=await pool.execute(`SELECT PrefName,ValueString FROM preference WHERE PrefName IN (${postingPreferences.map(()=>'?').join(',')})`,postingPreferences);
 const schemaProblems=[];
 const myisam=tables.some(t=>t.ENGINE?.toUpperCase()==='MYISAM');
 for(const table of postingTables){const meta=tables.find(t=>t.TABLE_NAME===table);if(!meta)schemaProblems.push(`Thiếu bảng ${table}.`);else if(!['INNODB','MYISAM'].includes(meta.ENGINE?.toUpperCase()))schemaProblems.push(`${table} dùng ${meta.ENGINE}; engine chưa hỗ trợ.`);}
 if(myisam&&['ProgramVersion','DataBaseVersion'].some(n=>!/^24\.3\.\d+\.\d+$/.test(preferences.find(p=>p.PrefName===n)?.ValueString||'')))schemaProblems.push('MyISAM adapter cần phiên bản OD/DB 24.3.');
 const needsHash=columns.some(c=>c.TABLE_NAME==='paysplit'&&c.COLUMN_NAME==='SecurityHash');
 if(myisam&&!needsHash)schemaProblems.push('MyISAM adapter cần schema OD 24.3 có SecurityHash.');
 const sample=paymentRows({splits:[{date:'2000-01-01',amountCents:1}],patNum:'1'},'1','0');
 const expected={payment:['PayType','PayDate','PayAmt','CheckNum','PayNote','PatNum','ClinicNum','SecUserNumEntry','DateEntry'],paysplit:['SplitAmt','PatNum','PayNum','ProvNum','DatePay','ProcNum','UnearnedType','ClinicNum','SecUserNumEntry','DateEntry'],securitylog:['PermType','UserNum','LogText','PatNum'],securityloghash:['SecurityLogNum','LogHash']};
 const extras={payment:['PayNum'],paysplit:['PayNum','SplitNum','SecurityHash'],securitylog:['SecurityLogNum','LogDateTime','CompName','FKey','LogSource','DefNum','DefNumError','DateTPrevious'],securityloghash:['SecurityLogHashNum']};
 for(const table of writeTables){
  const selected=columns.filter(c=>c.TABLE_NAME===table),names=new Set(selected.map(c=>c.COLUMN_NAME)),pk={payment:'PayNum',paysplit:'SplitNum',securitylog:'SecurityLogNum',securityloghash:'SecurityLogHashNum'}[table];
  if(!selected.find(c=>c.COLUMN_NAME===pk)?.EXTRA?.includes('auto_increment'))schemaProblems.push(`${table}.${pk} cần AUTO_INCREMENT.`);
  for(const field of expected[table]||[])if(!names.has(field))schemaProblems.push(`Thiếu ${table}.${field}.`);
  const supplied=new Set([...Object.keys(table==='payment'?sample.payment:table==='paysplit'?sample.splits[0]:{}),...(extras[table]||[]),...(['securitylog','securityloghash'].includes(table)?expected[table]:[]),'DateEntry']);
  for(const col of selected)if(col.COLUMN_NAME!==pk&&!supplied.has(col.COLUMN_NAME)&&col.IS_NULLABLE==='NO'&&col.COLUMN_DEFAULT===null&&!/GENERATED|auto_increment/.test(col.EXTRA||''))schemaProblems.push(`Chưa hỗ trợ trường bắt buộc ${table}.${col.COLUMN_NAME}.`);
 }
 for(const p of preferences){
  if(['RandomPrimaryKeys','AccountingAutomaticPaymentEntry','DateLock','DateLockLimitDays','AccountingSoftware'].includes(p.PrefName)&&!['','0','false','0001-01-01','0000-00-00'].includes(String(p.ValueString).toLowerCase()))schemaProblems.push(`Cấu hình ${p.PrefName} chưa được adapter hỗ trợ.`);
 }
 const configurationProblems=[];
 if(!enabled())configurationProblems.push('Chưa bật ENABLE_OPEN_DENTAL_WRITES và METLIFE_DIRECT_DB_ENABLED trên SERVER.');
 if(needsHash){try{await hashSplits({patNum:'1',date:'2000-01-01',splits:[{amountCents:1}]});}catch(e){configurationProblems.push(e.message);}}
 return {capturedAt:new Date().toISOString(),readOnly:true,storage:myisam?'myisam-locks':'innodb-transaction',schemaCompatible:!schemaProblems.length,writeConfigured:!configurationProblems.length,ready:!schemaProblems.length&&!configurationProblems.length,tables,columns,preferences,schemaProblems,configurationProblems,limitations:['Payment/Splits theo quy trình Insurance Paid; không đổi claim/claimproc.','Ghi securitylog PaymentCreate và securityloghash SHA-256 theo OD; không tính lại aging/balance.',...(myisam?['MyISAM không rollback: ngắt giữa lúc ghi có thể để lại Payment/Splits chưa đủ; giữ khóa và cần kiểm tra nội bộ, không tự ghi lại.']:[]),'Cần nghiệm thu Account/báo cáo/số dư trên clone trước khi dùng dữ liệu thật.']};
}
