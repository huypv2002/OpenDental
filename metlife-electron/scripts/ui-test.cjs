const {_electron:electron}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
async function checkEdition(edition){
 const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'luk-metlife-customer-'));fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
 const a=await electron.launch({args:[root,`--user-data-dir=${temp}`,`--metlife-edition=${edition}`],...(process.env.METLIFE_ELECTRON_PATH?{executablePath:process.env.METLIFE_ELECTRON_PATH}:{}),timeout:30000});
 try{const page=await a.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('#patient-search-query');
  assert.equal(await page.locator('nav [data-tab]').count(),4);assert.match(await page.locator('#edition-label').innerText(),/Thanh toán MetLife/);
  assert.equal(await a.evaluate(({Menu})=>Menu.getApplicationMenu()),null);
  for(const tab of ['patients','queue','settings','activity']){await page.click(`[data-tab="${tab}"]`);assert.doesNotMatch(await page.locator('body').innerText(),/\b(DB|SQL|JSON|schema|SERVER|Bridge|ProcNum|DocNum|PlanNum|InsSubNum|InnoDB|MyISAM|snapshot|OCR|Electron)\b/i);}
  assert.equal(await page.locator('#inspect-db,#inspect-od,#import-snapshot,#import-server-connection,[data-view="source"]').count(),0);
  assert.deepEqual(errors,[]);console.log('Customer UI passed: business workflow and guide; no technical tools or implementation details.');
 }finally{await a.close();fs.rmSync(temp,{recursive:true,force:true});}
}
(async()=>{for(const id of ['payments'])await checkEdition(id);})().catch(e=>{console.error(e);process.exitCode=1;});
