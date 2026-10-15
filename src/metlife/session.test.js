import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {issueSession,readSession,loginLimiter} from './session.js';
import {createMetlifeRouter} from './router.js';
const secret='s'.repeat(64);
test('desktop sessions verify signature, audience, expiry and secret rotation',()=>{
 const token=issueSession(secret,{adminId:7},1000);
 assert.equal(readSession(secret,token,1001).sub,'7');
 assert.equal(readSession('other',token,1001),null);
 assert.equal(readSession(secret,token+'x',1001),null);
 assert.equal(readSession(secret,token,1000+31*86400000),null);
});
test('login limiter expires attempt buckets',()=>{
 let now=0;const allow=loginLimiter(()=>now);
 for(let i=0;i<10;i++)assert.equal(allow('one'),true);
 assert.equal(allow('one'),false);assert.equal(allow('two'),true);
 now=16*60000;assert.equal(allow('one'),true);
});
test('desktop login needs valid active admin and rechecks account revocation on protected routes',async()=>{
 let active=true,role='admin';
 const app=express();app.use('/api/metlife',createMetlifeRouter({getToken:()=>secret,repository:{health:async()=>({db:true})},login:async({password})=>{if(password!=='correct')throw Error('secret database details');return {admin:{adminId:7,isActive:true,role}};},isActive:async()=>active}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/metlife`;
 const login=password=>fetch(url+'/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'test-admin',password})});
 try{
  const bad=await login('wrong');assert.equal(bad.status,401);assert.ok(!(await bad.text()).includes('database'));
  role='staff';assert.equal((await login('correct')).status,401);role='admin';
  const result=await (await login('correct')).json();assert.notEqual(result.data.token,secret);
  const headers={Authorization:'Bearer '+result.data.token};assert.equal((await fetch(url+'/health',{headers})).status,200);
  active=false;assert.equal((await fetch(url+'/health',{headers})).status,401);
  for(let i=0;i<7;i++)await login('wrong');assert.equal((await login('correct')).status,429);
 }finally{await new Promise(r=>server.close(r));}
});
