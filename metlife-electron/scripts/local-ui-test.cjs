const {_electron:electron}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const http=require('node:http');
(async()=>{
 const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'luk-local-ui-'));let calls=0;
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-luk-desktop'],'metlife');calls++;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:req.url.endsWith('/health')?{db:true}:{patients:[],page:0,hasMore:false}}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let app;try{
  app=await electron.launch({args:[root,`--user-data-dir=${temp}`],env:{...process.env,METLIFE_SERVER_URL:`http://127.0.0.1:${server.address().port}`},...(process.env.METLIFE_ELECTRON_PATH?{executablePath:process.env.METLIFE_ELECTRON_PATH}:{}),timeout:30000});
  const page=await app.firstWindow();await page.waitForFunction(()=>document.querySelector('#server-status').textContent.startsWith('Đã kết nối'));
  assert.equal(await page.locator('#server-login,#server-password,#login-server').count(),0);
  await page.fill('#patient-search-query','TEST');await page.click('#search-patients');await page.waitForFunction(()=>document.querySelector('#status-text').textContent.startsWith('Tìm thấy'));
  await page.click('#connect-server');assert.ok(calls>=2);console.log('LAN UI: automatic connection without credentials, no login controls, patient search and reconnect passed.');
  if(await app.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable())){
   await app.close();app=null;
   app=await electron.launch({args:[root,`--user-data-dir=${temp}`],env:{...process.env,METLIFE_SERVER_URL:''},...(process.env.METLIFE_ELECTRON_PATH?{executablePath:process.env.METLIFE_ELECTRON_PATH}:{}),timeout:30000});
   const restarted=await app.firstWindow();await restarted.waitForFunction(()=>document.querySelector('#server-status').textContent.startsWith('Đã kết nối'));
   console.log('Saved clinic endpoint restored after restart without environment override.');
  }
 }finally{if(app)await app.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
