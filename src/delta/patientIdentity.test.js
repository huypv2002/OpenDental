import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {deltaPatientFileNumber,resolveDeltaPatient,diagnoseDeltaPatient} from './processor.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE patient(PatNum INTEGER PRIMARY KEY,FName TEXT,LName TEXT,Birthdate TEXT,ClinicNum INTEGER,PriProv INTEGER,ImageFolder TEXT,ChartNumber TEXT);
 CREATE TABLE patplan(PatNum INTEGER,InsSubNum INTEGER);
 CREATE TABLE inssub(InsSubNum INTEGER,PlanNum INTEGER,SubscriberID TEXT);
 CREATE TABLE insplan(PlanNum INTEGER,CarrierNum INTEGER);
 CREATE TABLE carrier(CarrierNum INTEGER,CarrierName TEXT);
 INSERT INTO carrier VALUES(1,'Delta Dental'),(2,'Other insurance');
 INSERT INTO insplan VALUES(1,1),(2,2);`);
 const add=(patNum,{first='TOAN',last='BUI',birth='1960-04-03',member='test-member-423',plan=1}={})=>{
  db.prepare('INSERT INTO patient VALUES(?,?,?,?,0,1,?,?)').run(patNum,first,last,birth,'Test'+patNum,String(patNum));
  db.prepare('INSERT INTO inssub VALUES(?,?,?)').run(patNum,plan,member);
  db.prepare('INSERT INTO patplan VALUES(?,?)').run(patNum,patNum);
 };
 const pool={execute:async(sql,args)=>{assert.match(sql,/^SELECT/);return [db.prepare(sql).all(...args)];}};
 const claim={patient:{firstName:'Quoc Toan',lastName:'Bui',birthdate:'1960-04-03',memberId:'test-member-423'}};
 return {db,add,pool,claim,resolve:(fileName='1792789329060_423.pdf',claimsCount=1)=>resolveDeltaPatient(pool,{claim,fileName,claimsCount})};
}

test('Delta recognizes PatNum, timestamp prefixes and descriptive filenames, never arbitrary embedded numbers',()=>{
 for(const [file,expected] of [['423.pdf','423'],['1792789329060_423.pdf','423'],['1792789329060_423.JPEG','423'],['1283 DELTA CHAY OK.pdf','1283'],['423_more.pdf','423'],['1792789329060.pdf',null],['note_423.pdf',null],['1792789329060_423_424.pdf',null],['0.pdf',null],['9007199254740992.pdf',null]])assert.equal(deltaPatientFileNumber(file),expected);
});

test('Delta uses filename PatNum despite different names, DOB, subscriber or plan, with no lookup writes',async()=>{
 for(const change of [{},{first:'OTHER'},{last:'OTHER'},{birth:'1980-01-01'},{member:'other'},{plan:2}]){
  const f=fixture();try{
   f.add(423,change);f.add(425,{first:'QUOC TOAN'});
   const before=f.db.prepare('SELECT total_changes() AS n').get().n;
   for(const file of ['423.pdf','423.txt','1792789329060_423.pdf','423 DELTA SAMPLE.pdf'])assert.equal((await f.resolve(file)).PatNum,423);
   assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
  }finally{f.db.close();}
 }
});

test('Delta requires a real filename PatNum and never falls back to matching names',async()=>{
 const f=fixture();try{
  f.add(423,{first:'QUOC TOAN'});
  for(const file of ['unlabelled.pdf','note_423.pdf','1792789329060_424.pdf'])await assert.rejects(f.resolve(file),e=>e.code==='EOB_REVIEW_REQUIRED');
  assert.equal((await f.resolve('423.pdf',2)).PatNum,423);
 }finally{f.db.close();}
});

test('Delta identity diagnostics identify each mismatch without exposing subscriber values or writing',async()=>{
 const variants=[[{first:'WRONG'},'firstNameMatches','tên'],[{last:'OTHER'},'lastNameMatches','họ'],[{birth:'1960-04-04'},'birthdateMatches','ngày sinh'],[{member:'other-member'},'subscriberMatches','Subscriber ID'],[{plan:2},'deltaPlanExists','bảo hiểm Delta']];
 for(const [change,key,label] of variants){
  const f=fixture();try{
   f.add(423,change);const before=f.db.prepare('SELECT total_changes() AS n').get().n;
   const result=await diagnoseDeltaPatient(f.pool,{claim:f.claim,fileName:'423.txt',claimsCount:1});
   assert.equal(result[key],false);assert.equal(result.patientExists,true);
   assert.equal((await f.resolve('423.txt')).PatNum,423);
   assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
  }finally{f.db.close();}
 }
});

test('Delta identity diagnostics distinguish absent patient and a fully matching identity',async()=>{
 const f=fixture();try{
  assert.deepEqual(await diagnoseDeltaPatient(f.pool,{claim:f.claim,fileName:'423.txt',claimsCount:1}),{patNum:423,patientExists:false});
  await assert.rejects(f.resolve('423.txt'),/mã bệnh nhân/);
  f.add(423);
  const result=await diagnoseDeltaPatient(f.pool,{claim:f.claim,fileName:'423.txt',claimsCount:1});
  assert.ok(Object.entries(result).every(([key,value])=>key==='patNum'||value===true));
 }finally{f.db.close();}
});

test('Delta optional diagnostics report name spacing without blocking filename identity',async()=>{
 for(const first of ['VANANH','VAN ANH','Van  Anh']){
  const f=fixture();try{
   f.claim.patient.firstName='Van Anh';f.claim.patient.lastName='Mai';
   f.add(1279,{first,last:'MAI'});
   assert.equal((await f.resolve('1279.txt')).PatNum,1279);
   assert.equal((await f.resolve('1793111377468_1279.pdf')).PatNum,1279);
   const checks=await diagnoseDeltaPatient(f.pool,{claim:f.claim,fileName:'1279.txt',claimsCount:1});
   assert.equal(checks.firstNameMatches,true);
   if(first==='VANANH')await assert.rejects(f.resolve('unlabelled.txt'),/tên file/);
  }finally{f.db.close();}
 }
 for(const change of [{first:'VANANN'},{last:'OTHER'}]){
  const f=fixture();try{
   f.claim.patient.firstName='Van Anh';f.claim.patient.lastName='Mai';
   f.add(1279,{first:'VANANH',last:'MAI',...change});
   assert.equal((await f.resolve('1279.txt')).PatNum,1279);
  }finally{f.db.close();}
 }
});

 test('Delta filename alone accepts different DOB, subscriber and insurance plan per clinic rule',async()=>{
 for(const file of ['1279.txt','1279.pdf','1793111377468_1279.pdf']){
  const f=fixture();try{
   f.claim.patient.firstName='Van Anh';f.claim.patient.lastName='Mai';
   f.add(1279,{first:'VANANH',last:'MAI',birth:'1980-01-01',member:'different',plan:2});
   f.db.exec('DELETE FROM patplan');
   const before=f.db.prepare('SELECT total_changes() AS n').get().n;
   assert.equal((await f.resolve(file)).PatNum,1279);
   assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
   await assert.rejects(f.resolve('1278.txt'),/duy nhất/);
  }finally{f.db.close();}
 }
});
