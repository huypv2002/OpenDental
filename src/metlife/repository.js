import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPatientContext} from './context.js';
import {createDirectPaymentWriter,directWritesEnabled} from './directPayment.js';
import {databaseDiagnostics} from './databaseDiagnostics.js';
export const validId=s=>/^[1-9]\d{0,17}$/.test(String(s??''));
const like=s=>`%${s.replace(/[\\%_]/g,m=>'\\'+m)}%`;
const categories=['FINISHED CLAM','FINISHED CLAIMS'];
export function searchSql(query={}) {
 const q=String(query.q||'').trim();const kind=String(query.kind||'all');
 if(!q||q.length>100||!['all','name','patientId','subscriberId','groupNumber'].includes(kind))throw new Error('Nhập từ khóa tìm kiếm hợp lệ, tối đa 100 ký tự.');
 const page=Math.min(Math.max(Number.parseInt(query.page||'0',10)||0,0),10000),limit=30;
 const term=like(q),clauses=[],values=[];
 if(kind==='name'||kind==='all'){clauses.push("(p.FName LIKE ? OR p.LName LIKE ? OR CONCAT_WS(' ',p.FName,p.LName) LIKE ? OR CONCAT_WS(' ',p.LName,p.FName) LIKE ?)");values.push(term,term,term,term);}
 if(kind==='patientId'||kind==='all'){clauses.push('(CAST(p.PatNum AS CHAR) = ? OR p.ChartNumber = ?)');values.push(q,q);}
 const insurance=[];
 if(kind==='subscriberId'||kind==='all'){insurance.push('s.SubscriberID LIKE ?');values.push(term);}
 if(kind==='groupNumber'||kind==='all'){insurance.push('ip.GroupNum LIKE ?');values.push(term);}
 if(insurance.length)clauses.push(`EXISTS (SELECT 1 FROM patplan pp JOIN inssub s ON s.InsSubNum=pp.InsSubNum JOIN insplan ip ON ip.PlanNum=s.PlanNum WHERE pp.PatNum=p.PatNum AND (${insurance.join(' OR ')}))`);
 return {sql:`SELECT CAST(p.PatNum AS CHAR) AS PatNum,p.ChartNumber,p.FName,p.LName,DATE_FORMAT(p.Birthdate,'%Y-%m-%d') AS Birthdate FROM patient p WHERE ${clauses.join(' OR ')} ORDER BY p.LName,p.FName,p.PatNum LIMIT ? OFFSET ?`,values:[...values,limit+1,page*limit],page,limit};
}
export function createRepository(pool){return {
 diagnostics:()=>databaseDiagnostics(pool),
 postDirect:createDirectPaymentWriter(pool),
 async directReceipt(id){
  try{const [rows]=await pool.execute('SELECT CAST(PayNum AS CHAR) AS payNum FROM luk_metlife_postings WHERE OperationId=?',[id]);return rows[0]||null;}
  catch(e){if(e.code==='ER_NO_SUCH_TABLE')return null;throw e;}
 },
 async health(){await pool.execute('SELECT 1 AS ok');return {db:true,version:2,features:['patient-search','finished-claims','pdf','live-context','direct-payment'],readOnly:!directWritesEnabled(),directPaymentEnabled:directWritesEnabled()};},
 async search(query){
  const stmt=searchSql(query);const [all]=await pool.execute(stmt.sql,stmt.values);const rows=all.slice(0,stmt.limit);
  if(rows.length){const ids=rows.map(r=>r.PatNum);const [plans]=await pool.execute(`SELECT CAST(pp.PatNum AS CHAR) AS PatNum,s.SubscriberID,ip.GroupNum,c.CarrierName FROM patplan pp JOIN inssub s ON s.InsSubNum=pp.InsSubNum JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum WHERE pp.PatNum IN (${ids.map(()=>'?').join(',')}) ORDER BY pp.Ordinal`,ids);for(const row of rows)row.insurance=plans.filter(p=>String(p.PatNum)===String(row.PatNum));}
  return {patients:rows,page:stmt.page,hasMore:all.length>stmt.limit};
 },
 async documents(patNum){
  if(!validId(patNum))throw new Error('Invalid PatNum');
  const [rows]=await pool.execute(`SELECT CAST(d.DocNum AS CHAR) AS DocNum,CAST(d.PatNum AS CHAR) AS PatNum,d.FileName,d.Description,DATE_FORMAT(d.DateCreated,'%Y-%m-%d %H:%i:%s') AS DateCreated,de.ItemName AS Category FROM document d JOIN definition de ON de.DefNum=d.DocCategory WHERE d.PatNum=? AND UPPER(TRIM(de.ItemName)) IN (?,?) AND LOWER(d.FileName) LIKE '%.pdf' ORDER BY d.DateCreated DESC,d.DocNum DESC LIMIT 501`,[patNum,...categories]);
  if(rows.length>500)throw new Error('Hồ sơ có hơn 500 PDF; cần phân trang tài liệu trước khi xử lý.');return {documents:rows};
 },
 async context(patNum){return readPatientContext(pool,patNum);},
 async pdf(patNum,docNum){
  if(!validId(patNum)||!validId(docNum))throw new Error('Invalid document identity');
  const [docs]=await pool.execute(`SELECT d.FileName,p.ImageFolder FROM document d JOIN patient p ON p.PatNum=d.PatNum JOIN definition de ON de.DefNum=d.DocCategory WHERE d.PatNum=? AND d.DocNum=? AND UPPER(TRIM(de.ItemName)) IN (?,?)`,[patNum,docNum,...categories]);
  if(docs.length!==1)throw new Error('Không tìm thấy PDF FINISHED CLAM của bệnh nhân đã chọn.');
  const [prefs]=await pool.execute("SELECT PrefName,ValueString FROM preference WHERE LOWER(PrefName) IN ('docpath','atozfolderused','atozfolder','imagestore')");
  const pref=name=>prefs.find(r=>r.PrefName.toLowerCase()===name)?.ValueString;
  // Open Dental DataStorageType: 0=InDatabase, 1=LocalAtoZ, 2=Dropbox, 3=SFTP.
  // Prefer the OD preference names; retain legacy names for existing installations.
  const root=pref('docpath')||pref('atozfolder');
  const store=String(pref('atozfolderused')??pref('imagestore')??'').trim();
  if(store!=='1')throw new Error(`Không thể đọc PDF từ AtoZ: chế độ lưu trữ ${store||'chưa xác định'}; cần LocalAtoZ (1). Database/cloud chưa được hỗ trợ.`);
  const file=docs[0].FileName,folder=docs[0].ImageFolder;
  if(!root||!folder||!file||/[\\/]/.test(file)||/[\\/]/.test(folder)||['.','..'].includes(file)||['.','..'].includes(folder)||!/\.pdf$/i.test(file))throw new Error('Cấu hình hoặc đường dẫn PDF chưa được hỗ trợ.');
  const base=await fs.realpath(root),target=await fs.realpath(path.join(base,folder[0].toUpperCase(),folder,file));
  const relative=path.relative(base,target);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('PDF outside image root');
  const stat=await fs.stat(target);if(!stat.isFile()||stat.size>30*1024*1024)throw new Error('PDF quá lớn hoặc không phải file.');
  if(Date.now()-stat.mtimeMs<3000)throw new Error('PDF đang được sao chép; thử lại sau vài giây.');
  const bytes=await fs.readFile(target);if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('File không có header PDF.');
  return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),filename:file};
 }
};}
