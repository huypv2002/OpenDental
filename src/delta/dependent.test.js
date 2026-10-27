import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import {prepareDeltaDependent,applyDeltaDependent} from './dependent.js';
import {readDeltaTextDocument} from './textDocument.js';
import {parseDelta} from './parser.js';
import {processLibertyPdf} from '../liberty/processor.js';

function fixture(){
 const db=new DatabaseSync(':memory:');db.function('NOW',()=>new Date().toISOString());
 db.exec(`CREATE TABLE patient(PatNum INTEGER PRIMARY KEY AUTOINCREMENT,FName TEXT NOT NULL,LName TEXT NOT NULL,Birthdate TEXT NOT NULL,PatStatus INTEGER NOT NULL DEFAULT 0,Gender INTEGER NOT NULL DEFAULT 2,Guarantor INTEGER NOT NULL DEFAULT 0,PriProv INTEGER NOT NULL DEFAULT 1,ClinicNum INTEGER NOT NULL DEFAULT 0,ImageFolder TEXT NOT NULL DEFAULT '',ChartNumber TEXT NOT NULL DEFAULT '',BillingType INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE carrier(CarrierNum INTEGER PRIMARY KEY,CarrierName TEXT);
 CREATE TABLE insplan(PlanNum INTEGER PRIMARY KEY,CarrierNum INTEGER,GroupNum TEXT);
 CREATE TABLE inssub(InsSubNum INTEGER PRIMARY KEY AUTOINCREMENT,PlanNum INTEGER NOT NULL,Subscriber INTEGER NOT NULL,SubscriberID TEXT NOT NULL,ReleaseInfo INTEGER NOT NULL DEFAULT 1,AssignBen INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE patplan(PatPlanNum INTEGER PRIMARY KEY AUTOINCREMENT,PatNum INTEGER NOT NULL,InsSubNum INTEGER NOT NULL,Relationship INTEGER NOT NULL,Ordinal INTEGER NOT NULL,IsPending INTEGER NOT NULL DEFAULT 0,PatID TEXT NOT NULL DEFAULT '',OrthoAutoFeeBilledOverride REAL NOT NULL DEFAULT -1);
 CREATE TABLE luk_eob_dependent_links(OperationKey TEXT PRIMARY KEY,PatNum INTEGER,ClaimNumber TEXT,Status TEXT,Details TEXT,UpdatedAt TEXT);
 INSERT INTO patient(PatNum,FName,LName,Birthdate,Guarantor) VALUES(1279,'TESTPATIENT','PERSON','1981-06-06',1279);
 INSERT INTO carrier VALUES(1,'Delta Dental Ins. Co. - Texas');INSERT INTO insplan VALUES(99,1,'21767-10000');
 INSERT INTO inssub(InsSubNum,PlanNum,Subscriber,SubscriberID) VALUES(259,99,1279,'test-member-3303');
 INSERT INTO patplan(PatPlanNum,PatNum,InsSubNum,Relationship,Ordinal) VALUES(500,1279,259,0,1);`);
 const claim={claimNumber:'20262965110923',patient:{firstName:'Test Patient',lastName:'Person',birthdate:'1981-06-06',relationship:'Dependent'},subscriber:{firstName:'SUBSCRIBER',lastName:'EXAMPLE',birthdate:'1971-02-08',memberId:'115000003301'},plan:{group:'21767'}};
 let locked=false,failAfter='';const events=[];
 const execute=async(sql,args=[])=>{
  events.push(sql);
  if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [db.prepare(`PRAGMA table_info(${args[0]})`).all().map(c=>({COLUMN_NAME:c.name,DATA_TYPE:/INT/.test(c.type)?'bigint':/REAL/.test(c.type)?'double':'varchar',IS_NULLABLE:c.notnull?'NO':'YES',COLUMN_DEFAULT:c.dflt_value,EXTRA:c.pk?'auto_increment':''}))];
  if(sql.startsWith('CREATE TABLE IF NOT EXISTS'))return [{}];
  if(!sql.startsWith('SELECT'))assert.equal(locked,true,'all OD mutations must hold the writer lock');
  sql=sql.replace("ON DUPLICATE KEY UPDATE Status='pending',Details=VALUES(Details),UpdatedAt=NOW()","ON CONFLICT(OperationKey) DO UPDATE SET Status='pending',Details=excluded.Details,UpdatedAt=NOW()");
  const stmt=db.prepare(sql);if(sql.startsWith('SELECT'))return [stmt.all(...args)];
  const r=stmt.run(...args);if(failAfter&&sql.startsWith(failAfter)){failAfter='';throw Error('simulated process interruption after persisted insert');}
  return [{insertId:Number(r.lastInsertRowid),affectedRows:r.changes}];
 };
 const conn={execute,query:async sql=>{events.push(sql);if(sql.startsWith('LOCK TABLES')){assert.equal(locked,false);locked=true;}if(sql==='UNLOCK TABLES')locked=false;return [[]];},release:()=>assert.equal(locked,false)};
 const pool={execute,getConnection:async()=>conn};
 const prepare=()=>prepareDeltaDependent(pool,{claim,patNum:1279});
 const apply=async()=>{const plan=await prepare();return applyDeltaDependent(pool,{claim,patient:{...plan.patient,deltaDependentPlan:plan},log:()=>{}});};
 return {db,pool,claim,prepare,apply,events,interruptAfter:s=>{failAfter=s;}};
}

