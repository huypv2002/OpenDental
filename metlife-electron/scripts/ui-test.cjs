const fixtureGroup=process.env.METLIFE_TEST_GROUP||'G123';
const fixtureClaim=process.env.METLIFE_TEST_CLAIM||'1234567890 99';
const { _electron:electron }=require('playwright');
const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');
(async()=>{
 const root=path.join(__dirname,'..');const temp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'luk-metlife-ui-'));fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
 const a=await electron.launch({args:[root,`--user-data-dir=${temp}`],...(process.env.METLIFE_ELECTRON_PATH?{executablePath:process.env.METLIFE_ELECTRON_PATH}:{}),timeout:30000});const errors=[];
 try{
  const page=await a.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.querySelector('#status-text').textContent.includes('Sẵn sàng'));
  assert.equal(await page.locator('nav [data-tab]').count(),4);
  assert.equal(await page.locator('#count-total').textContent(),'0');
  await page.screenshot({path:path.join(root,'test-results/empty.png')});
  await a.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
  await page.click('[data-tab="queue"]');
  await page.click('#import-snapshot');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')!=='true');
  assert.match(await page.locator('#status-text').innerText(),/Chưa nạp thêm snapshot OD/);
  assert.equal(await page.locator('#count-snapshots').textContent(),'0');
  const invalid=path.join(temp,'invalid-snapshot.json');fs.writeFileSync(invalid,'{}');
  await a.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},invalid);
  await page.click('#import-snapshot');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')!=='true');
  assert.match(await page.locator('#status-text').innerText(),/Không nạp được snapshot OD/);
  assert.equal(await page.locator('#count-snapshots').textContent(),'0');
  if(process.env.METLIFE_SAMPLE_PDF){
   await a.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},process.env.METLIFE_SAMPLE_PDF);
   await page.click('#import-pdf');await page.waitForFunction(()=>document.querySelector('#count-total').textContent==='1');
   assert.equal(await page.locator('#detail tbody tr').count(),7);
   assert.match(await page.locator('#detail').innerText(),/\$442\.00/);
   assert.ok((await page.locator('#detail').innerText()).includes(fixtureClaim));
   assert.equal(await page.locator('.note-preview').innerText(),`group number : ${fixtureGroup}`);
   assert.match(await page.locator('#detail').innerText(),/Insurance Paid/);
   assert.ok((await page.locator('#detail').innerText()).includes('đã đọc được Group Number '+fixtureGroup));
   assert.equal(await page.locator('[data-action="fill-preview"]').isDisabled(),true);
   await page.screenshot({path:path.join(root,'test-results/metlife-review.png')});
   await page.click('[data-view="pdf"]');await page.waitForSelector('canvas');
   await page.waitForFunction(()=>document.querySelectorAll('canvas').length===2);
   await page.screenshot({path:path.join(root,'test-results/pdf-view.png')});
   await page.click('[data-view="source"]');assert.match(await page.locator('.text-source').innerText(),/Payment Detail/);
   // Import the same bytes twice does not add another queue item.
   await page.click('#import-pdf');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')!=='true');
   assert.equal(await page.locator('#count-total').textContent(),'1');
   await page.click('[data-view="review"]');await page.fill('#search','unmatched-file');assert.equal(await page.locator('.file-card').count(),0);await page.fill('#search','');
  }
  await page.click('[data-tab="settings"]');assert.equal(await page.inputValue('#payment-type'),'Insurance Paid');assert.equal(await page.inputValue('#note-template'),'group number : {group}');await page.fill('#note-template','MetLife Claim {claim} | Group {group}');await page.click('#save-settings');
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')!=='true');
  await page.click('[data-tab="queue"]');if(process.env.METLIFE_SAMPLE_PDF)assert.equal(await page.locator('.note-preview').innerText(),`group number : ${fixtureGroup}`);
  await page.click('[data-tab="activity"]');assert.ok(await page.locator('.event').count()>0);
  assert.deepEqual(errors,[]);console.log('Electron UI passed: launch, real PDF import, 7 rows, PDF canvas, duplicate import, filtering, settings, activity, no renderer errors.');
 }finally{await a.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
