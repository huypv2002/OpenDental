import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {insuranceZeroFields} from '../insuranceSettlement.js';

// In-memory clinic fixture: persistent state is shared across repeated processor
// calls, so retries must preserve actual IDs rather than replaying canned results.
export async function insuranceLedger(root,claims){
 const imageRoot=path.join(root,'images');await fs.mkdir(imageRoot,{recursive:true});
 const patients=claims.map((c,i)=>({PatNum:c.patNum||101+i,FName:c.firstName,LName:c.lastName,ImageFolder:`Test${i}`,ClinicNum:0,PriProv:1,memberId:c.memberId,carrier:c.carrier,claimNumber:c.claimNumber}));
 const procs=[],claimprocs=[],payments=[],splits=[],documents=[],history=[],events=[],fees=[];let locked=false,payId=100,docId=200,hashCalls=0;
 for(const [i,c] of claims.entries())for(const [j,p] of c.procedures.entries()){
  const id=1000+i*100+j;procs.push({ProcNum:id,PatNum:patients[i].PatNum,ProcCode:p.code,ProcDate:p.date||c.serviceDate,ProcFee:p.feeCents/100||0,ProvNum:1,ClinicNum:0,ToothNum:p.odTooth??p.tooth??'',Descript:'Synthetic procedure'});
  claimprocs.push({ClaimProcNum:id+5000,PatNum:patients[i].PatNum,ProcNum:id,ClaimNum:500+i,PlanNum:700+i,InsSubNum:800+i,Status:0,InsPayAmt:0,ClaimPaymentNum:0,FeeBilled:p.feeCents/100||0,...Object.fromEntries(insuranceZeroFields.map(k=>[k,70]))});
 }
 const unrelated={ClaimProcNum:99999,PatNum:patients[0].PatNum,ProcNum:99998,ClaimNum:99997,PlanNum:99996,InsSubNum:99995,Status:0,InsPayAmt:0,ClaimPaymentNum:0,...Object.fromEntries(insuranceZeroFields.map(k=>[k,99]))};claimprocs.push(unrelated);procs.push({ProcNum:99998,PatNum:patients[0].PatNum,ProcCode:'D9999',ProcDate:claims[0].serviceDate,ProcFee:99,ProvNum:1,ClinicNum:0,ToothNum:'',Descript:'Unrelated same-day service'});
 const byIds=(rows,pat,ids,key='ClaimProcNum')=>rows.filter(r=>String(r.PatNum)===String(pat)&&ids.map(String).includes(String(r[key])));
 async function execute(sql,args=[]){
  events.push([sql,args]);assert.ok(!sql.startsWith('DELETE'),'processor must never delete old financial records');
  if(sql.includes('FROM patient WHERE PatNum'))return [patients.filter(p=>p.PatNum===Number(args[0]))];
  if(sql.includes('FROM patient p')){
   const p=patients.find(p=>args.includes(p.memberId))||patients.find(p=>args.includes(p.FName)&&args.includes(p.LName));return [p?[p]:[]];
  }
  if(sql.includes('SELECT procedurelog.ProcNum')||sql.includes('SELECT pl.ProcNum'))return [procs.filter(p=>p.PatNum===args[0])];
  if(sql.includes('FROM claimproc cp'))return [byIds(claimprocs,args[0],args.slice(1,-1),'ProcNum').map(r=>({...r}))];
  if(sql.includes('FROM claimproc WHERE PatNum=? AND ClaimProcNum IN'))return [byIds(claimprocs,args[0],args.slice(1)).map(r=>({...r}))];
  if(sql.startsWith('UPDATE claimproc SET InsPayEst=')){
   assert.ok(locked);for(const r of byIds(claimprocs,args[0],args.slice(1)))for(const k of insuranceZeroFields)r[k]=0;return [{affectedRows:1}];
  }
  if(sql.includes('COALESCE(SUM(InsPayEst)')){const selected=claimprocs.filter(r=>String(r.ClaimNum)===String(args[0])&&r.PatNum===args[1]);return [[{InsPayEst:selected.reduce((n,r)=>n+r.InsPayEst,0),WriteOff:selected.reduce((n,r)=>n+r.WriteOff,0)}]];}
  if(sql.includes('FROM payment WHERE PatNum ='))return [payments.filter(p=>p.PatNum===args[0]&&(p.ExternalId===args[1]||p.CheckNum===args[2]))];
  if(sql.includes('FROM paysplit WHERE PayNum='))return [splits.filter(s=>s.PayNum===args[0])];
  if(sql.includes('FROM preference'))return [[{PrefName:'DocPath',ValueString:imageRoot},{PrefName:'AtoZfolderUsed',ValueString:'1'}]];
  if(sql.includes('Category = 18'))return [[{DefNum:18}]];
  if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [[{COLUMN_NAME:'DocNum',EXTRA:'auto_increment'},...['DocCategory','PatNum','FileName','Description','DateCreated','ImgType','MountItemNum','ExternalSource','RawBase64'].map(COLUMN_NAME=>({COLUMN_NAME,IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:''}))]];
  if(sql.startsWith('SELECT DocNum,FileName FROM document'))return [documents.filter(d=>d.PatNum===args[0]&&d.DocCategory===args[1]&&d.Description===args[2]&&d.DateCreated===args[3])];
  if(sql.includes('INSERT INTO document')){assert.equal(locked,false);const d={DocNum:++docId,DocCategory:args[0],PatNum:args[1],FileName:args[2],Description:args[3],DateCreated:args[4]};documents.push(d);return [{insertId:d.DocNum}];}
  if(sql.includes('Category = 10'))return [[{DefNum:10,ItemName:'Insurance Paid'}]];
  if(sql.includes('INSERT INTO payment')){assert.ok(locked);const p={PayNum:++payId,PayDate:args[1],PayAmt:args[2],CheckNum:args[3],PayNote:args[4],PatNum:args[5],ExternalId:args[7]};payments.push(p);return [{insertId:p.PayNum}];}
  if(sql.includes('INSERT INTO paysplit')){assert.ok(locked);splits.push({SplitAmt:args[0],PatNum:args[1],ProcDate:args[2],DatePay:args[3],ProcNum:args[4],ProvNum:args[5],ClinicNum:args[6],PayNum:args[7]});return [{insertId:splits.length}];}
  if(sql.includes('INSERT INTO securitylog '))return [{insertId:300}];
  if(sql.includes('AS LogDateTime'))return [[{PermType:15,UserNum:0,LogDateTime:'2026-10-23 12:00:00',LogText:'Synthetic',PatNum:patients[0].PatNum,DateTPrevious:'0001-01-01 00:00:00'}]];
  if(sql.includes('INSERT INTO securityloghash'))return [{insertId:301}];
  if(sql.includes('SELECT Id,Details FROM luk_metlife_history'))return [history.filter(r=>r.PayNum===args[0]&&r.PatNum===args[1]&&r.ClaimNumber===args[2])];
  if(sql.includes('INSERT INTO luk_metlife_history')){history.push({Id:history.length+1,FileName:args[0],FileHash:args[1],PatNum:args[2],PatientName:args[3],ClaimNumber:args[4],TotalAmount:args[6],PayNum:args[9],DocNum:args[10],Status:'SUCCESS',Details:args[12]});return [{insertId:history.length}];}
  if(sql.startsWith('UPDATE luk_metlife_history')){const h=history.find(r=>r.Id===args[2]);h.Details=args[0];return [{affectedRows:1}];}
  if(sql.includes('SUM(ProcFee)'))return [[{TotalCharges:0}]];
  if(sql.includes('SUM(SplitAmt)'))return [[{TotalPaid:0}]];
  if(sql.includes('SUM(FeeBilled)'))return [[{TotalFee:0}]];
  if(sql.startsWith('UPDATE procedurelog')){fees.push(args);return [{affectedRows:1}];}
  if(sql.startsWith('UPDATE claimproc SET FeeBilled'))return [{affectedRows:1}];
  if(sql.startsWith('UPDATE claim SET')){assert.ok(sql.includes('ClaimNum'),'must scope claim updates');return [{affectedRows:1}];}
  if(sql.startsWith('UPDATE patient SET BalTotal'))return [{affectedRows:1}];
  throw Error('Unexpected fixture query '+sql);
 }
 const connection={execute,query:async sql=>{events.push([sql,[]]);if(sql.startsWith('LOCK TABLES'))locked=true;if(sql==='UNLOCK TABLES')locked=false;return [[]];},release(){assert.equal(locked,false);}};
 return {pool:{execute,getConnection:async()=>connection},patients,procs,claimprocs,payments,splits,documents,history,events,fees,unrelated,
  hashes:async plan=>{hashCalls++;return plan.splits.map(()=>'synthetic-only');},get hashCalls(){return hashCalls;}};
}