test('Dependent creates a NonPatient subscriber and new coverage once, preserves old insurance, verifies and audits',async()=>{
 const f=fixture();try{
  const old=f.db.prepare('SELECT * FROM inssub WHERE InsSubNum=259').get();
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;
  const plan=await f.prepare();assert.equal(plan.subscriber,null);assert.equal(plan.policy,null);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before,'preflight must be read-only');
  await f.apply();await f.apply();
  const root=f.db.prepare("SELECT * FROM patient WHERE FName='SUBSCRIBER'").all();
  assert.equal(root.length,1);assert.equal(root[0].PatStatus,1);assert.equal(root[0].Guarantor,root[0].PatNum);
  const linked=f.db.prepare('SELECT * FROM patplan WHERE PatNum=1279 ORDER BY Ordinal').all();
  assert.equal(linked.length,2);assert.equal(linked[1].Relationship,8);assert.equal(linked[1].Ordinal,2);
  assert.deepEqual(f.db.prepare('SELECT * FROM inssub WHERE InsSubNum=259').get(),old);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM inssub WHERE SubscriberID=?").get(f.claim.subscriber.memberId).n,1);
  assert.equal(f.db.prepare('SELECT Status FROM luk_eob_dependent_links').get().Status,'verified');
 }finally{f.db.close();}
});

test('Dependent retries recover interruptions after subscriber, policy or patient-plan insertion without duplicates',async()=>{
 for(const stage of ['INSERT INTO patient ','INSERT INTO inssub ','INSERT INTO patplan ']){
  const f=fixture();try{
   f.interruptAfter(stage);await assert.rejects(f.apply(),/interruption/);
   await f.apply();
   assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM patient WHERE FName='SUBSCRIBER'").get().n,1);
   assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inssub WHERE SubscriberID=?').get(f.claim.subscriber.memberId).n,1);
   assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM patplan WHERE PatNum=1279').get().n,2);
   assert.equal(f.db.prepare('SELECT Status FROM luk_eob_dependent_links').get().Status,'verified');
  }finally{f.db.close();}
 }
});

test('Dependent reuses an existing exact subscriber and policy, including a subscriber in a different family',async()=>{
 const f=fixture();try{
  f.db.prepare("INSERT INTO patient(PatNum,FName,LName,Birthdate,Guarantor) VALUES(12,'SUBSCRIBER','EXAMPLE','1971-02-08',12)").run();
  f.db.prepare('INSERT INTO inssub(InsSubNum,PlanNum,Subscriber,SubscriberID) VALUES(20,99,12,?)').run(f.claim.subscriber.memberId);
  await f.apply();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM patient').get().n,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inssub').get().n,2);
  assert.equal((await f.prepare()).linked.InsSubNum,20);
 }finally{f.db.close();}
});

