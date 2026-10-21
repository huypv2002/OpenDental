// Read-only inspector: OCR/extraction and validation only. Never imports the DB module.
import fs from 'node:fs/promises';
import path from 'node:path';
import {readInsuranceDocument} from '../src/liberty/document.js';
import {parseLiberty} from '../src/liberty/parser.js';
import {validateLibertyForPosting} from '../src/liberty/validation.js';
const file=process.argv[2];
if(!file)throw new Error('Usage: node scripts/inspect-liberty-eob.mjs <file.pdf|jpg|jpeg|png> [--json <output.json>] [--text <output.txt>]');
const {extracted}=await readInsuranceDocument(await fs.readFile(file),path.basename(file));
const parsed=validateLibertyForPosting(parseLiberty(extracted),extracted);
for(const [flag,value] of [['--json',JSON.stringify(parsed,null,2)],['--text',parsed.text]]){
 const i=process.argv.indexOf(flag);if(i>=0){const out=process.argv[i+1];if(!out||path.resolve(out)===path.resolve(file))throw new Error('Output must be separate from the source.');await fs.writeFile(out,value,{flag:'wx',mode:0o600});}
}
console.log(JSON.stringify({readOnly:true,source:extracted.sourceFormat||'pdf',check:parsed.check,claims:parsed.claims.map(c=>({claimNumber:c.claimNumber,amount:c.paymentPayload.amount,date:c.paymentPayload.payDate,checkNum:c.paymentPayload.checkNum,note:c.paymentPayload.payNote,procedures:c.procedures.map(p=>({code:p.code,date:p.date,tooth:p.tooth,amount:p.benefitCents/100}))})),warnings:parsed.warnings},null,2));
