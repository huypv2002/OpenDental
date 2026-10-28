import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {procedureAreaKey,procedureArch,procedureQuadrant,procedureCandidates} from './procedureIdentity.js';
import {planMissingProcedures,createMissingProcedures} from './missingProcedures.js';
import {insuranceLedger} from './testSupport/insuranceLedger.js';
import {verifiedInsurancePayment} from './insuranceSettlement.js';
import {resolvePatient,processSinglePdf} from './autoProcessor.js';
import {extractPdf,parseMetlife} from './parser.js';
import {readInsuranceDocument} from '../liberty/document.js';
import {parseLiberty} from '../liberty/parser.js';
import {processLibertyPdf} from '../liberty/processor.js';
import {readDeltaDocument} from '../delta/document.js';
import {parseDelta} from '../delta/parser.js';
import {processDeltaPdf} from '../delta/processor.js';
const paid=(code,tooth,surface='')=>({code,tooth,surface,date:'2026-09-17',benefitCents:10000,feeCents:10000});

test('complete dentures match existing upper/lower arches, not carrier Q01/Q02 as periodontal quadrants',()=>{
 const rows=[{ProcNum:1,ProcCode:'D5110',ProcDate:'2026-09-17',ToothNum:'',Surf:'U'},{ProcNum:2,ProcCode:'D5120',ProcDate:'2026-09-17',ToothNum:'',Surf:'L'}];
 const source=[paid('D5110','Q01'),paid('D5120','Q02')];
 assert.equal(planMissingProcedures(rows,source).additions.length,0);
 assert.deepEqual(source.map(procedureArch),['U','L']);assert.deepEqual(source.map(procedureQuadrant),['','']);
 assert.equal(procedureAreaKey(rows[0]),procedureAreaKey(source[0]));
 assert.throws(()=>planMissingProcedures([...rows,{...rows[0],ProcNum:3,Surf:'UR'}],source),/trùng/);
 assert.throws(()=>planMissingProcedures([{...rows[0],Surf:'L'}],[source[0]]),/không tự thêm trùng/);
});

test('unique MetLife code/date with absent OD quadrant is reused; an explicit conflicting quadrant stops additions',()=>{
 const source=[paid('D4342','', 'LR')],old={ProcNum:7,ProcCode:'D4342',ProcDate:source[0].date,ToothNum:'',Surf:''};
 assert.equal(planMissingProcedures([old],source,{metlife:true}).additions.length,0);
 assert.equal(procedureCandidates([old],source[0],source,{metlife:true})[0].ProcNum,7);
 assert.throws(()=>planMissingProcedures([{...old,Surf:'UL'}],source,{metlife:true}),/không tự thêm trùng/);
 assert.equal(procedureAreaKey({...old,ToothNum:'Q01'}),procedureAreaKey({...old,Surf:'UR'}));
});

