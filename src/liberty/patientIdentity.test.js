import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {resolveLibertyPatient} from './processor.js';
import {resolvePatient} from '../metlife/autoProcessor.js';
import {resolveCignaPatient} from '../cigna/processor.js';
import {resolveDeltaPatient} from '../delta/processor.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE patient(PatNum INTEGER PRIMARY KEY,FName TEXT,LName TEXT,Birthdate TEXT,ClinicNum INTEGER,PriProv INTEGER,ImageFolder TEXT,ChartNumber TEXT);
 CREATE TABLE patplan(PatNum INTEGER,InsSubNum INTEGER);
 CREATE TABLE inssub(InsSubNum INTEGER,SubscriberID TEXT);`);
 const add=(patNum,id)=>{
  db.prepare('INSERT INTO patient VALUES(?,?,?,?,0,1,?,?)').run(patNum,'DIFFERENT','NAME','1970-01-01','Test'+patNum,String(patNum));
  if(id){db.prepare('INSERT INTO patplan VALUES(?,?)').run(patNum,patNum);db.prepare('INSERT INTO inssub VALUES(?,?)').run(patNum,id);}
 };
 const queries=[];
 const pool={execute:async(sql,args)=>{assert.match(sql,/^SELECT/);queries.push([sql,args]);return [db.prepare(sql).all(...args)];}};
 const resolve=(memberId,fileName='9999.pdf')=>resolveLibertyPatient(pool,{fileName,claim:{claimNumber:'70001',patient:{memberId,firstName:'PRINTED',lastName:'OTHER'}}});
 return {db,add,queries,pool,resolve};
}

for(const [carrier,resolver] of [['MetLife',resolvePatient],['CIGNA',resolveCignaPatient],['Delta Dental',resolveDeltaPatient]]){
 test(`${carrier} binds filename PatNum without comparing EOB name or subscriber, and never falls back`,async()=>{
  const f=fixture();try{
   f.add(1004);f.add(1005,'MATCHING-ID');
   for(const fileName of ['1004.pdf','1004.txt','1792789329060_1004.pdf','1793111377468_1792789329060_1004.pdf','1004 FILE TEST.pdf']){
    const p=await resolver(f.pool,{fileName,parsed:{patient:'Binh T Dang'},claim:{patient:{firstName:'PRINTED',lastName:'OTHER',memberId:'MATCHING-ID'}},claimsCount:1});
    assert.equal(p.PatNum,1004);
   }
   await assert.rejects(resolver(f.pool,{fileName:'1006.pdf'}),e=>e.code==='EOB_REVIEW_REQUIRED');
   const before=f.queries.length;
   for(const fileName of ['no-number.pdf','1792789329060.pdf','1004_1005.pdf'])await assert.rejects(resolver(f.pool,{fileName}),e=>e.code==='EOB_REVIEW_REQUIRED');
   assert.equal(f.queries.length,before);
   assert.ok(f.queries.every(([sql,args])=>args.length===1&&!/LOWER|SubscriberID|JOIN/.test(sql)));
  }finally{f.db.close();}
 });
}

test('Liberty resolves separate subscribers independently of filename and printed names, including absent OD suffix',async()=>{
 const f=fixture();try{
  f.add(101,'TEST-A');f.add(202,'TEST-B-01');f.add(9999);
  assert.equal((await f.resolve('TEST-A-01')).PatNum,101);
  assert.equal((await f.resolve('TEST-B-01')).PatNum,202);
  assert.ok(f.queries.every(([sql])=>!sql.includes('LOWER')));
 }finally{f.db.close();}
});

test('Liberty prefers the exact dependent ID over a different base-ID patient',async()=>{
 const f=fixture();try{
  f.add(101,'TEST-A');f.add(202,'TEST-A-01');
  assert.equal((await f.resolve('TEST-A-01')).PatNum,202);
  assert.equal(f.queries.length,1);
 }finally{f.db.close();}
});

test('Liberty rejects missing, unknown, duplicate exact and shared base subscribers without a name fallback',async()=>{
 for(const ids of [[],['TEST-A','TEST-A'],['TEST-A-01','TEST-A-01','TEST-A']]){
  const f=fixture();try{
   ids.forEach((id,i)=>f.add(101+i,id));
   for(const id of ['', 'UNKNOWN', 'TEST-A-01'])await assert.rejects(f.resolve(id),e=>e.code==='EOB_REVIEW_REQUIRED');
  }finally{f.db.close();}
 }
});
