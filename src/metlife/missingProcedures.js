import {procedureDay,reviewError} from './insuranceSettlement.js';
import {procedureAreaKey,procedureAreaMatches,procedureQuadrant} from './procedureIdentity.js';

const tooth=s=>/^\d+$/.test(String(s||''))?String(Number(s)):String(s||'');
const sameTooth=(a,b)=>tooth(a)===tooth(b);
function anatomy(p){
 const value=tooth(p.tooth),surf=p.surface||p.surf||'';
 if(procedureQuadrant(p))return {ToothNum:'',Surf:procedureQuadrant(p),TreatArea:4};
 if(['UA','LA'].includes(value))return {ToothNum:'',Surf:value==='UA'?'U':'L',TreatArea:6};
 return {ToothNum:value==='FM'?'':value,Surf:surf,TreatArea:!value||value==='FM'?3:surf?1:2};
}

// Pure preflight: negative IDs reserve missing rows until ALL claims validate.
export function planMissingProcedures(dbProcs,procedures,{allowUniqueCodeDate=false,metlife=false}={}){
 const procs=[...dbProcs],additions=[],seen=new Set();
 for(const p of procedures.filter(p=>p.benefitCents>0)){
  const key=JSON.stringify([p.code,p.date||'',procedureAreaKey(p)]);
  if(seen.has(key))throw reviewError(`${p.code}: nhiều dòng trả tiền cùng ngày/răng; cần đối chiếu trước khi thêm dịch vụ.`);
  seen.add(key);
  const byDate=procs.filter(r=>r.ProcCode===p.code&&(!p.date||procedureDay(r.ProcDate)===p.date));
  if(new Set(byDate.map(r=>JSON.stringify([procedureDay(r.ProcDate),procedureAreaKey(r)]))).size!==byDate.length)throw reviewError(`${p.code}: có nhiều dịch vụ trùng ngày/răng/vùng hàm; cần đối chiếu trước khi thêm.`);
  if(/^D434[12]$/.test(p.code)&&!procedureQuadrant(p)&&byDate.length!==1)throw reviewError(`${p.code}: chưa đọc rõ vùng hàm UR/UL/LR/LL; cần đối chiếu PDF, không tự phân bổ theo thứ tự.`);
  const exact=byDate.filter(r=>procedureAreaMatches(p,r,{metlife}));
  if(exact.length||!procedureQuadrant(p)&&allowUniqueCodeDate&&byDate.length===1&&procedures.filter(r=>r.code===p.code&&r.date===p.date).length===1)continue;
  const date=/^\d{4}-\d{2}-\d{2}$/.test(p.date||'')?new Date(p.date+'T12:00:00Z'):null;
  if(!/^D\d{4}$/.test(p.code)||!date||Number.isNaN(+date)||date.toISOString().slice(0,10)!==p.date||!Number.isSafeInteger(p.benefitCents)||p.benefitCents<=0)throw reviewError(`${p.code}: thiếu ngày/mã/số tiền để thêm dịch vụ.`);
  if(p.tooth&&!/^(?:0?[1-9]|[12]\d|3[0-2]|[A-T]|Q0[1-4]|UR|UL|LR|LL|UA|LA|FM)$/.test(p.tooth))throw reviewError(`${p.code}: chưa đọc rõ răng để thêm dịch vụ.`);
  const virtual={ProcNum:-(additions.length+1),ProcCode:p.code,ProcDate:p.date,ToothNum:anatomy(p).ToothNum,Surf:anatomy(p).Surf,ProcFee:(p.benefitCents/100).toFixed(2),Descript:p.description||p.desc||p.code};
  procs.push(virtual);additions.push({source:p,row:virtual});
 }
 return {procs,additions};
}

