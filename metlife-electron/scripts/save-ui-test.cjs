const fixtureGroup=process.env.METLIFE_TEST_GROUP||'G123';
const fixtureClaim=process.env.METLIFE_TEST_CLAIM||'1234567890 99';
const {_electron:electron}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const http=require('node:http');
(async()=>{
 const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'luk-patient-ui-')),token='t'.repeat(64),bytes=process.env.METLIFE_SAMPLE_PDF?fs.readFileSync(process.env.METLIFE_SAMPLE_PDF):require('./synthetic-metlife.cjs')(),filename=process.env.METLIFE_SAMPLE_PDF?path.basename(process.env.METLIFE_SAMPLE_PDF):'SYNTHETIC.pdf',calls=[];
 fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
 const patient={PatNum:'99',FName:process.env.METLIFE_TEST_FIRST||'TEST',LName:process.env.METLIFE_TEST_LAST||'PERSON',Birthdate:'2000-01-01',insurance:[{SubscriberID:'TEST-001',GroupNum:fixtureGroup,CarrierName:'MetLife'}]};
 let duplicate=true,preparedPlan=null,scenario='verified';
 const tables={patient:[patient],document:[{DocNum:'55',PatNum:'99',FileName:filename,DocCategory:'18'}],definition:[{DefNum:'18',ItemName:'FINISHED CLAM'}],patplan:[{PatNum:'99',InsSubNum:'1'}],inssub:[{InsSubNum:'1',PlanNum:'1',Subscriber:'99'}],insplan:[{PlanNum:'1',CarrierNum:'1',GroupNum:fixtureGroup}],carrier:[{CarrierNum:'1',CarrierName:'MetLife'}],procedurelog:[{ProcNum:'101',PatNum:'99',CodeNum:'1',ProvNum:'3',ClinicNum:'0',ProcStatus:2,ProcDate:'2026-09-13',ToothNum:'',ProcFee:'100.00'},{ProcNum:'102',PatNum:'99',CodeNum:'2',ProvNum:'3',ClinicNum:'0',ProcStatus:2,ProcDate:'2026-09-13',ToothNum:'',ProcFee:'120.00'},{ProcNum:'103',PatNum:'99',CodeNum:'3',ProvNum:'3',ClinicNum:'0',ProcStatus:2,ProcDate:'2026-09-13',ToothNum:'',ProcFee:'222.00'}],procedurecode:[{CodeNum:'1',ProcCode:'D0150',Descript:'Exam'},{CodeNum:'2',ProcCode:'D1110',Descript:'Prophy'},{CodeNum:'3',ProcCode:'D0210',Descript:'FMX'}],provider:[{ProvNum:'3',Abbr:'DOC'}],payment:[{PayNum:'99',PayAmt:'442.00',PayDate:'2026-09-17'}],paysplit:[],claim:[],claimproc:[],claimpayment:[]};
 const server=http.createServer(async(req,res)=>{
  calls.push(req.url);if(req.headers.authorization!=='Bearer '+token&&req.headers['x-luk-desktop']!=='metlife'){res.writeHead(401);return res.end('{}');}
  const url=new URL(req.url,'http://localhost');let data;
  if(url.pathname==='/api/metlife/operations'&&req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;const parsed=JSON.parse(body);assert.equal(parsed.transport,'direct-db');preparedPlan={...parsed.draft,paymentTypeDefNum:'10',mode:'save-authorized'};data={operationId:'11111111-1111-4111-8111-111111111111',plan:preparedPlan};
  }
  else if(url.pathname.endsWith('/post'))data={posted:true,payNum:'777'};
  else if(url.pathname.endsWith('/verify'))data=scenario==='verified'?{verified:true,payNum:'777',splitNums:['1','2','3'],amount:'442.00'}:{verified:false,reason:'fixture uncertain'};
  else if(url.pathname.endsWith('/abort'))data={released:false};
  else if(/^\/api\/metlife\/operations\/[^/]+$/.test(url.pathname))data={state:'unverified',transport:'direct-db'};
  else if(url.pathname.endsWith('/diagnostics/database'))data={readOnly:true,capturedAt:new Date().toISOString(),ready:false,schemaProblems:['payment dùng MyISAM; adapter hiện cần InnoDB.'],configurationProblems:[],tables:[{TABLE_NAME:'payment',ENGINE:'MyISAM'}],columns:[],preferences:[],limitations:[]};
  else if(url.pathname.endsWith('/health'))data={db:true};
  else if(url.pathname==='/api/metlife/patients')data={patients:[patient,{...patient,PatNum:'1279',FName:'OTHER'}],page:0,hasMore:false};
  else if(url.pathname.endsWith('/99/documents'))data={documents:[{DocNum:'55',PatNum:'99',FileName:filename,Description:'Test document',DateCreated:'2026-09-17'}]};
  else if(url.pathname.endsWith('/99/pending'))data={pending:false};
  else if(url.pathname.endsWith('/99/context'))data={readOnly:true,capturedAt:new Date().toISOString(),patNum:'99',warnings:[],tables:{...tables,payment:duplicate?tables.payment:[]}};
  else if(url.pathname.endsWith('/99/documents/55/pdf')){res.writeHead(200,{'Content-Type':'application/pdf'});return res.end(bytes);}
  else {res.writeHead(404);return res.end('{}');}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const pairing=path.join(temp,'connection.json');fs.writeFileSync(pairing,JSON.stringify({url,token}));
 const a=await electron.launch({env:{...process.env,METLIFE_SERVER_URL:url},args:[root,`--user-data-dir=${temp}/userdata`],...(process.env.METLIFE_ELECTRON_PATH?{executablePath:process.env.METLIFE_ELECTRON_PATH}:{}),timeout:30000});
 try{
  const page=await a.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('#patient-search-query');
  await page.waitForFunction(()=>document.querySelector('#server-status').textContent.startsWith('Đã kết nối'));
  await page.click('[data-tab="patients"]');await page.selectOption('#patient-search-kind','groupNumber');await page.fill('#patient-search-query',fixtureGroup);await page.click('#search-patients');
  await page.waitForSelector('[data-patient="99"]');assert.equal(await page.locator('#patient-results tr').count(),2);
  await page.screenshot({path:path.join(root,'test-results/patient-search.png')});
  await page.click('[data-patient="99"]');await page.waitForSelector('[data-document="55"]');assert.match(await page.locator('#documents-patient').innerText(),/99/);
  await page.screenshot({path:path.join(root,'test-results/patient-documents.png')});
  await page.click('[data-document="55"]');await page.waitForFunction(()=>document.querySelector('#count-total').textContent==='1');
  assert.equal(await page.locator('#detail table:first-of-type tbody tr').count(),7);assert.equal(await page.locator('.note-preview').innerText(),`group number : ${fixtureGroup}`);
  assert.match(await page.locator('#detail').innerText(),/trùng/);assert.equal(await page.locator('#count-snapshots').textContent(),'1');
  assert.ok(calls.includes('/api/metlife/patients/99/context'));assert.ok(calls.includes('/api/metlife/patients/99/documents/55/pdf'));
  await page.screenshot({path:path.join(root,'test-results/direct-db-review.png')});
  await page.click('[data-view="pdf"]');await page.waitForFunction(()=>document.querySelectorAll('canvas').length===2);
  // No OD or real payments: stub the Windows adapter in Electron's main process.
  duplicate=false;await page.click('[data-tab="patients"]');await page.click('[data-document="55"]');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')!=='true');
  await a.evaluate(async(_electron,root)=>{
   const {createRequire}=process.getBuiltinModule('module');const require=createRequire(root+'/package.json');globalThis.odTestActions=[];
   require('./lib/windows.cjs').runWindows=async(_resources,request)=>{globalThis.odTestActions.push(request.action);return {ok:true,windowHandle:'999',paymentTypeApplied:true,splitsApplied:true,saveInvoked:request.action==='save-preview'};};
  },root);
  const save=page.locator('[data-action="save-payment"]');
  assert.equal(await page.locator('#detail table:nth-of-type(2) tbody tr').count(),3);
  await save.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'test-results/direct-db-splits.png')});
  assert.equal(await save.isEnabled(),true);await save.click();
  await page.waitForFunction(()=>document.querySelector('#status-text').textContent.includes('Đã lưu và xác minh'));
  assert.deepEqual(await a.evaluate(()=>globalThis.odTestActions),[]);
  assert.equal(preparedPlan.paymentType,'Insurance Paid');assert.equal(preparedPlan.splits.length,3);assert.equal(preparedPlan.note,`group number : ${fixtureGroup}`);
  assert.ok(calls.findIndex(x=>x.endsWith('/post'))<calls.findIndex(x=>x.endsWith('/verify')));
  // Uncertain readback keeps a pending journal and blocks another Save.
  scenario='uncertain';assert.equal(await save.isEnabled(),true);await save.click();
  await page.waitForFunction(()=>!document.querySelector('#pending-save-banner').hidden);
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')!=='true');
  assert.equal(await save.isDisabled(),true);assert.match(await page.locator('#status-text').innerText(),/không lưu lại/i);
  assert.ok(fs.existsSync(path.join(temp,'userdata','pending-save.json')));
  scenario='verified';await page.click('#verify-save');await page.waitForFunction(()=>document.querySelector('#pending-save-banner').hidden).catch(async e=>{console.error('Recovery status:',await page.locator('#status-text').innerText(), 'Calls:',calls);throw e;});assert.ok(!fs.existsSync(path.join(temp,'userdata','pending-save.json')));
  assert.equal(await page.locator('[data-action="fill-preview"]').count(),0);await page.click('[data-tab="settings"]');assert.match(await page.locator('#settings').innerText(),/Hướng dẫn/);
  for(const tab of ['patients','queue','settings','activity']){await page.click(`[data-tab="${tab}"]`);assert.doesNotMatch(await page.locator('body').innerText(),/\b(DB|SQL|JSON|schema|SERVER|Bridge|ProcNum|DocNum|PlanNum|InsSubNum|InnoDB|MyISAM|snapshot|OCR|Electron)\b/i);}
  assert.deepEqual(errors,[]);console.log('Direct save UI passed: synthetic PDF, detailed review, post request, zero Windows automation calls, verified readback, uncertain journal and retry block. Simulated SERVER; no clinic writes.');
 }finally{await a.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