test('Dependent rejects absent metadata, wrong patient, ambiguous subscriber, group conflict and conflicting existing relationship before writes',async()=>{
 for(const change of [
  f=>{f.claim.subscriber.birthdate='';},
  f=>{f.claim.patient.birthdate='1980-06-06';},
  f=>{f.claim.plan.group='99999';},
  f=>{for(const id of [12,13])f.db.prepare("INSERT INTO patient(PatNum,FName,LName,Birthdate) VALUES(?,'SUBSCRIBER','EXAMPLE','1971-02-08')").run(id);},
  f=>{f.db.prepare("INSERT INTO patient(PatNum,FName,LName,Birthdate) VALUES(12,'WRONG','PERSON','1971-02-08')").run();f.db.prepare('INSERT INTO inssub(InsSubNum,PlanNum,Subscriber,SubscriberID) VALUES(20,99,12,?)').run(f.claim.subscriber.memberId);},
  f=>{f.db.prepare('INSERT INTO inssub(InsSubNum,PlanNum,Subscriber,SubscriberID) VALUES(20,99,12,?)').run(f.claim.subscriber.memberId);},
  f=>{f.db.prepare('UPDATE patplan SET Ordinal=9').run();}
 ]){
  const f=fixture();try{change(f);const n=f.db.prepare('SELECT total_changes() AS n').get().n;await assert.rejects(f.prepare(),/Delta Dependent/);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,n);}finally{f.db.close();}
 }
});

test('user 1279 TXT retains dependent and subscriber metadata separately (optional private fixture)',{skip:!process.env.DELTA_TEXT_TEST_FILE},async()=>{
 const p=parseDelta(readDeltaTextDocument(await fs.readFile(process.env.DELTA_TEXT_TEST_FILE)).extracted);
 assert.deepEqual(p.errors,[]);const c=p.claims[0];assert.equal(c.patient.relationship,'Dependent');
 assert.equal(c.patient.raw,'Van Anh Mai');assert.equal(c.subscriber.raw,'Joseph Nichols');assert.equal(c.subscriber.birthdate,'1971-02-08');assert.equal(c.plan.group,'21767');
});

test('Dependent refuses a changed plan and conflicting relationship without creating duplicate rows',async()=>{
 const f=fixture();try{
  const prepared=await f.prepare();
  f.db.prepare("UPDATE insplan SET GroupNum='OTHER' WHERE PlanNum=99").run();
  await assert.rejects(applyDeltaDependent(f.pool,{claim:f.claim,patient:{...prepared.patient,deltaDependentPlan:prepared},log:()=>{}}),/Delta/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM patient').get().n,1);
  f.db.prepare("UPDATE insplan SET GroupNum='21767-10000' WHERE PlanNum=99").run();
  await f.apply();
  f.db.prepare('UPDATE patplan SET Relationship=0 WHERE PatPlanNum<>500').run();
  await assert.rejects(f.apply(),/quan hệ/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM patplan').get().n,2);
 }finally{f.db.close();}
});

test('coverage hook never runs when document procedure preflight fails',async()=>{
 let applied=false;
 const claim={claimNumber:'20262965110923',patient:{firstName:'TEST',lastName:'PERSON',memberId:'test-id'},totals:{planPaidCents:100},procedures:[{line:1,date:'2026-10-22',code:'D2393',tooth:'4',feeCents:100,benefitCents:100,allowedCents:100,copayCents:0,deductibleCents:0,coinsuranceCents:0,patientDueCents:0}]};
 const pool={execute:async()=>{throw Error('simulated procedure preflight failure');}};
 await assert.rejects(processLibertyPdf(pool,{fileName:'1279.txt',extracted:{}},{carrier:'DELTA DENTAL',normalized:{claims:[claim],errors:[],check:{netPaymentCents:100}},patientResolver:async()=>({PatNum:1279}),applyPatientCoverage:async()=>{applied=true;}}),/procedure preflight/);
 assert.equal(applied,false);
});