async function columns(db,table){
 const [rows]=await db.execute('SELECT COLUMN_NAME,DATA_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[table]);
 const id=table==='procedurelog'?'ProcNum':'CodeNum';
 if(!rows.some(r=>r.COLUMN_NAME===id&&/auto_increment/i.test(r.EXTRA||'')))throw reviewError('Chưa hỗ trợ tự thêm dịch vụ với cấu hình mã số database này.');
 if(rows.some(r=>r.COLUMN_NAME==='SecurityHash'))throw reviewError('Database yêu cầu chữ ký riêng cho dịch vụ mới; cần cấu hình bộ ghi tương thích.');
 const required=table==='procedurelog'?['PatNum','CodeNum','ProcStatus','ProcDate','ProcFee','ProvNum','ClinicNum','ToothNum']:['ProcCode','Descript','AbbrDesc','ProcCat','TreatArea'];
 if(required.some(name=>!rows.some(r=>r.COLUMN_NAME===name)))throw reviewError('Cấu trúc bảng dịch vụ thiếu trường cần thiết; chưa thêm dịch vụ.');
 return rows;
}

// OD schemas have required text/date columns without SQL defaults. Fill only
// those required columns with their empty model values, preserving DB defaults.
async function insertModel(db,table,metadata,values){
 const row={...values};
 for(const c of metadata){
  const name=c.COLUMN_NAME;
  if(Object.hasOwn(row,name)||/auto_increment|GENERATED/i.test(c.EXTRA||'')||c.IS_NULLABLE==='YES'||c.COLUMN_DEFAULT!==null)continue;
  if(/^(?:char|varchar|text|tinytext|mediumtext|longtext)$/.test(c.DATA_TYPE))row[name]='';
  else if(/^(?:tinyint|smallint|mediumint|int|bigint|decimal|float|double|bit)$/.test(c.DATA_TYPE))row[name]=0;
  else if(c.DATA_TYPE==='date')row[name]='0001-01-01';
  else if(/^(?:datetime|timestamp)$/.test(c.DATA_TYPE))row[name]='0001-01-01 00:00:00';
  else if(c.DATA_TYPE==='time')row[name]='00:00:00';
  else throw reviewError('Có trường bắt buộc chưa hỗ trợ khi thêm dịch vụ; chưa tạo thanh toán.');
 }
 const supported=new Set(metadata.map(c=>c.COLUMN_NAME));
 for(const key of Object.keys(row))if(!supported.has(key))delete row[key];
 const names=Object.keys(row);
 if(names.some(k=>!/^\w+$/.test(k)))throw reviewError('Cấu trúc bảng dịch vụ không hợp lệ.');
 const [r]=await db.execute(`INSERT INTO ${table} (${names.map(k=>'`'+k+'`').join(',')}) VALUES (${names.map(()=>'?').join(',')})`,names.map(k=>row[k]));
 if(!Number.isSafeInteger(Number(r.insertId))||Number(r.insertId)<=0)throw reviewError('Chưa xác minh mã số dịch vụ vừa thêm.');
 return r.insertId;
}

export async function createMissingProcedures(pool,{plan,patient,claimNumber,carrier}){
 if(!plan.additions.length)return [];
 const conn=await pool.getConnection();let locked=false;
 try{
  const procColumns=await columns(conn,'procedurelog'),codeColumns=await columns(conn,'procedurecode');
  await conn.execute(`CREATE TABLE IF NOT EXISTS luk_eob_added_procedures (Id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,PatNum BIGINT NOT NULL,ProcNum BIGINT NOT NULL,CodeNum BIGINT NOT NULL,ClaimNumber VARCHAR(64) NOT NULL,Carrier VARCHAR(80) NOT NULL,Details LONGTEXT NOT NULL,CreatedAt DATETIME NOT NULL,UNIQUE KEY ProcNum (ProcNum))`);
  await conn.query('LOCK TABLES procedurelog WRITE,procedurecode WRITE,patient READ,provider READ,definition READ,luk_eob_added_procedures WRITE');locked=true;
  const [patients]=await conn.execute('SELECT PatNum,PriProv,ClinicNum FROM patient WHERE PatNum=?',[patient.PatNum]);
  if(patients.length!==1||String(patients[0].PriProv)!==String(patient.PriProv)||String(patients[0].ClinicNum||0)!==String(patient.ClinicNum||0))throw reviewError('Thông tin bệnh nhân thay đổi trước khi thêm dịch vụ.');
  const [providers]=await conn.execute('SELECT ProvNum FROM provider WHERE ProvNum=? AND IsHidden=0',[patient.PriProv]);
  if(providers.length!==1)throw reviewError('Chưa xác định bác sĩ hợp lệ để thêm dịch vụ.');
  const result=[];
  for(const {source:p,row} of plan.additions){
   const oldId=row.ProcNum;
   const [existing]=await conn.execute(`SELECT procedurelog.ProcNum,procedurelog.ProcStatus,procedurelog.ProcDate,procedurelog.ProcFee,procedurelog.ToothNum,procedurelog.Surf,procedurelog.ProvNum,procedurelog.ClinicNum,procedurecode.ProcCode,procedurecode.Descript FROM procedurelog JOIN procedurecode ON procedurecode.CodeNum=procedurelog.CodeNum WHERE procedurelog.PatNum=? AND procedurecode.ProcCode=? AND procedurelog.ProcDate=?`,[patient.PatNum,p.code,p.date]);
   const matches=existing.filter(r=>procedureAreaMatches(p,r)&&Number(r.ProcStatus)!==6);
   if(matches.length>1||matches.some(r=>Number(r.ProcStatus)!==2))throw reviewError(`${p.code}: đã có dịch vụ cùng ngày/răng chưa xác định duy nhất; không thêm lặp.`);
   if(matches.length===1){Object.assign(row,matches[0]);result.push({oldId,procNum:row.ProcNum,code:p.code,reused:true});continue;}
   const [codes]=await conn.execute('SELECT CodeNum,ProcCode,Descript,TreatArea FROM procedurecode WHERE ProcCode=?',[p.code]);
   if(codes.length>1)throw reviewError(`${p.code}: danh mục có nhiều mã trùng nhau.`);
   let code=codes[0],newCode=false;
   if(!code){
    const [categories]=await conn.execute('SELECT DefNum FROM definition WHERE Category=11 AND IsHidden=0 ORDER BY ItemOrder,DefNum LIMIT 1');
    if(!categories.length)throw reviewError('Thiếu nhóm mã dịch vụ trong Open Dental.');
    const codeNum=await insertModel(conn,'procedurecode',codeColumns,{ProcCode:p.code,Descript:row.Descript,AbbrDesc:p.code,ProcTime:'/X/',ProcCat:categories[0].DefNum,TreatArea:anatomy(p).TreatArea,IsHidden:0});
    code={CodeNum:codeNum,Descript:row.Descript};newCode=true;
   }
   const area=anatomy(p);
   const procNum=await insertModel(conn,'procedurelog',procColumns,{PatNum:patient.PatNum,CodeNum:code.CodeNum,ProcStatus:2,ProcDate:p.date,DateTP:p.date,DateComplete:p.date,ProcFee:row.ProcFee,ProvNum:patient.PriProv,ClinicNum:patient.ClinicNum||0,ToothNum:area.ToothNum,Surf:area.Surf,UnitQty:1,BaseUnits:0,SecDateEntry:new Date(),SecDateTEdit:new Date(),BillingNote:`EOB ${carrier}; Claim number: ${claimNumber}`});
   const [saved]=await conn.execute('SELECT ProcNum,PatNum,CodeNum,ProcStatus,ProcDate,ToothNum,Surf,ProcFee,ProvNum,ClinicNum FROM procedurelog WHERE ProcNum=?',[procNum]);
   const s=saved[0];
   if(saved.length!==1||String(s.PatNum)!==String(patient.PatNum)||String(s.CodeNum)!==String(code.CodeNum)||Number(s.ProcStatus)!==2||procedureDay(s.ProcDate)!==p.date||!sameTooth(s.ToothNum,area.ToothNum)||String(s.Surf||'')!==area.Surf||Math.round(Number(s.ProcFee)*100)!==p.benefitCents||String(s.ProvNum)!==String(patient.PriProv)||String(s.ClinicNum||0)!==String(patient.ClinicNum||0))throw reviewError(`${p.code}: chưa xác minh dịch vụ vừa thêm; kiểm tra trước khi chạy lại.`);
   Object.assign(row,s,{ProcCode:p.code,Descript:code.Descript});
   const receipt={oldId,procNum,codeNum:code.CodeNum,code:p.code,date:p.date,tooth:row.ToothNum,amountCents:p.benefitCents,newCode};
   await conn.execute('INSERT INTO luk_eob_added_procedures (PatNum,ProcNum,CodeNum,ClaimNumber,Carrier,Details,CreatedAt) VALUES (?,?,?,?,?,?,NOW())',[patient.PatNum,procNum,code.CodeNum,claimNumber,carrier,JSON.stringify(receipt)]);
   result.push(receipt);
  }
  return result;
 }finally{try{if(locked)await conn.query('UNLOCK TABLES');}finally{conn.release();}}
}
