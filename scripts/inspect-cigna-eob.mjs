// Reads the supplied PDF only. Never imports a DB connection or posts a payment.
import fs from 'node:fs/promises';
import {extractPdf} from '../src/metlife/parser.js';
import {parseCigna} from '../src/cigna/parser.js';
const file=process.argv[2];
if(!file)throw new Error('Usage: node scripts/inspect-cigna-eob.mjs <file.pdf>');
const p=parseCigna(await extractPdf(await fs.readFile(file)));
console.log(JSON.stringify({readOnly:true,carrier:p.carrier,settlementBasis:p.settlementBasis,claims:p.claims.map(c=>({claim:c.claimNumber,patient:c.patient.raw,headerPaidCents:c.headerPaidCents,payload:c.paymentPayload})),errors:p.errors,warnings:p.warnings},null,2));
if(p.errors.length)process.exitCode=1;
