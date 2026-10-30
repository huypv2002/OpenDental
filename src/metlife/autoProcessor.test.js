import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePatient, autoPopulateProcedureFees, scanIncomingFolder } from './autoProcessor.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('resolvePatient matches PatNum in filename directly', async () => {
  const pool = {
    execute: async (sql, values) => {
      if (sql.includes('FROM patient p WHERE p.PatNum=?')) {
        assert.equal(values[0], '1307');
        return [[{ PatNum: 1307, FName: 'RYAN', LName: 'PHAM', ClinicNum: 0, PriProv: 1, ImageFolder: 'PhamRyan1307' }]];
      }
      return [[]];
    }
  };

  const patient = await resolvePatient(pool, {
    fileName: '1307.pdf',
    parsed: { patient: 'PHAM, RYAN' }
  });
  assert.equal(patient.PatNum, 1307);
  assert.equal(patient.LName, 'PHAM');
});

test('resolvePatient requires a filename PatNum instead of falling back to a printed name', async () => {
  let queries=0;
  await assert.rejects(resolvePatient({execute:async()=>{queries++;return [[]];}}, {
    fileName:'MetLife_EOB_Claim.pdf',parsed:{patient:'PHAM, RYAN',group:'301044'}
  }),e=>e.code==='EOB_REVIEW_REQUIRED'&&/tên file/.test(e.message));
  assert.equal(queries,0);
});

test('autoPopulateProcedureFees updates 0.00 ProcFee to submitted fee from EOB', async () => {
  const executedUpdates = [];
  const conn = {
    execute: async (sql, values) => {
      if (sql.includes('SELECT procedurelog.ProcNum') || sql.includes('SELECT pl.ProcNum')) {
        return [[
          { ProcNum: 13757, ProcDate: new Date('2026-09-20'), ProcFee: '0.00', ProcCode: 'D0120', CodeNum: 1 },
          { ProcNum: 13783, ProcDate: new Date('2026-09-20'), ProcFee: '0.00', ProcCode: 'D1208', CodeNum: 2 }
        ]];
      }
      if (sql.includes('UPDATE procedurelog SET ProcFee = ? WHERE ProcNum = ?')) {
        executedUpdates.push({ type: 'procedurelog', fee: values[0], procNum: values[1] });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE claimproc SET FeeBilled = ? WHERE ProcNum = ?')) {
        executedUpdates.push({ type: 'claimproc', fee: values[0], procNum: values[1] });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SELECT ClaimNum FROM claim WHERE PatNum = ?')) {
        return [[{ ClaimNum: 55 }]];
      }
      if (sql.includes('UPDATE claim SET ClaimFee')) {
        executedUpdates.push({ type: 'claim', claimNum: values[1] });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SUM(FeeBilled)')) {
        return [[{ TotalFee: '131.40' }]];
      }
      if (sql.includes('SUM(ProcFee)')) {
        return [[{ TotalCharges: '131.40' }]];
      }
      if (sql.includes('SUM(SplitAmt)')) {
        return [[{ TotalPaid: '131.40' }]];
      }
      if (sql.includes('UPDATE patient SET BalTotal')) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    }
  };

  const eobProcedures = [
    { code: 'D0120', feeCents: 9600, benefitCents: 8640, date: '2026-09-20' },
    { code: 'D1208', feeCents: 5000, benefitCents: 4500, date: '2026-09-20' }
  ];

  const updatedFees = await autoPopulateProcedureFees(conn, {
    patNum: 1307,
    eobProcedures
  });

  assert.equal(updatedFees.length, 2);
  assert.match(updatedFees[0], /D0120: \$96\.00/);
  assert.match(updatedFees[1], /D1208: \$50\.00/);

  assert.equal(executedUpdates.filter((u) => u.type === 'procedurelog').length, 2);
  assert.equal(executedUpdates.filter((u) => u.type === 'claimproc').length, 2);
});

