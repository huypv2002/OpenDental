const fixtureGroup=process.env.METLIFE_TEST_GROUP||'G123';
const fixtureClaim=process.env.METLIFE_TEST_CLAIM||'1234567890 99';
const {_electron:electron}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const http=require('node:http');
(async()=>{
 if(!process.env.METLIFE_SAMPLE_PDF)throw Error('Set METLIFE_SAMPLE_PDF for this integration test');
 const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'luk-patient-ui-')),token='t'.repeat(64),bytes=fs.readFileSync(process.env.METLIFE_SAMPLE_PDF),filename=path.basename(process.env.METLIFE_SAMPLE_PDF),calls=[];
 const patient={PatNum:'99',FName:process.env.METLIFE_TEST_FIRST||'TEST',LName:process.env.METLIFE_TEST_LAST||'PERSON',Birthdate:'2000-01-01',insurance:[{SubscriberID:'TEST-001',GroupNum:fixtureGroup,CarrierName:'MetLife'}]};
 const tables={patient:[patient],document:[{DocNum:'55',PatNum:'99',FileName:filename,DocCategory:'18'}],definition:[{DefNum:'18',ItemName:'FINISHED CLAM'}],patplan:[{PatNum:'99',InsSubNum:'1'}],inssub:[{InsSubNum:'1',PlanNum:'1',Subscriber:'99'}],insplan:[{PlanNum:'1',CarrierNum:'1',GroupNum:fixtureGroup}],carrier:[{CarrierNum:'1',CarrierName:'MetLife'}],procedurelog:[],procedurecode:[],payment:[{PayNum:'99',PayAmt:'442.00',PayDate:'2026-09-17'}],paysplit:[],claim:[],claimproc:[],claimpayment:[]};
 const server=http.createServer((req,res)=>{
  calls.push(req.url);if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);return res.end('{}');}
  const url=new URL(req.url,'http://localhost');let data;
  if(url.pathname.endsWith('/health'))data={db:true};
  else if(url.pathname==='/api/metlife/patients')data={patients:[patient,{...patient,PatNum:'1279',FName:'OTHER'}],page:0,hasMore:false};
  else if(url.pathname.endsWith('/99/documents'))data={documents:[{DocNum:'55',PatNum:'99',FileName:filename,Description:'Test document',DateCreated:'2026-09-17'}]};
  else if(url.pathname.endsWith('/99/pending'))data={pending:false};
  else if(url.pathname.endsWith('/99/context'))data={readOnly:true,capturedAt:new Date().toISOString(),patNum:'99',warnings:[],tables};
  else if(url.pathname.endsWith('/99/documents/55/pdf')){res.writeHead(200,{'Content-Type':'application/pdf'});return res.end(bytes);}
  else {res.writeHead(404);return res.end('{}');}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const pairing=path.join(temp,'connection.json');fs.writeFileSync(pairing,JSON.stringify({url,token}));
 const a=await electron.launch({args:[root,`--user-data-dir=${temp}/userdata`],...(process.env.METLIFE_ELECTRON_PATH?{executablePath:process.env.METLIFE_ELECTRON_PATH}:{}),timeout:30000});
 try{
  const page=await a.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('#patient-search-query');
  await a.evaluate(({dialog,safeStorage},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});safeStorage.isEncryptionAvailable=()=>true;safeStorage.encryptString=s=>Buffer.from(s);safeStorage.decryptString=b=>b.toString();},pairing);
  await page.click('#connect-server');await page.waitForFunction(()=>document.querySelector('#server-status').textContent.startsWith('Đã kết nối'));
  await page.selectOption('#patient-search-kind','groupNumber');await page.fill('#patient-search-query',fixtureGroup);await page.click('#search-patients');
  await page.waitForSelector('[data-patient="99"]');assert.equal(await page.locator('#patient-results tr').count(),2);
  await page.screenshot({path:path.join(root,'test-results/patient-search.png')});
  await page.click('[data-patient="99"]');await page.waitForSelector('[data-document="55"]');assert.match(await page.locator('#documents-patient').innerText(),/99/);
  await page.screenshot({path:path.join(root,'test-results/patient-documents.png')});
  await page.click('[data-document="55"]');await page.waitForFunction(()=>document.querySelector('#count-total').textContent==='1');
  assert.equal(await page.locator('#detail tbody tr').count(),7);assert.equal(await page.locator('.note-preview').innerText(),`group number : ${fixtureGroup}`);
  assert.match(await page.locator('#detail').innerText(),/trùng/);assert.equal(await page.locator('#count-snapshots').textContent(),'1');
  assert.ok(calls.includes('/api/metlife/patients/99/context'));assert.ok(calls.includes('/api/metlife/patients/99/documents/55/pdf'));
  await page.click('[data-view="pdf"]');await page.waitForFunction(()=>document.querySelectorAll('canvas').length===2);
  assert.deepEqual(errors,[]);console.log('Patient flow passed: one-time connection, group search with 2 patients, scoped Finished Claims, PDF selection, automatic live context, duplicate block, 2-page viewer.');
 }finally{await a.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
