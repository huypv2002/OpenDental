// SELECT-only: show D0210 and D0120 separately, without modifying any chart.
import {pool,closePool} from '../src/db.js';
const patNum=process.argv[2];
if(!/^[1-9]\d{0,14}$/.test(patNum||'')){
  console.error('Usage: node scripts/inspect-metlife-allowable.mjs 690');
  process.exitCode=1;
}else{
  try{
    const [rows]=await pool.execute(`SELECT pl.ProcNum,pc.ProcCode,
      DATE_FORMAT(pl.ProcDate,'%Y-%m-%d') AS ProcDate,pl.ProcStatus,pl.ProcFee,
      pl.ToothNum,pl.Surf,pl.ProvNum
      FROM procedurelog pl JOIN procedurecode pc ON pc.CodeNum=pl.CodeNum
      WHERE pl.PatNum=? AND pc.ProcCode IN ('D0210','D0120')
      ORDER BY pc.ProcCode,pl.ProcDate,pl.ProcNum`,[patNum]);
    console.log(`Patient ${patNum}: SELECT only. ProcStatus=2 means completed.`);
    console.table(rows);
    const completed=rows.filter(r=>r.ProcCode==='D0210'&&Number(r.ProcStatus)===2);
    console.log(`Completed D0210 count: ${completed.length}`);
    console.log('D0120 is a different code and is never substituted for D0210.');
  }catch(error){console.error('Inspection failed:',error.code||error.message);process.exitCode=1;}
  finally{await closePool();}
}
