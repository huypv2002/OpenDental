const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const u = require('../lib/updater.cjs');
const manifest = (body = 'zip bytes') => ({ version:'1.0.9', sha256:crypto.createHash('sha256').update(body).digest('hex'), url:'https://github.com/huypv2002/OpenDental/releases/download/sms-electron-latest/LUK-Dental-SMS-Electron-update-v1.0.9-win-x64.zip' });
test('version comparison skips same/older releases and compares numeric components', () => {
  assert.equal(u.isNewer('1.0.10','1.0.9'),true);
  assert.equal(u.isNewer('1.0.8','1.0.8'),false);
  assert.equal(u.isNewer('1.0.7','1.0.8'),false);
  assert.throws(()=>u.isNewer('invalid','1.0.8'));
});
test('only the SMS release URL and a SHA256 checksum are accepted', () => {
  for(const url of ['https://example.com/update.zip','https://github.com/huypv2002/OpenDental/releases/download/sms-electron-latest/../other.zip'])
    assert.throws(()=>u.validateManifest({...manifest(),url}));
  assert.throws(()=>u.validateManifest({...manifest(),sha256:'bad'}));
});
test('missing channel is harmless, newer version is detected, errors stay errors', async () => {
  assert.equal(await u.checkUpdate('1.0.8',async()=>new Response('',{status:404})),null);
  assert.equal((await u.checkUpdate('1.0.8',async()=>Response.json(manifest()))).version,'1.0.9');
  assert.equal(await u.checkUpdate('1.0.9',async()=>Response.json(manifest())),null);
  await assert.rejects(u.checkUpdate('1.0.8',async()=>new Response('',{status:503})),/503/);
});
test('download must match checksum; rejected downloads leave no partial files', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sms-update-test-'));
  try {
    await assert.rejects(u.downloadUpdate(manifest(),dir,async()=>new Response('wrong')),/checksum/);
    assert.deepEqual(fs.readdirSync(dir),[]);
    const file=await u.downloadUpdate(manifest(),dir,async()=>new Response('zip bytes'));
    assert.equal(fs.readFileSync(file,'utf8'),'zip bytes');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('updates cannot interrupt a send, scheduled batch or pending manual draft',()=>{
  assert.equal(u.canInstall({busy:false,monitorBusy:false,pendingDraft:null}),true);
  for (const status of [{busy:true},{monitorBusy:true},{pendingDraft:{PatNum:1}}]) assert.equal(u.canInstall(status),false);
});
