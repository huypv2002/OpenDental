// Deterministic packaging conversion of the existing tool icon. No new branding.
const {app,nativeImage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
app.whenReady().then(()=>{
 const assets=path.join(__dirname,'..','assets');
 const original=nativeImage.createFromPath(path.join(assets,'tooth.ico'));
 if(original.isEmpty())throw new Error('Cannot read the existing tool icon.');
 const icon=original.resize({width:256,height:256,quality:'best'});
 fs.writeFileSync(path.join(assets,'tooth-256.png'),icon.toPNG());
 console.log('Existing tooth icon prepared at 256x256 for Windows packaging.');app.quit();
}).catch(e=>{console.error(e.message);app.exit(1);});
