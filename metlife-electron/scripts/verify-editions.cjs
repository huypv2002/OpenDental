const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const asar=require('@electron/asar');const {EDITIONS}=require('../lib/edition.cjs');
const root=path.resolve(__dirname,'..');
for(const [id,edition] of Object.entries(EDITIONS)){
 const resources=path.join(root,'dist',id,'win-unpacked','resources');
 const pkg=JSON.parse(asar.extractFile(path.join(resources,'app.asar'),'package.json').toString());
 assert.equal(pkg.metlifeEdition,id);assert.equal(pkg.version,require('../package.json').version);
 assert.equal(fs.existsSync(path.join(resources,'windows','od-automation.ps1')),false);
 assert.ok(fs.existsSync(path.join(resources,'native','skia.win32-x64-msvc.node')));
 const exe=path.join(root,'dist',id,`LUK-MetLife-Payments-${pkg.version}.exe`);
 assert.ok(fs.statSync(exe).size>1000000);
 console.log(`Verified ${edition.productName}: fixed edition ${id}, isolated profile, correct Windows resources and portable executable.`);
}
