import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {configureMetlife} from '../../scripts/configure-metlife.mjs';
test('existing Bridge configuration preserves DB/API settings, initializes blanks and is idempotent',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'metlife-config-'));
 try{
  const original='DB_NAME=existing_clinic\nAPI_TOKEN=existing-admin-token\nMETLIFE_API_TOKEN=\nMETLIFE_JOB_DIR=\n';await fs.writeFile(path.join(dir,'.env'),original);
  await configureMetlife(dir);const first=await fs.readFile(path.join(dir,'.env'),'utf8');assert.ok(first.includes('DB_NAME=existing_clinic'));assert.ok(first.includes('API_TOKEN=existing-admin-token'));assert.match(first,/METLIFE_API_TOKEN=[a-f0-9]{64}/);assert.match(first,/METLIFE_JOB_DIR=.+metlife-operations/);
  const c=JSON.parse(await fs.readFile(path.join(dir,'metlife-r5-connection.json'),'utf8'));assert.equal(c.token.length,64);
  await configureMetlife(dir);assert.equal(await fs.readFile(path.join(dir,'.env'),'utf8'),first);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
