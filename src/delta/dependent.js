import {createHash} from 'node:crypto';
import {directWritesEnabled} from '../metlife/directPayment.js';
const review=message=>Object.assign(new Error(message),{code:'EOB_REVIEW_REQUIRED'});
const compact=s=>String(s||'').replace(/\s+/g,'').toLowerCase();
const day=s=>s instanceof Date?s.toISOString().slice(0,10):String(s||'').slice(0,10);
const groupMatches=(stored,source)=>stored===source||stored.startsWith(source+'-');
const identity=(p,s)=>compact(p.FName)===compact(s.firstName)&&compact(p.LName)===compact(s.lastName)&&day(p.Birthdate)===s.birthdate;

// Resolve the patient independently from the subscriber. A dependent never
// inherits the subscriber's patient number, DOB, or existing insurance ID.
export async function prepareDeltaDependent(db,{claim,patNum}){
 const s=claim.subscriber,group=claim.plan?.group||claim.groupNumber;
 if(claim.patient.relationship!=='Dependent'||!patNum||!s?.firstName||!s.lastName||!/^\d{4}-\d{2}-\d{2}$/.test(s.birthdate||'')||!/^\d{6,20}$/.test(s.memberId||'')||!/^[-\w]+$/.test(group||''))throw review('Delta Dependent thiếu tên/ngày sinh chủ hợp đồng hoặc group; chưa tự gắn bảo hiểm.');
 const [patients]=await db.execute('SELECT PatNum,FName,LName,CAST(Birthdate AS CHAR) AS Birthdate,PriProv,ClinicNum,ImageFolder,ChartNumber,BillingType FROM patient WHERE PatNum=?',[patNum]);
 if(patients.length!==1||!identity(patients[0],claim.patient))throw review('Delta Dependent: mã bệnh nhân, họ tên hoặc ngày sinh không khớp.');
 const patient=patients[0];
 const [policies]=await db.execute(`SELECT s.InsSubNum,s.PlanNum,s.Subscriber,s.SubscriberID,ip.GroupNum,c.CarrierName,
 subscriberPatient.FName,subscriberPatient.LName,CAST(subscriberPatient.Birthdate AS CHAR) AS Birthdate
 FROM inssub s JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum
 LEFT JOIN patient subscriberPatient ON subscriberPatient.PatNum=s.Subscriber
 WHERE s.SubscriberID=? AND UPPER(c.CarrierName) LIKE '%DELTA%' LIMIT 3`,[s.memberId]);
 if(policies.length>1||policies.some(p=>!identity(p,s)||!groupMatches(String(p.GroupNum||''),group)))throw review('Delta Dependent: chủ hợp đồng/Subscriber ID/group chưa khớp duy nhất.');
 const [current]=await db.execute(`SELECT pp.PatPlanNum,pp.Ordinal,pp.Relationship,pp.InsSubNum,s.PlanNum,ip.GroupNum,c.CarrierName
 FROM patplan pp JOIN inssub s ON s.InsSubNum=pp.InsSubNum JOIN insplan ip ON ip.PlanNum=s.PlanNum JOIN carrier c ON c.CarrierNum=ip.CarrierNum
 WHERE pp.PatNum=? ORDER BY pp.Ordinal`,[patNum]);
 const target=policies[0];
 const planNums=[...new Set((target?[target]:current.filter(p=>/DELTA/i.test(p.CarrierName)&&groupMatches(String(p.GroupNum||''),group))).map(p=>String(p.PlanNum)))];
 if(planNums.length!==1)throw review('Delta Dependent: chưa xác định duy nhất plan Delta cùng group trong OD; chưa tạo plan mới.');
 const [subscribers]=await db.execute(`SELECT PatNum,FName,LName,CAST(Birthdate AS CHAR) AS Birthdate,PatStatus,Guarantor FROM patient
 WHERE LOWER(REPLACE(TRIM(FName),' ',''))=LOWER(?) AND LOWER(REPLACE(TRIM(LName),' ',''))=LOWER(?) AND DATE(Birthdate)=? LIMIT 3`,[compact(s.firstName),compact(s.lastName),s.birthdate]);
 if(subscribers.length>1||subscribers.some(p=>String(p.PatNum)===String(patNum)))throw review('Delta Dependent: chủ hợp đồng không xác định duy nhất hoặc trùng chính bệnh nhân.');
 if(subscribers.some(p=>[3,4].includes(Number(p.PatStatus))))throw review('Delta Dependent: hồ sơ chủ hợp đồng đã lưu trữ hoặc qua đời; chưa tự gắn.');
 if(target&&(subscribers.length!==1||String(subscribers[0].PatNum)!==String(target.Subscriber)))throw review('Delta Dependent: thông tin chủ hợp đồng thay đổi.');
 const linked=target?current.find(p=>String(p.InsSubNum)===String(target.InsSubNum)):null;
 if(linked&&Number(linked.Relationship)!==8)throw review('Delta Dependent: quan hệ đã có trong OD khác Dependent; chưa ghi đè.');
 if(!linked&&Math.max(0,...current.map(p=>Number(p.Ordinal)||0))>=9)throw review('Delta Dependent: không còn thứ tự bảo hiểm để thêm.');
 return {patient,planNum:planNums[0],subscriber:subscribers[0]||null,policy:target||null,linked:linked||null,source:s,group};
}

