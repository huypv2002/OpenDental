const {_electron:electron}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const http=require('node:http');
(async()=>{
 const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'luk-login-ui-'));let logins=0,health=0;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/metlife/connect'){
   let body='';for await(const c of req)body+=c;const input=JSON.parse(body);logins++;
   if(input.password!=='test-only-password'){res.writeHead(401);return res.end(JSON.stringify({ok:false,error:'Login rejected'}));}
   return res.end(JSON.stringify({ok:true,data:{token:'x'.repeat(64)}}));
  }
  if(req.url==='/api/metlife/health'&&req.headers.authorization==='Bearer '+'x'.repeat(64)){health++;return res.end(JSON.stringify({ok:true,data:{db:true}}));}
  res.writeHead(401);res.end(JSON.stringify({ok:false,error:'Unauthorized'}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const launch=()=>electron.launch({args:[root,`--user-data-dir=${temp}`],...(process.env.METLIFE_ELECTRON_PATH?{executablePath:process.env.METLIFE_ELECTRON_PATH}:{}),timeout:30000});
 let app;
 try{
  app=await launch();let page=await app.firstWindow();await page.waitForSelector('#connect-server');
  await page.click('#connect-server');await page.fill('#server-url',`http://127.0.0.1:${server.address().port}`);await page.fill('#server-username','test-admin');await page.fill('#server-password','wrong');await page.click('#login-server');
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Login rejected');assert.equal(await page.inputValue('#server-password'),'');
  await page.fill('#server-password','test-only-password');await page.click('#login-server');await page.waitForFunction(()=>document.querySelector('#server-status').textContent.startsWith('Đã kết nối'));
  assert.equal(await page.locator('#server-login').isVisible(),false);assert.equal(logins,2);await app.close();app=null;
  app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>document.querySelector('#server-status').textContent.startsWith('Đã kết nối'));
  assert.equal(logins,2);assert.ok(health>=2);console.log('Login UI: rejected password, successful sign-in, cleared password, persisted encrypted session and automatic reconnect passed.');
 }finally{if(app)await app.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
