// SELECT-only identity check. Does not import, post, or modify an EOB.
import fs from 'node:fs/promises';
import path from 'node:path';
import {readDeltaTextDocument} from '../src/delta/textDocument.js';
import {parseDelta} from '../src/delta/parser.js';
import {diagnoseDeltaPatient} from '../src/delta/processor.js';
const file=process.argv[2];
if(!file||!file.toLowerCase().endsWith('.txt'))throw new Error('Usage: node scripts/inspect-delta-patient.mjs "D:\\SHARE\\INSURANCE CLAIM\\DELTA DENTAL\\ERRORS\\1279.txt"');
const parsed=parseDelta(readDeltaTextDocument(await fs.readFile(file)).extracted);
if(parsed.errors.length)throw new Error(parsed.errors.join('; '));
const {pool,closePool}=await import('../src/db.js');
try{
 for(const claim of parsed.claims)console.log(JSON.stringify({readOnly:true,claimNumber:claim.claimNumber,...await diagnoseDeltaPatient(pool,{claim,fileName:path.basename(file),claimsCount:parsed.claims.length})},null,2));
}catch{console.error('Không kiểm tra được. Chạy trên SERVER tại folder Bridge với .env hiện tại.');process.exitCode=1;}
finally{await closePool();}
