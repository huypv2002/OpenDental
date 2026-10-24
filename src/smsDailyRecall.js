import {randomUUID} from 'node:crypto';

export const DAILY_RECALL_CODES=['D1110','D4341','D4342'];
const table='luk_sms_daily_recall_dispatch';
function date(value){
 const s=String(value||'');const d=/^\d{4}-\d{2}-\d{2}$/.test(s)?new Date(s+'T12:00:00Z'):null;
 if(!d||Number.isNaN(+d)||d.toISOString().slice(0,10)!==s)throw Object.assign(new Error('A valid YYYY-MM-DD clinic date is required.'),{status:400});
 return s;
}
export async function ensureDailyRecall(db){
 await db.execute(`CREATE TABLE IF NOT EXISTS ${table} (
 PatNum BIGINT NOT NULL,LastProcDate DATE NOT NULL,Phone VARCHAR(30) NOT NULL,
 ClaimToken CHAR(36) NOT NULL,Status VARCHAR(30) NOT NULL,UpdatedAt DATETIME NOT NULL,
 PRIMARY KEY (PatNum,LastProcDate)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
export function recallServiceDate(value){
 const [year,month,day]=date(value).split('-').map(Number);
 const first=new Date(Date.UTC(year,month-7,1));
 const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
 first.setUTCDate(Math.min(day,last));return first.toISOString().slice(0,10);
}
export async function dailyRecallCandidates(db,query){
 const runDate=date(query.date),limit=Math.max(1,Math.min(500,parseInt(query.limit,10)||500));
 const serviceDate=recallServiceDate(runDate);
 const after=Math.max(0,parseInt(query.afterPatNum,10)||0);
 await ensureDailyRecall(db);
 const [patients]=await db.execute(`SELECT p.PatNum,p.FName,p.LName,p.WirelessPhone,p.Language,p.Gender,
 DATE_FORMAT(p.Birthdate,'%Y-%m-%d') AS Birthdate,
 DATE_FORMAT(s.LastProcDate,'%Y-%m-%d') AS LastProcDate,s.ProcedureCodes
 FROM patient p JOIN (SELECT pl.PatNum,MAX(pl.ProcDate) AS LastProcDate,
 GROUP_CONCAT(DISTINCT pc.ProcCode ORDER BY pc.ProcCode SEPARATOR ', ') AS ProcedureCodes
 FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum=pl.CodeNum
 WHERE pl.ProcStatus=2 AND pc.ProcCode IN (?,?,?) AND pl.ProcDate=? GROUP BY pl.PatNum) s ON s.PatNum=p.PatNum
 WHERE p.PatStatus=0 AND DATE(s.LastProcDate)=? AND p.PatNum>?
 AND NOT EXISTS (SELECT 1 FROM ${table} d WHERE d.PatNum=p.PatNum AND d.LastProcDate=DATE(s.LastProcDate))
 AND NOT EXISTS (SELECT 1 FROM luk_sms_recall_log r WHERE r.PatNum=p.PatNum
 AND r.LastProcDate=DATE(s.LastProcDate) AND r.Status IN ('sent','needs-review'))
 ORDER BY p.PatNum LIMIT ?`,[...DAILY_RECALL_CODES,serviceDate,serviceDate,after,limit]);
 return {contract:'calendar-6-month-v2',date:runDate,serviceDate,months:6,codes:DAILY_RECALL_CODES,patients};
}
export async function claimDailyRecall(db,body){
 const patNum=Number(body.patNum),lastProcDate=date(body.lastProcDate),phone=String(body.phone||'');
 if(!Number.isSafeInteger(patNum)||patNum<=0||typeof body.wirelessPhone!=='string'||!body.wirelessPhone.trim()||!/^(?:1)?\d{10}$/.test(phone.replace(/\D/g,''))||phone.replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'')!==body.wirelessPhone.replace(/\D/g,'').replace(/^1(?=\d{10}$)/,''))throw Object.assign(new Error('Valid patient and Wireless phone are required.'),{status:400});
 await ensureDailyRecall(db);
 const runDate=date(body.runDate);
 if(recallServiceDate(runDate)!==lastProcDate)throw Object.assign(new Error('Daily recall service date does not match the run date.'),{status:400});
 const token=randomUUID();
 // One reservation per patient/service date, even if two workstations run or
 // a process dies after Phone Link sends but before the final log is saved.
 const [result]=await db.execute(`INSERT IGNORE INTO ${table} (PatNum,LastProcDate,Phone,ClaimToken,Status,UpdatedAt)
 SELECT ?,?,?,?,'pending',NOW() FROM patient p WHERE p.PatNum=? AND p.PatStatus=0
 AND p.WirelessPhone=?
 AND EXISTS (SELECT 1 FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum=pl.CodeNum
 WHERE pl.PatNum=p.PatNum AND pl.ProcStatus=2 AND pc.ProcCode IN (?,?,?) AND pl.ProcDate=?)`,
 [patNum,lastProcDate,phone,token,patNum,body.wirelessPhone,...DAILY_RECALL_CODES,lastProcDate]);
 return {claimed:result.affectedRows===1,token:result.affectedRows===1?token:null};
}
export async function completeDailyRecall(db,body){
 if(!body.dailyRecall)return;
 if(!body.dispatchToken||!['needs-review','sent','failed'].includes(body.status))throw Object.assign(new Error('Daily recall dispatch token/status is required.'),{status:400});
 const [result]=await db.execute(`UPDATE ${table} SET Status=?,UpdatedAt=NOW() WHERE PatNum=? AND LastProcDate=? AND Phone=? AND ClaimToken=?`,[body.status,body.patNum,date(body.lastProcDate),body.phone,body.dispatchToken]);
 // changedRows can be zero for an idempotent completion; affectedRows reports
 // matched rows with mysql2's default FOUND_ROWS flag.
 if(!result.affectedRows)throw Object.assign(new Error('Daily recall reservation does not match.'),{status:409});
}
