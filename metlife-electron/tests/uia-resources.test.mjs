import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
test('pinned UIA3 libraries are intact and included in packaged Windows resources',async()=>{
 const manifest=JSON.parse(await fs.readFile(new URL('windows/uia3/manifest.json',root),'utf8'));
 assert.equal(manifest.package,'UIAComWrapper');
 assert.equal(Object.keys(manifest.files).length,2);
 for(const [name,sha] of Object.entries(manifest.files)){
  assert.match(name,/^[A-Za-z.]+\.dll$/);
  const bytes=await fs.readFile(new URL('windows/uia3/'+name,root));
  assert.equal(bytes.subarray(0,2).toString(),'MZ');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),sha);
 }
 assert.match(await fs.readFile(new URL('windows/uia3/LICENSE.txt',root),'utf8'),/Microsoft Public License/);
 const pkg=JSON.parse(await fs.readFile(new URL('package.json',root),'utf8'));
 const windows=pkg.build.extraResources.find(r=>r.from==='windows');
 assert.ok(windows.filter.includes('uia3/**'));
});
