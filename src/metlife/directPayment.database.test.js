import {test} from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readPatientContext} from './context.js';
import {createDirectPaymentWriter} from './directPayment.js';
import {validatePostingPlan,verifyPostedPayment} from './posting.js';
import {databaseDiagnostics} from './databaseDiagnostics.js';

test('MariaDB: commit/readback, idempotency, rollback on second split, lost COMMIT response and engine gate', {skip:!process.env.METLIFE_TEST_DB_URL}, async()=>{
 // A deliberately separate test URL; never fall back to the clinic DB_* settings.
 const target=new URL(process.env.METLIFE_TEST_DB_URL);
 assert.ok(['localhost','127.0.0.1'].includes(target.hostname),'Integration test must use a local disposable DB service.');
 const options={host:target.hostname,port:Number(target.port)||3306,user:decodeURIComponent(target.username),password:decodeURIComponent(target.password),dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(options),name='luk_metlife_test_'+randomUUID().replaceAll('-','');let pool;
 try{
  await admin.query(`CREATE DATABASE \`${name}\``);pool=mysql.createPool({...options,database:name,connectionLimit:4});
  const sql=await fs.readFile(new URL('./fixtures/direct-payment.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await pool.query(statement);
  const writer=createDirectPaymentWriter(pool,{enabled:()=>true});
  const draft={patNum:'99',sha256:'a'.repeat(64),amount:'35.00',date:'2026-09-24',note:'group number : SYNTHETIC',checkNum:'TEST-A',paymentType:'Insurance Paid',splits:[{ProcNum:'51',ProvNum:'3',ClinicNum:'2',code:'D2392',date:'2026-09-13',tooth:'13',providerAbbr:'DOC',description:'Composite',amountCents:3500}]};
  const before=await readPatientContext(pool,'99'),plan=validatePostingPlan(before,draft),op={id:randomUUID(),patNum:'99',docNum:'1',before,plan};
  const result=await writer(op);assert.match(result.payNum,/^\d+$/);assert.equal((await writer(op)).replayed,true);
  const after=await readPatientContext(pool,'99');assert.equal(verifyPostedPayment(before,after,plan).verified,true);assert.equal(after.tables.payment.length,1);assert.equal(after.tables.paysplit.length,1);
  const [createdRows]=await pool.query('SELECT SecUserNumEntry FROM payment UNION ALL SELECT SecUserNumEntry FROM paysplit');assert.equal(createdRows.length,2);assert.ok(createdRows.every(r=>Number(r.SecUserNumEntry)===0));
  const report=await databaseDiagnostics(pool,{enabled:()=>true});assert.equal(report.ready,true);
  // Fail after the payment and first split were inserted. All rows must roll back.
  await pool.query("CREATE TRIGGER reject_second_split BEFORE INSERT ON paysplit FOR EACH ROW BEGIN IF NEW.ProcNum=52 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic split failure'; END IF; END");
  const next={...draft,sha256:'b'.repeat(64),checkNum:'TEST-B',amount:'36.00',splits:[...draft.splits,{ProcNum:'52',ProvNum:'3',ClinicNum:'2',code:'D0120',date:'2026-09-13',tooth:'',providerAbbr:'DOC',description:'Exam',amountCents:100}]};
  const current=await readPatientContext(pool,'99'),nextPlan=validatePostingPlan(current,next);
  await assert.rejects(writer({...op,id:randomUUID(),before:current,plan:nextPlan}),e=>e.noWrite===true);
  assert.equal((await readPatientContext(pool,'99')).tables.payment.length,1);
  const [[count]]=await pool.query('SELECT COUNT(*) AS n FROM luk_metlife_postings');assert.equal(Number(count.n),1);
  await pool.query('DROP TRIGGER reject_second_split');
  // Simulate a successful COMMIT whose response is lost. Journal and payment remain.
  const uncertainId=randomUUID();
  const unstable={query:(...a)=>pool.query(...a),getConnection:async()=>{
   const conn=await pool.getConnection();return new Proxy(conn,{get(obj,key){if(key==='commit')return async()=>{await obj.commit();throw new Error('lost COMMIT reply');};const value=obj[key];return typeof value==='function'?value.bind(obj):value;}});
  }};
  await assert.rejects(createDirectPaymentWriter(unstable,{enabled:()=>true})({...op,id:uncertainId,before:current,plan:nextPlan}),e=>e.message==='lost COMMIT reply'&&!e.noWrite);
  assert.equal((await writer({...op,id:uncertainId,before:current,plan:nextPlan})).replayed,true);
  assert.equal((await readPatientContext(pool,'99')).tables.payment.length,2);
  await pool.query('ALTER TABLE payment ENGINE=MyISAM');
  await assert.rejects(writer({...op,id:randomUUID()}),/SecurityHash/);
  assert.equal((await databaseDiagnostics(pool,{enabled:()=>true})).schemaCompatible,false);
 }finally{if(pool)await pool.end();await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);await admin.end();}
});


test('MariaDB MyISAM 24.3: locks, new identities, schema fields, hash readback, partial-write journal and crash recovery', {skip:!process.env.METLIFE_TEST_DB_URL}, async()=>{
 const target=new URL(process.env.METLIFE_TEST_DB_URL);assert.ok(['localhost','127.0.0.1'].includes(target.hostname));
 const options={host:target.hostname,port:Number(target.port)||3306,user:decodeURIComponent(target.username),password:decodeURIComponent(target.password),dateStrings:true,supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(options),name='luk_metlife_myisam_test_'+randomUUID().replaceAll('-','');let pool;
 try{
  await admin.query(`CREATE DATABASE \`${name}\``);pool=mysql.createPool({...options,database:name,connectionLimit:4});
  const sql=await fs.readFile(new URL('./fixtures/direct-payment.sql',import.meta.url),'utf8');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await pool.query(statement);
  const {contextTables}=await import('./context.js');
  for(const table of contextTables)await pool.query(`ALTER TABLE \`${table}\` ENGINE=MyISAM`);
  await pool.query("ALTER TABLE payment ADD COLUMN ExternalId VARCHAR(255) NOT NULL, ADD COLUMN PaymentStatus TINYINT NOT NULL");
  await pool.query("ALTER TABLE paysplit ADD COLUMN SecurityHash VARCHAR(255) NOT NULL");
  await pool.query("UPDATE preference SET ValueString='24.3.61.0' WHERE PrefName='ProgramVersion'");
  await pool.query("INSERT INTO preference VALUES ('DataBaseVersion','24.3.53.0')");
  // Synthetic provider output with the native length observed on SERVER.
  const hashSplits=async plan=>plan.splits.map(s=>'H'+String(s.amountCents).padStart(8,'0'));
  const writer=createDirectPaymentWriter(pool,{enabled:()=>true,hashSplits});
  const draft={patNum:'99',sha256:'a'.repeat(64),amount:'35.00',date:'2026-09-24',note:'SYNTHETIC MYISAM',checkNum:'MYISAM-A',paymentType:'Insurance Paid',splits:[{ProcNum:'51',ProvNum:'3',ClinicNum:'2',code:'D2392',date:'2026-09-13',tooth:'13',providerAbbr:'DOC',description:'Composite',amountCents:3500}]};
  const before=await readPatientContext(pool,'99'),plan=validatePostingPlan(before,draft),op={id:randomUUID(),patNum:'99',docNum:'1',before,plan};
  const result=await writer(op);assert.equal(result.storage,'myisam');assert.equal((await writer(op)).replayed,true);
  const after=await readPatientContext(pool,'99');assert.equal(verifyPostedPayment(before,after,plan).verified,true);assert.equal(after.tables.payment.length,1);assert.equal(after.tables.paysplit[0].SecurityHash,(await hashSplits(plan))[0]);assert.equal(after.tables.paysplit[0].SecurityHash.length,9);
  const [[payment]]=await pool.query('SELECT ExternalId,PaymentStatus FROM payment');assert.equal(payment.ExternalId,'');assert.equal(Number(payment.PaymentStatus),0);
  const {myisamReceipt}=await import('./myisamPayment.js');assert.equal((await myisamReceipt(pool,op.id)).payNum,result.payNum);
  assert.equal((await databaseDiagnostics(pool,{enabled:()=>true,hashSplits})).ready,true);
  // Simulate a lost final journal update after all clinical rows were persisted.
  await pool.query("UPDATE luk_metlife_myisam_jobs SET State='intent' WHERE OperationId=?",[op.id]);
  assert.equal((await myisamReceipt(pool,op.id)).payNum,result.payNum);assert.equal((await writer(op)).replayed,true);
  const next={...draft,sha256:'b'.repeat(64),checkNum:'MYISAM-B',amount:'36.00',splits:[...draft.splits,{ProcNum:'52',ProvNum:'3',ClinicNum:'2',code:'D0120',date:'2026-09-13',tooth:'',providerAbbr:'DOC',description:'Exam',amountCents:100}]};
  await pool.query("CREATE TRIGGER reject_second_split BEFORE INSERT ON paysplit FOR EACH ROW BEGIN IF NEW.ProcNum=52 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic myisam failure'; END IF; END");
  const current=await readPatientContext(pool,'99'),partial={id:randomUUID(),patNum:'99',docNum:'2',before:current,plan:validatePostingPlan(current,next)};
  await assert.rejects(writer(partial),e=>!e.noWrite);
  const interrupted=await readPatientContext(pool,'99');assert.equal(interrupted.tables.payment.length,2);assert.equal(interrupted.tables.paysplit.length,2);
  const [[job]]=await pool.query('SELECT State,IntentJson FROM luk_metlife_myisam_jobs WHERE OperationId=?',[partial.id]);assert.equal(job.State,'intent');assert.equal(JSON.parse(job.IntentJson).splits.length,2);
  assert.equal(await myisamReceipt(pool,partial.id),null);await assert.rejects(writer(partial),/chưa đủ/);
  assert.equal((await readPatientContext(pool,'99')).tables.payment.length,2); // never retries or deletes rows
  await pool.query('DROP TRIGGER reject_second_split');
  // Locks were released even on failure; a separate connection can still write.
  await pool.query("UPDATE patient SET FName='TEST' WHERE PatNum=99");
  const [engines]=await pool.query("SELECT ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN ('payment','paysplit')",[name]);assert.ok(engines.every(t=>t.ENGINE==='MyISAM'));
 }finally{if(pool)await pool.end();await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);await admin.end();}
});
