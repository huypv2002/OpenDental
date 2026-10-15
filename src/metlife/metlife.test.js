import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {searchSql,createRepository} from './repository.js';
import {createMetlifeRouter} from './router.js';
const token='a'.repeat(64);
test('search supports names, both patient IDs, subscriber ID and group without interpolating user text',()=>{
 for(const kind of ['all','name','patientId','subscriberId','groupNumber']){
  const query=searchSql({q:"x' OR 1=1 --",kind});assert.ok(!query.sql.includes("x' OR"));assert.ok(query.values.some(v=>String(v).includes("x' OR")));
 }
 assert.match(searchSql({q:'123',kind:'patientId'}).sql,/ChartNumber/);
 assert.match(searchSql({q:'ABC',kind:'subscriberId'}).sql,/s.SubscriberID/);
 assert.match(searchSql({q:'217117',kind:'groupNumber'}).sql,/ip.GroupNum/);
 assert.throws(()=>searchSql({q:''}));assert.throws(()=>searchSql({q:'x',kind:'arbitrary'}));
});
test('group search returns multiple patients, not one inferred patient',async()=>{
 const repo=createRepository({execute:async(sql)=>sql.includes('FROM patient p')?[[{PatNum:'1',FName:'ONE'},{PatNum:'2',FName:'TWO'}]]:[[{PatNum:'1',GroupNum:'217117'},{PatNum:'2',GroupNum:'217117'}]]});
 const r=await repo.search({q:'217117',kind:'groupNumber'});assert.equal(r.patients.length,2);assert.equal(r.patients[1].insurance[0].GroupNum,'217117');
});
test('documents query is scoped by patient and finished category',async()=>{
 let params;const repo=createRepository({execute:async(sql,values)=>{assert.match(sql,/d.PatNum=\?/);assert.match(sql,/JOIN definition/);params=values;return [[]];}});
 await repo.documents('1278');assert.deepEqual(params,['1278','FINISHED CLAM','FINISHED CLAIMS']);await assert.rejects(repo.documents('1 OR 1=1'));
});
test('PDF lookup verifies patient/document, reads within root and rejects traversal/symlink escape',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-pdf-test-'));const images=path.join(dir,'images');await fs.mkdir(path.join(images,'T','Test99'),{recursive:true});
 const filename=path.join(images,'T','Test99','test.pdf');await fs.writeFile(filename,'%PDF-1.7\nfixture');await fs.utimes(filename,new Date(0),new Date(0));
 let name='test.pdf',params;
 const repo=createRepository({execute:async(sql,values)=>{
  if(sql.includes('FROM document d')){params=values;return [[{FileName:name,ImageFolder:'Test99'}]];}
  return [[{PrefName:'AtoZfolder',ValueString:images},{PrefName:'ImageStore',ValueString:'0'}]];
 }});
 try{
  const file=await repo.pdf('99','55');assert.match(file.bytes.toString(),/^%PDF/);assert.equal(file.sha256.length,64);assert.deepEqual(params,['99','55','FINISHED CLAM','FINISHED CLAIMS']);
  name='../test.pdf';await assert.rejects(repo.pdf('99','55'));
  const outside=path.join(dir,'outside.pdf');await fs.writeFile(outside,'%PDF-1.7');await fs.symlink(outside,path.join(images,'T','Test99','escape.pdf'));name='escape.pdf';await assert.rejects(repo.pdf('99','55'),/outside image root/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('MetLife routes require separate bearer token; no query-token fallback',async()=>{
 const app=express();app.use('/api/metlife',createMetlifeRouter({getToken:()=>token,repository:{health:async()=>({db:true}),search:async q=>({patients:[{PatNum:q.q}]})}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/metlife`;
 try{
  assert.equal((await fetch(url+'/health')).status,401);assert.equal((await fetch(url+'/health?token='+token)).status,401);
  const r=await fetch(url+'/patients?q=99',{headers:{Authorization:'Bearer '+token}});assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).data.patients[0].PatNum,'99');
 }finally{await new Promise(r=>server.close(r));}
});
test('unconfigured API is disabled',async()=>{
 const app=express();app.use(createMetlifeRouter({getToken:()=>'',repository:{}}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/health`)).status,503);}finally{await new Promise(r=>server.close(r));}
});
test('live context uses read-only transaction, string dates/IDs and cleans up query failure',async()=>{
 const {readPatientContext}=await import('./context.js');const queries=[];let released=false,rolled=false;
 const conn={query:async q=>queries.push(q),execute:async options=>{assert.equal(options.dateStrings,true);assert.equal(options.bigNumberStrings,true);throw new Error('fixture-stop');},rollback:async()=>{rolled=true;},release:()=>{released=true;}};
 await assert.rejects(readPatientContext({getConnection:async()=>conn},'1278'),/fixture-stop/);
 assert.ok(queries.includes('START TRANSACTION READ ONLY'));assert.ok(rolled&&released);
});
