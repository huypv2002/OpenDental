import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recallServiceDate,dailyRecallCandidates,claimDailyRecall,completeDailyRecall} from './smsDailyRecall.js';

test('daily recall uses calendar months, including month ends and leap years',()=>{
 for(const [today,service] of [['2026-10-23','2026-04-23'],['2026-10-24','2026-04-24'],['2026-10-31','2026-04-30'],['2026-08-31','2026-02-28'],['2024-08-31','2024-02-29'],['2026-01-15','2025-07-15']])assert.equal(recallServiceDate(today),service);
 for(const invalid of ['2026-02-30','','10/23/2026'])assert.throws(()=>recallServiceDate(invalid),e=>e.status===400);
});

test('daily selection is exact latest completed service date, three requested codes, no upcoming appointment or existing dispatch',async()=>{
 let query;
 const db={execute:async(sql,args)=>{if(sql.startsWith('CREATE'))return [{}];query={sql,args};return [[{PatNum:9,Language:'Spanish',LastProcDate:'2026-04-23'}]];}};
 const result=await dailyRecallCandidates(db,{date:'2026-10-23',codes:'D1120',months:1,afterPatNum:8,limit:500});
 assert.equal(result.contract,'calendar-6-month-v1');assert.equal(result.serviceDate,'2026-04-23');
 assert.deepEqual(query.args,['D1110','D4341','D4342','2026-04-23',8,'2026-10-23 00:00:00',500]);
 assert.match(query.sql,/pl.ProcStatus=2/);assert.match(query.sql,/MAX\(pl.ProcDate\)/);assert.match(query.sql,/DATE\(s.LastProcDate\)=\?/);
 assert.match(query.sql,/p.PatStatus=0/);assert.match(query.sql,/a.AptStatus=1/);assert.match(query.sql,/luk_sms_daily_recall_dispatch/);assert.match(query.sql,/r.Status IN \('sent','needs-review'\)/);
 assert.deepEqual(result.patients.map(p=>p.Language),['Spanish']);
});

test('concurrent workers reserve a patient/service date once; pending/failed dispatch remains reserved',async()=>{
 const records=new Map();
 const db={execute:async(sql,args)=>{
  if(sql.startsWith('CREATE')){assert.match(sql,/PRIMARY KEY \(PatNum,LastProcDate\)/);return [{}];}
  if(sql.startsWith('INSERT IGNORE')){const key=args.slice(0,2).join('/');if(records.has(key))return [{affectedRows:0}];records.set(key,{phone:args[2],token:args[3],status:'pending'});return [{affectedRows:1}];}
  if(sql.startsWith('UPDATE')){const r=records.get(args.slice(1,3).join('/'));if(!r||r.token!==args[4]||r.phone!==args[3])return [{affectedRows:0}];r.status=args[0];return [{affectedRows:1}];}
  throw Error('unexpected query');
 }};
 const body={patNum:99,lastProcDate:'2026-04-23',runDate:'2026-10-23',phone:'(281) 555-0123',wirelessPhone:'(281) 555-0123'};
 const results=await Promise.all(Array.from({length:25},()=>claimDailyRecall(db,body)));
 assert.equal(results.filter(r=>r.claimed).length,1);const winner=results.find(r=>r.claimed);
 await assert.rejects(completeDailyRecall(db,{...body,dailyRecall:true,status:'sent',dispatchToken:'wrong'}),e=>e.status===409);
 await completeDailyRecall(db,{...body,dailyRecall:true,status:'failed',dispatchToken:winner.token});
 assert.equal((await claimDailyRecall(db,body)).claimed,false);
 assert.equal((await claimDailyRecall(db,{...body,lastProcDate:'2026-10-23',runDate:'2027-04-23'})).claimed,true);
});