async function metadata(db,table,id){
 const [cols]=await db.execute('SELECT COLUMN_NAME,DATA_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[table]);
 if(!cols.some(c=>c.COLUMN_NAME===id&&/auto_increment/i.test(c.EXTRA||''))||cols.some(c=>c.COLUMN_NAME==='SecurityHash'))throw review('Cấu trúc OD chưa hỗ trợ tự thêm người phụ thuộc.');
 return cols;
}
async function insert(db,table,cols,values){
 const row={...values};
 for(const c of cols){
  if(c.COLUMN_NAME in row||c.IS_NULLABLE==='YES'||c.COLUMN_DEFAULT!=null||/auto_increment|GENERATED/i.test(c.EXTRA||''))continue;
  if(/^(?:char|varchar|text|tinytext|mediumtext|longtext)$/.test(c.DATA_TYPE))row[c.COLUMN_NAME]='';
  else if(/^(?:tinyint|smallint|mediumint|int|bigint|decimal|float|double|bit)$/.test(c.DATA_TYPE))row[c.COLUMN_NAME]=0;
  else if(c.DATA_TYPE==='date')row[c.COLUMN_NAME]='0001-01-01';
  else if(/^(?:datetime|timestamp)$/.test(c.DATA_TYPE))row[c.COLUMN_NAME]='0001-01-01 00:00:00';
  else if(c.DATA_TYPE==='time')row[c.COLUMN_NAME]='00:00:00';
  else throw review('Có trường bắt buộc chưa hỗ trợ khi thêm người phụ thuộc.');
 }
 if(Object.keys(row).some(k=>!cols.some(c=>c.COLUMN_NAME===k)||!/^\w+$/.test(k)))throw review('Thiếu cột cần thiết để thêm người phụ thuộc.');
 const keys=Object.keys(row),[r]=await db.execute(`INSERT INTO ${table} (${keys.map(k=>'`'+k+'`').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,keys.map(k=>row[k]));
 if(!Number.isSafeInteger(Number(r.insertId))||Number(r.insertId)<=0)throw review('Chưa xác minh mã số bản ghi người phụ thuộc.');
 return String(r.insertId);
}

// LOCK TABLES matches the bridge's MyISAM-compatible procedure writer. A durable
// pending receipt precedes writes; retry re-reads exact identities to recover
// partial success instead of creating duplicates. Never replaces an old plan.
export async function applyDeltaDependent(pool,{claim,patient,log=console.log}){
 if(!patient.deltaDependentPlan)return;
 if(!directWritesEnabled())throw review('SERVER đang tắt ghi OD; chưa gắn người phụ thuộc.');
 const conn=await pool.getConnection();let locked=false;
 try{
  const cols={patient:await metadata(conn,'patient','PatNum'),inssub:await metadata(conn,'inssub','InsSubNum'),patplan:await metadata(conn,'patplan','PatPlanNum')};
  await conn.execute(`CREATE TABLE IF NOT EXISTS luk_eob_dependent_links (OperationKey CHAR(64) NOT NULL PRIMARY KEY,PatNum BIGINT NOT NULL,ClaimNumber VARCHAR(64) NOT NULL,Status VARCHAR(16) NOT NULL,Details LONGTEXT NOT NULL,UpdatedAt DATETIME NOT NULL)`);
  await conn.query('LOCK TABLES patient WRITE,patient AS subscriberPatient WRITE,inssub WRITE,inssub AS s WRITE,patplan WRITE,patplan AS pp WRITE,insplan AS ip READ,carrier AS c READ,luk_eob_dependent_links WRITE');locked=true;
  const fresh=await prepareDeltaDependent(conn,{claim,patNum:patient.PatNum});
  if(fresh.planNum!==patient.deltaDependentPlan.planNum)throw review('Plan Delta thay đổi sau khi đối chiếu; chưa gắn người phụ thuộc.');
  const key=createHash('sha256').update(JSON.stringify([String(patient.PatNum),fresh.planNum,fresh.source.memberId])).digest('hex');
  const receipt={planNum:fresh.planNum,subscriberPatNum:fresh.subscriber?.PatNum||null,insSubNum:fresh.policy?.InsSubNum||null,patPlanNum:fresh.linked?.PatPlanNum||null,relationship:'Dependent'};
  await conn.execute(`INSERT INTO luk_eob_dependent_links (OperationKey,PatNum,ClaimNumber,Status,Details,UpdatedAt) VALUES (?,?,?,'pending',?,NOW()) ON DUPLICATE KEY UPDATE Status='pending',Details=VALUES(Details),UpdatedAt=NOW()`,[key,patient.PatNum,claim.claimNumber,JSON.stringify(receipt)]);
  const save=()=>conn.execute('UPDATE luk_eob_dependent_links SET Details=?,UpdatedAt=NOW() WHERE OperationKey=?',[JSON.stringify(receipt),key]);
  if(!receipt.subscriberPatNum){
   receipt.subscriberPatNum=await insert(conn,'patient',cols.patient,{FName:fresh.source.firstName,LName:fresh.source.lastName,Birthdate:fresh.source.birthdate,PatStatus:1,Gender:2,Guarantor:0,PriProv:patient.PriProv||0,ClinicNum:patient.ClinicNum||0,BillingType:fresh.patient.BillingType||0});
   await conn.execute('UPDATE patient SET Guarantor=? WHERE PatNum=? AND Guarantor=0',[receipt.subscriberPatNum,receipt.subscriberPatNum]);await save();
  }
  if(fresh.subscriber&&Number(fresh.subscriber.PatStatus)===1&&Number(fresh.subscriber.Guarantor)===0)await conn.execute('UPDATE patient SET Guarantor=? WHERE PatNum=? AND Guarantor=0',[receipt.subscriberPatNum,receipt.subscriberPatNum]);
  if(!receipt.insSubNum){
   receipt.insSubNum=await insert(conn,'inssub',cols.inssub,{PlanNum:fresh.planNum,Subscriber:receipt.subscriberPatNum,SubscriberID:fresh.source.memberId,ReleaseInfo:1,AssignBen:1});await save();
  }
  if(!receipt.patPlanNum){
   const [plans]=await conn.execute('SELECT PatPlanNum,Ordinal FROM patplan WHERE PatNum=?',[patient.PatNum]);
   const ordinal=Math.max(0,...plans.map(p=>Number(p.Ordinal)||0))+1;
   if(ordinal>9)throw review('Không còn thứ tự bảo hiểm để tự thêm người phụ thuộc.');
   receipt.patPlanNum=await insert(conn,'patplan',cols.patplan,{PatNum:patient.PatNum,InsSubNum:receipt.insSubNum,Relationship:8,Ordinal:ordinal,IsPending:0,PatID:'',OrthoAutoFeeBilledOverride:-1});await save();
  }
  const verified=await prepareDeltaDependent(conn,{claim,patNum:patient.PatNum});
  if(!verified.linked||String(verified.linked.PatPlanNum)!==String(receipt.patPlanNum)||String(verified.policy?.InsSubNum)!==String(receipt.insSubNum)||String(verified.subscriber?.PatNum)!==String(receipt.subscriberPatNum))throw review('Chưa xác minh quan hệ Dependent vừa thêm; kiểm tra trước khi chạy lại.');
  await conn.execute("UPDATE luk_eob_dependent_links SET Status='verified',Details=?,UpdatedAt=NOW() WHERE OperationKey=?",[JSON.stringify(receipt),key]);
  log(`[Delta Dental Auto-Processor] Claim #${claim.claimNumber}: đã xác minh quan hệ Dependent cho bệnh nhân #${patient.PatNum}, PatPlanNum: ${receipt.patPlanNum}.`);
 }finally{try{if(locked)await conn.query('UNLOCK TABLES');}finally{conn.release();}}
}
