import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {repairClaim690,readClaim690RepairState,inspectClaim690Repair} from '../src/metlife/repairClaim690.js';

const root=fileURLToPath(new URL('../',import.meta.url));
process.chdir(root);
const args=process.argv.slice(2);
if(args.some(arg=>!['--apply','--inspect'].includes(arg))||args.includes('--apply')&&args.includes('--inspect'))throw new Error('Usage: node scripts/repair-claim-690.mjs [--apply | --inspect]');
const apply=args.includes('--apply');
const inspect=args.includes('--inspect');
const {pool,closePool}=await import('../src/db.js');
const {nativeSplitHashes}=await import('../src/metlife/nativeSplitHashes.js');
const folder=path.join(root,'metlife-backups','repair-690-1202');
const journalPath=path.join(folder,'repair-journal.json');
let db;
try{
  if(apply&&process.env.METLIFE_DIRECT_DB_DISABLED==='true')throw new Error('Direct DB writes are disabled by the clinic configuration.');
  db=await pool.getConnection();
  const [locks]=await db.execute("SELECT GET_LOCK('luk-repair-690-1202',0) AS acquired");
  if(Number(locks[0]?.acquired)!==1)throw new Error('Another repair is running. Nothing was changed.');
  const readJournal=async()=>{
    try{return JSON.parse(await fs.readFile(journalPath,'utf8'));}
    catch(e){if(e.code==='ENOENT')return null;throw e;}
  };
  const writeJournal=async(value,{create=false}={})=>{
    await fs.mkdir(folder,{recursive:true,mode:0o700});
    const file=create?journalPath:path.join(folder,'repair-journal.complete.tmp');
    const handle=await fs.open(file,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
    if(!create)await fs.rename(file,journalPath);
  };
  if(inspect){
    const journal=await readJournal(),state=await readClaim690RepairState(db);
    const report=inspectClaim690Repair(state,journal);
    console.log('\n=== READ-ONLY RECOVERY INSPECTION: CLAIM 690 / PAYMENT 1202 ===');
    console.log(JSON.stringify({...report,d0210:undefined,splits:undefined},null,2));
    console.log('D0210 records:');console.table(report.d0210);
    console.log('Current payment splits:');console.table(report.splits);
    const [logs]=await db.execute({sql:"SELECT SecurityLogNum,PermType,UserNum,PatNum,DATE_FORMAT(LogDateTime,'%Y-%m-%d %H:%i:%s') AS LogDateTime,LogText FROM securitylog WHERE PatNum=? AND (LogText LIKE ? OR LogText LIKE ?) ORDER BY SecurityLogNum",dateStrings:true},[690,'Completed D0210 created by clinic-approved claim 5101035732 89 repair%','Payment 1202 split %Clinic-approved repair.']);
    console.log('Repair audit entries:');console.table(logs);
    const hashes=[];
    for(const log of logs){
      const [rows]=await db.execute('SELECT SecurityLogHashNum,SecurityLogNum,LogHash FROM securityloghash WHERE SecurityLogNum=?',[log.SecurityLogNum]);
      hashes.push({SecurityLogNum:log.SecurityLogNum,HashRows:rows.length,HasHash:rows.length===1&&!!rows[0].LogHash});
    }
    console.log('Repair audit hash status:');console.table(hashes);
    console.log('INSPECTION ONLY: no clinical records or repair journal were changed. Keep the journal. Do not rerun --apply while its status is intent.');
  }else{
  const pending=await readJournal();
  if(pending&&pending.status!=='complete')throw new Error('Pending repair intent exists. Run node scripts/repair-claim-690.mjs --inspect first; no automatic retry.');
  const result=await repairClaim690(db,{apply,hashSplits:nativeSplitHashes,writeJournal,readJournal});
  const p=result.plan;
  console.log('\n=== CLAIM 690 / PAYMENT 1202 ===');
  console.log('Patient: MINH BUI #690. Payment total remains $77.20.');
  console.log('D0150 split $38.00: unchanged. D0120 service: unchanged.');
  if(p.status==='already-correct')console.log('ALREADY CORRECT: $39.20 is linked to the completed $74 D0210. No write.');
  else{
    console.log(`Split #${p.splitNum}: $39.20 moves from D0120 ProcNum ${p.oldProcNum} to D0210.`);
    console.log(p.targetProcNum?`Reuse D0210 ProcNum ${p.targetProcNum}.`:'Add completed D0210 on 2025-09-19, charge $74.00.');
    console.log(`Patient BalTotal: $${(p.beforeBalanceCents/100).toFixed(2)} -> $${(p.afterBalanceCents/100).toFixed(2)} (new charge +$${(p.balanceIncreaseCents/100).toFixed(2)}).`);
  }
  if(result.applied){
    console.log(`SUCCESS: readback verified. D0210 ProcNum ${result.targetProcNum}.`);
    console.log(`Before/after backup: ${journalPath}`);
    console.log('Reopen/refresh the OD account and review aging through the normal OD workflow.');
    console.log('Do not repost 690.pdf. This repaired the existing payment; it did not create a new payment.');
  }else if(!apply)console.log('PREVIEW ONLY: no clinical records were changed. Apply with --apply after reviewing the balance change.');
  }
}catch(error){
  console.error('\nSTOP:',error.message);
  if(error.repairSplits){
    console.error('ACTUAL SPLIT VALUES (read-only; nothing changed by this validation):');
    console.table(error.repairSplits);
  }
  if(error.repairCatalog){
    console.error('ACTUAL CODE CATALOG (read-only):');
    console.table(error.repairCatalog);
  }
  console.error(`If a repair-journal.json exists, keep it for review: ${journalPath}`);
  process.exitCode=1;
}finally{
  if(db){try{await db.execute("SELECT RELEASE_LOCK('luk-repair-690-1202')");}catch{}db.release();}
  await closePool();
}