test('scanIncomingFolder handles empty incoming folder gracefully', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'metlife-scan-empty-'));
  const pool = {
    execute: async () => [[]]
  };

  try {
    const res = await scanIncomingFolder(pool, dir);
    assert.equal(res.status, 'idle');
    assert.equal(res.count, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MetLife full processor writes blank check, processed date, claim-only note and Finished Claims document',async()=>{
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url);
 const {processSinglePdf}=await import('./autoProcessor.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-payment-format-')),imageRoot=path.join(root,'images'),filePath=path.join(root,'99.pdf');
 await fs.mkdir(imageRoot);
 // Same-length date replacement preserves the synthetic PDF offsets.
 const bytes=Buffer.from(require('../../metlife-electron/scripts/synthetic-metlife.cjs')().toString().replace('PROCESSED on 09/17/2026','PROCESSED on 09/29/2026'));
 await fs.writeFile(filePath,bytes);
 let payment=null,document=null,history=null,released=false;const splits=[];
 const conn={query:async()=>[[]],release(){released=true;},execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];
  if(sql.includes('SELECT PayNum')){assert.match(sql,/ExternalId/);assert.deepEqual(args,[99,'1234567890 99','1234567890 99']);return [[]];}
  if(sql.includes('INSERT INTO payment')){payment=args;return [{insertId:77}];}
  if(sql.includes('INSERT INTO paysplit')){splits.push(args);return [{insertId:splits.length}];}
  if(sql.includes('INSERT INTO securitylog '))return [{insertId:88}];
  if(sql.includes('AS LogDateTime'))return [[{PermType:15,UserNum:0,LogDateTime:'2026-09-29 12:00:00',LogText:'synthetic',PatNum:99,DateTPrevious:'0001-01-01 00:00:00'}]];
  return [{affectedRows:1}];
 }};
 const procs=['D0150','D1110','D0210','D0220','D0230','D0274','D1206'].map((ProcCode,i)=>({ProcNum:51+i,ProcDate:new Date('2026-09-13T12:00:00Z'),ProcFee:0,ProvNum:1,ClinicNum:0,ProcCode,Descript:'Synthetic procedure'}));
 const pool={getConnection:async()=>conn,execute:async(sql,args)=>{
  if(sql.includes('FROM claimproc cp')||sql.includes('SELECT DocNum,FileName FROM document')||sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [[]];
  if(sql.includes('SELECT PayNum,PatNum,PayDate,PayAmt FROM payment'))return [[]];
  if(sql.includes('FROM patient p WHERE p.PatNum'))return [[{PatNum:99,FName:'TEST',LName:'PERSON',ImageFolder:'Test99',ClinicNum:0,PriProv:1}]];
  if(sql.includes('FROM preference'))return [[{PrefName:'DocPath',ValueString:imageRoot},{PrefName:'AtoZfolderUsed',ValueString:'1'}]];
  if(sql.includes('Category = 18')){assert.match(sql,/IsHidden = 0/);return [[{DefNum:55}]];}
  if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [[{COLUMN_NAME:'DocNum',EXTRA:'auto_increment'},...['DocCategory','PatNum','FileName','Description','DateCreated','MountItemNum','RawBase64'].map(COLUMN_NAME=>({COLUMN_NAME,IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:''}))]];
  if(sql.includes('INSERT INTO document')){document=args;return [{insertId:66}];}
  if(sql.includes('SELECT procedurelog.ProcNum'))return [procs];
  if(sql.includes('SELECT ClaimNum'))return [[]];
  if(sql.includes('SUM(ProcFee)'))return [[{TotalCharges:442}]];
  if(sql.includes('SUM(SplitAmt)'))return [[{TotalPaid:0}]];
  if(sql.includes('Category = 10'))return [[{DefNum:10,ItemName:'Insurance Paid'}]];
  if(sql.includes('INSERT INTO luk_metlife_history')){history=JSON.parse(args[12]);return [{insertId:1}];}
  if(sql.startsWith('UPDATE'))return [{affectedRows:1}];
  throw new Error('Unexpected fixture query: '+sql);
 }};
 try{
  const result=await processSinglePdf(pool,filePath,{hashSplits:async plan=>{assert.equal(plan.date,'2026-09-29');return plan.splits.map(()=>'synthetic-only');}});
  assert.equal(result.success,true);assert.equal(released,true);assert.equal(result.docNum,66);
  assert.equal(payment[1],'2026-09-29');assert.equal(payment[3],'');assert.equal(payment[4],'Claim number: 1234567890 99');assert.equal(payment[7],'1234567890 99');
  assert.equal(splits.length,3);assert.ok(splits.every(s=>s[3]==='2026-09-29'));
  assert.equal(document[0],55);assert.equal(document[3],'Claim 1234567890 99  442.00');assert.equal(document[4],'2026-09-29 00:00:00');
  assert.equal(history.paymentDate,'2026-09-29');assert.equal(history.eobPayment.date,'2026-09-17');
  assert.deepEqual(await fs.readFile(path.join(imageRoot,'T','Test99',document[2])),bytes);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Finished Claims import fails visibly before document insert if category or AtoZ path is unavailable',async()=>{
 const {importPdfToAtoZ}=await import('./autoProcessor.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-import-gate-'));let inserts=0;
 try{
  for(const missing of ['category','root']){
   const pool={execute:async(sql)=>{
    if(sql.includes('FROM preference'))return [[{PrefName:'DocPath',ValueString:missing==='root'?path.join(root,'unavailable'):root},{PrefName:'AtoZfolderUsed',ValueString:'1'}]];
    if(sql.includes('Category = 18'))return [[]];
    if(sql.includes('INSERT'))inserts++;
    throw Error('Unexpected query');
   }};
   await assert.rejects(importPdfToAtoZ(pool,{patient:{PatNum:99,ImageFolder:'Test99'},claimNumber:'TEST',paymentDate:'2026-09-29',amountCents:100,fileBytes:Buffer.from('synthetic')}),missing==='category'?/FINISHED CLAM/:{code:'ENOENT'});
  }
  assert.equal(inserts,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('MetLife filename patient ignores printed names, including middle initials, and never falls back',async()=>{
 const patient={PatNum:1004,FName:'BINH',LName:'DANG'},queries=[];
 const pool={execute:async(sql,args)=>{queries.push(sql);return [Number(args[0])===1004?[patient]:[]];}};
 for(const name of ['Binh T Dang','Other',''])for(const fileName of ['1004.pdf','1004.txt','1792789329060_1004.pdf'])assert.equal((await resolvePatient(pool,{fileName,parsed:{patient:name}})).PatNum,1004);
 await assert.rejects(resolvePatient(pool,{fileName:'9999.pdf',parsed:{patient:'Binh Dang'}}),e=>e.code==='EOB_REVIEW_REQUIRED'&&/mã bệnh nhân/.test(e.message));
 assert.ok(queries.every(sql=>sql.includes('WHERE p.PatNum=?')));
});
