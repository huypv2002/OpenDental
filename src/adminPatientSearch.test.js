import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {adminPatientSearchFilter} from './adminPatientSearch.js';

test('#70 uses exact SQL before LIMIT even with more than 50 partial matches',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE patient (PatNum INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO patient VALUES (?)').run(70);
  for(let i=1;i<=80;i++)db.prepare('INSERT INTO patient VALUES (?)').run(i*1000+70);
  const search=adminPatientSearchFilter('  #70  ');
  assert.equal(search.exact,true);assert.deepEqual(search.values,[70]);
  const rows=db.prepare(`SELECT PatNum FROM patient p ${search.where} ORDER BY PatNum DESC LIMIT 50 OFFSET 0`).all(...search.values);
  assert.deepEqual(rows.map(r=>r.PatNum),[70]);
  for(const q of ['#0','#9007199254740992']){
   const s=adminPatientSearchFilter(q);assert.equal(db.prepare(`SELECT PatNum FROM patient p ${s.where}`).all(...s.values).length,0);
  }
 }finally{db.close();}
});

test('ordinary name/phone/number search keeps escaped fuzzy matching',()=>{
 for(const q of ['70','Alex','2815550101']){
  const s=adminPatientSearchFilter(q);assert.equal(s.exact,false);assert.equal(s.values.length,9);assert.ok(s.values.every(v=>v===`%${q}%`));assert.match(s.where,/p.FName LIKE/);
 }
 assert.equal(adminPatientSearchFilter('').where,'');
 assert.equal(adminPatientSearchFilter('50%_').values[0],'%50\\%\\_%');
 assert.deepEqual(adminPatientSearchFilter('#0070').values,[70]);
});