test('locked creation recheck stops an already-existing incompatible procedure instead of duplicating it',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eob-no-duplicate-')),source=paid('D4342','','LR');
 const f=await insuranceLedger(root,[{patNum:99,firstName:'TEST',lastName:'PERSON',procedures:[{...source,surface:'UL'}],serviceDate:source.date}]);
 try{await assert.rejects(createMissingProcedures(f.pool,{plan:planMissingProcedures([], [source]),patient:f.patients[0],claimNumber:'TEST',carrier:'MetLife'}),/không thêm trùng/);assert.equal(f.addedAudit.length,0);assert.equal(f.payments.length,0);}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('payment note remains a duplicate guard when OD clears ExternalId; conflicting old splits stop without writes',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE payment(PayNum INTEGER,PatNum INTEGER,PayDate TEXT,PayAmt REAL,ExternalId TEXT,CheckNum TEXT,PayNote TEXT);
 CREATE TABLE paysplit(SplitNum INTEGER,PayNum INTEGER,PatNum INTEGER,ProcNum INTEGER,ProvNum INTEGER,ClinicNum INTEGER,ProcDate TEXT,DatePay TEXT,SplitAmt REAL);
 INSERT INTO payment VALUES(1,99,'2026-10-02',10,'','','Claim number: 12345');
 INSERT INTO paysplit VALUES(1,1,99,7,1,0,'2026-09-17','2026-10-02',10);`);
 const pool={execute:async(sql,args)=>{assert.match(sql,/^SELECT/);return [db.prepare(sql).all(...args)];}};
 const plan={patNum:99,claimNumber:'12345',date:'2026-10-02',amountCents:1000,splits:[{ProcNum:7,ProvNum:1,ClinicNum:0,date:'2026-09-17',amount:'10.00'}]};
 try{assert.equal((await verifiedInsurancePayment(pool,plan)).PayNum,1);assert.equal(await verifiedInsurancePayment(pool,{...plan,claimNumber:'1234'}),null);
 await assert.rejects(verifiedInsurancePayment(pool,{...plan,splits:[{...plan.splits[0],ProcNum:8}]}),/phân bổ/);
 db.exec(`INSERT INTO payment VALUES(2,99,'2026-10-02',10,'','','Claim number: 12345')`);
 await assert.rejects(verifiedInsurancePayment(pool,plan),/nhiều khoản/);
 }finally{db.close();}
});

test('MetLife timestamp-prefixed filename selects the patient number, not the download timestamp',async()=>{
 const result=await resolvePatient({execute:async(sql,args)=>{assert.deepEqual(args,['1278']);return [[{PatNum:1278,FName:'TEST',LName:'PERSON'}]];}},{fileName:'1792707377410_1278.pdf',parsed:{patient:'TEST'}});assert.equal(result.PatNum,1278);
});

const folder=process.env.EOB_CURRENT_FEEDBACK_DIR;
test('current Liberty 1041 PDF: reuse both denture arches and repeat with a renamed file without new procedures/payments',{skip:!folder},async()=>{
 const bytes=await fs.readFile(path.join(folder,'1041.pdf')),{extracted}=await readInsuranceDocument(bytes,'1041.pdf'),parsed=parseLiberty(extracted);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'liberty-1041-'));
 const f=await insuranceLedger(root,parsed.claims.map((c,i)=>({patNum:[1041,1280][i],firstName:'DIFFERENT',lastName:'NAME',memberId:i===0?c.patient.memberId.replace(/-01$/,''):c.patient.memberId,claimNumber:c.claimNumber,procedures:c.procedures,serviceDate:'2026-09-17'})));
 for(const p of f.procs)if(p.ProcCode==='D5110'||p.ProcCode==='D5120'){p.ToothNum='';p.Surf=p.ProcCode==='D5110'?'U':'L';}
 const count=f.procs.length;
 try{for(const fileName of ['1041.pdf','1280.pdf']){const filePath=path.join(root,fileName);await fs.writeFile(filePath,bytes);await processLibertyPdf(f.pool,{filePath,fileName,fileBytes:bytes,extracted},{hashSplits:f.hashes,log:()=>{}});for(const p of f.payments)p.ExternalId='';}
 assert.deepEqual(f.payments.map(p=>p.PatNum),[1041,1280]);assert.equal(f.addedAudit.length,0);assert.equal(f.procs.length,count);assert.equal(f.payments.length,2);assert.equal(f.splits.length,9);assert.deepEqual(f.payments.map(p=>Number(p.PayAmt)),[1483,250]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('current MetLife 584 PDF: preserve existing D4342 rows with blank OD quadrants and reuse payment on retry',{skip:!folder},async()=>{
 const bytes=await fs.readFile(path.join(folder,'584.pdf')),extracted=await extractPdf(bytes),parsed=parseMetlife(extracted);assert.deepEqual(parsed.errors,[]);assert.equal(parsed.benefitCents,59100);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-584-'));
 const f=await insuranceLedger(root,[{patNum:584,firstName:parsed.patient,lastName:'PERSON',claimNumber:parsed.claimRaw,procedures:parsed.procedures,serviceDate:'2025-07-31'}]);
 for(const p of f.procs)if(p.ProcCode==='D4342')p.Surf='';
 const count=f.procs.length;
 try{for(let i=0;i<2;i++){const filePath=path.join(root,'584.pdf');await fs.writeFile(filePath,bytes);await processSinglePdf(f.pool,filePath,{extract:async()=>extracted,hashSplits:f.hashes});for(const p of f.payments)p.ExternalId='';}
 assert.equal(f.addedAudit.length,0);assert.equal(f.procs.length,count);assert.equal(f.payments.length,1);assert.equal(f.splits.length,6);assert.equal(Number(f.payments[0].PayAmt),591);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('current Delta 1283 PDF: normalize teeth 03/04 and allocate 205.60 across existing services without additions',{skip:!folder},async()=>{
 const bytes=await fs.readFile(path.join(folder,'1283.pdf')),{extracted}=await readDeltaDocument(bytes,'1283.pdf'),parsed=parseDelta(extracted);assert.deepEqual(parsed.errors,[]);
 const claim=parsed.claims[0];assert.equal(claim.paymentPayload.amount,'205.60');assert.deepEqual(claim.procedures.map(p=>[p.tooth,p.benefitCents]),[['3',5520],['4',7520],['14',7520]]);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'delta-1283-'));
 const f=await insuranceLedger(root,[{patNum:1283,firstName:claim.patient.firstName,lastName:claim.patient.lastName,memberId:claim.patient.memberId,claimNumber:claim.claimNumber,procedures:claim.procedures.map(p=>({...p,odTooth:p.tooth.padStart(2,'0')})),serviceDate:'2026-09-20'}]);
 try{const filePath=path.join(root,'1283.pdf');await fs.writeFile(filePath,bytes);await processDeltaPdf(f.pool,{filePath,fileName:'1283.pdf',fileBytes:bytes,extracted},{hashSplits:f.hashes,log:()=>{}});
 assert.equal(f.addedAudit.length,0);assert.equal(f.payments.length,1);assert.equal(Number(f.payments[0].PayAmt),205.6);assert.deepEqual(f.splits.map(s=>s.SplitAmt),['55.20','75.20','75.20']);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
