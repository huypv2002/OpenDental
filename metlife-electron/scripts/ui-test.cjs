// Exercise the current audit dashboard with a local synthetic Bridge only.
const {_electron:electron}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
(async()=>{
 const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'insurance-ui-')),calls=[];
 let scans=0;
 const items=['MetLife','LIBERTY Dental Plan','CIGNA','DELTA DENTAL'].map((carrier,i)=>({Id:i+1,FileName:`TEST_${i+1}.txt`,PatientName:'TEST PERSON',PatNum:900+i,ClaimNumber:`TESTCLAIM${i+1}`,TotalAmount:'10.00',PayNum:100+i,DocNum:200+i,Status:'SUCCESS',ProcessedAt:'2026-10-28 12:00:00',Details:JSON.stringify({carrier,paymentDate:'2026-10-28',procedures:[{code:'D1110',date:'2026-04-28',benefitCents:1000,feeCents:1500}],insuranceDefaults:{claimNums:[]}})}));
 items.push({Id:5,FileName:'REVIEW.txt',PatientName:'TEST REVIEW',Status:'REVIEW',TotalAmount:'0.00',Message:'Cần đối chiếu tài liệu gốc.'});
 const server=http.createServer((req,res)=>{
  calls.push([req.url,req.method]);let data;
  if(req.url.endsWith('/health'))data={db:true};
  else if(req.url.endsWith('/status'))data={isScanning:false,counts:{errors:0,review:1,processed:4},uptimeSeconds:10};
  else if(req.url.includes('/history'))data={items};
  else if(req.url.endsWith('/documents'))data={documents:[{DocNum:'500',PatNum:'900',FileName:'TEST_EOB.txt',Description:'Synthetic Finished Claim'}]};
  else if(req.url.endsWith('/pending'))data={pending:false};
  else if(req.url.includes('/patients?'))data={patients:[{PatNum:'900',FName:'TEST',LName:'PERSON',insurance:[]}],page:0,hasMore:false};
  else if(req.url.endsWith('/scan'))data=scans++===0?{status:'busy'}:{status:'completed',count:0,results:[]};
  else if(req.url.endsWith('/retry-errors'))data={movedCount:0};
  else{res.writeHead(404);res.end('{}');return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));let app;
 try{
  app=await electron.launch({args:[root,`--user-data-dir=${temp}`,'--metlife-edition=payments'],env:{...process.env,METLIFE_SERVER_URL:`http://127.0.0.1:${server.address().port}`},...(process.env.METLIFE_ELECTRON_PATH?{executablePath:process.env.METLIFE_ELECTRON_PATH}:{}),timeout:30000});
  const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===5);assert.equal(await page.locator('nav [data-tab]').count(),3);assert.equal(await page.locator('#stat-success').innerText(),'4');console.log('PASS UI-01: dashboard shows 4 carrier successes and one REVIEW.');
  const detail=await page.locator('#history-detail-content').innerText();assert.doesNotMatch(detail,/Khớp đúng|Không bị âm tiền|\$\$/);assert.match(detail,/Xem số dư hiện tại/);console.log('PASS UI-02: no invented zero balance or linked OD claim.');
  await page.click('[data-filter="failed"]');assert.equal(await page.locator('.history-row').count(),1);assert.match(await page.locator('#history-detail-content').innerText(),/Cần đối chiếu/);console.log('PASS UI-03: REVIEW is distinct from success.');
  await page.click('[data-filter="all"]');await page.fill('#history-search','TESTCLAIM3');assert.equal(await page.locator('.history-row').count(),1);console.log('PASS UI-04: history search selects the correct claim.');
  await page.click('[data-tab="patients"]');await page.fill('#patient-search-query','900');await page.click('#search-patients');await page.waitForFunction(()=>document.querySelectorAll('#patient-results tr').length===1);assert.match(await page.locator('#patient-results').innerText(),/900/);await page.click('#patient-results tr');await page.waitForFunction(()=>document.querySelector('#patient-documents').textContent.includes('TEST_EOB.txt'));console.log('PASS UI-05: patient lookup and Finished Claims reach synthetic Bridge.');
  await page.click('[data-tab="diagnostics"]');await page.waitForFunction(()=>document.querySelector('#diag-conn-status').textContent.includes('hoạt động'));console.log('PASS UI-06: current connection diagnostics shown.');
  await page.click('#header-scan-btn');await page.waitForFunction(()=>!document.querySelector('#header-scan-btn').disabled);assert.match(await page.locator('#toast').innerText(),/đang xử lý lượt quét trước/);await page.click('#header-scan-btn');await page.waitForFunction(()=>!document.querySelector('#header-scan-btn').disabled);assert.equal(await page.locator('#error-badge-count').innerText(),'1');await page.click('#header-retry-btn');await page.waitForFunction(()=>!document.querySelector('#header-retry-btn').disabled);
  assert.ok(calls.some(([u,m])=>u.endsWith('/scan')&&m==='POST'));assert.ok(calls.some(([u,m])=>u.endsWith('/retry-errors')&&m==='POST'));assert.ok(!calls.some(([u])=>/operations|payment|sms|send/.test(u)));assert.deepEqual(errors,[]);
  if(process.env.INSURANCE_UI_SCREENSHOT){await page.click('[data-tab="dashboard"]');await page.screenshot({path:process.env.INSURANCE_UI_SCREENSHOT,fullPage:true});}
  console.log('PASS UI-07: explicit scan/retry work; no payment/SMS endpoint called.');
  console.log('7 UI cases passed on a local synthetic server. Real Windows not verified.');
 }finally{if(app)await app.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
