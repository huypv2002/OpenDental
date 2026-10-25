// Read-only SERVER diagnostics. Never inserts, updates, deletes or imports an EOB.
import {procedureAreaKey} from '../src/metlife/procedureIdentity.js';
const patNum=Number(process.argv[2]);
if(!Number.isSafeInteger(patNum)||patNum<=0){console.error('Usage: node scripts/inspect-eob-procedures.mjs <PatNum>');process.exit(1);}
const {pool,closePool}=await import('../src/db.js');
try {
 const [rows]=await pool.execute(`SELECT pl.ProcNum,pc.ProcCode,DATE_FORMAT(pl.ProcDate,'%Y-%m-%d') AS ProcDate,
 pl.ProcStatus,pl.ToothNum,pl.Surf,pc.TreatArea,pl.ProcFee
 FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum=pl.CodeNum
 WHERE pl.PatNum=? AND pc.ProcCode IN ('D5110','D5120','D4341','D4342') AND pl.ProcStatus<>6
 ORDER BY pl.ProcDate,pc.ProcCode,pl.ProcNum`,[patNum]);
 const groups=new Map();
 for(const row of rows){const key=JSON.stringify([row.ProcCode,row.ProcDate,procedureAreaKey(row)]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row.ProcNum);}
 console.log(JSON.stringify({readOnly:true,patNum,procedures:rows,possibleDuplicates:[...groups.values()].filter(ids=>ids.length>1)},null,2));
}catch {console.error('Không đọc được dữ liệu. Chạy trên SERVER với .env hiện tại; không cần gửi thông tin kết nối.');process.exitCode=1;}
finally {await closePool();}
