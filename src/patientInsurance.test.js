import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readPatientInsurance} from './patientInsurance.js';
import fs from 'node:fs';
test('administrative insurance lookup preserves dependent subscriber and only reads the exact patient',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE patient(PatNum INTEGER,FName TEXT,LName TEXT,Birthdate TEXT);
 CREATE TABLE patplan(PatNum INTEGER,InsSubNum INTEGER,Ordinal INTEGER);
 CREATE TABLE inssub(InsSubNum INTEGER,Subscriber INTEGER,SubscriberID TEXT,PlanNum INTEGER);
 CREATE TABLE insplan(PlanNum INTEGER,GroupNum TEXT,CarrierNum INTEGER);
 CREATE TABLE carrier(CarrierNum INTEGER,CarrierName TEXT);
 INSERT INTO patient VALUES(1279,'TEST','PERSON','1981-06-06'),(1280,'OTHER','PERSON','1980-01-01'),(1281,'NO','PLAN','1980-01-01');
 INSERT INTO carrier VALUES(1,'Delta Dental');INSERT INTO insplan VALUES(1,'TEST-GROUP',1);
 INSERT INTO inssub VALUES(20,99,'test-dependent-id',1),(21,100,'other-patient-id',1);
 INSERT INTO patplan VALUES(1279,20,1),(1280,21,1);`);
  const pool={execute:async(sql,args)=>{assert.match(sql,/^SELECT/);return [db.prepare(sql).all(...args)];}};
  const before=db.prepare('SELECT total_changes() AS n').get().n;
  const result=await readPatientInsurance(pool,'1279');
  assert.equal(result.patient.PatNum,1279);assert.equal(result.insurance.length,1);
  assert.equal(result.insurance[0].Subscriber,99);assert.equal(result.insurance[0].SubscriberID,'test-dependent-id');
  assert.deepEqual((await readPatientInsurance(pool,'1281')).insurance,[]);
  await assert.rejects(readPatientInsurance(pool,'999'),e=>e.status===404);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n,before);
 }finally{db.close();}
});
test('insurance lookup rejects unsafe IDs before database access and is protected by the existing API token',async()=>{
 const pool={execute:()=>{throw Error('must not query');}};
 for(const value of ['0','-1','1279 OR 1=1','1/insurance','',null])await assert.rejects(readPatientInsurance(pool,value),e=>e.status===400);
 const server=fs.readFileSync(new URL('./server.js',import.meta.url),'utf8');
 assert.match(server,/app\.get\('\/api\/admin\/patients\/:patNum\/insurance', requireApiToken/);
});
