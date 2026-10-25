import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {agreeDeltaMoneyCell,readDeltaDocument} from './document.js';
import {parseDelta} from './parser.js';

const word=(text,extra={})=>({text,x:910,width:55,confidence:95,...extra});
const agree=(reads,words=[word('$0.71')])=>agreeDeltaMoneyCell(reads,words,1000,.908,.975);

test('Delta money cell accepts a complete crop corroborated by the independent whole-page word',()=>{
 assert.equal(agree(['$0.','$0.71','0']),'$0.71');
 assert.equal(agree(['0.71','','0']),'0.71');
 assert.equal(agree(['$0.00','','0'],[word('$0.00')]),'$0.00');
});

test('Delta money cell never guesses missing digits or ignores conflicting valid readings',()=>{
 for(const reads of [['$0.','0',''],['$0.71','$0.77',''],['$0.17','',''],['-$0.71','','']])assert.equal(agree(reads),null);
 for(const words of [[],[word('$0.71',{confidence:89})],[word('$0.71',{confidence:undefined})],[word('$0.71',{x:900})],[word('$0.71',{width:70})],[word('$0.71'),word('$0.71')],[word('$0.')],[word('$0.77')]])assert.equal(agree(['$0.71','','0'],words),null);
});

test('supplied Delta 423 scanned PDF reads small patient-pay cells and reconciles claim totals (optional private fixture)',{skip:!process.env.DELTA_CELL_TEST_PDF},async()=>{
 const {extracted}=await readDeltaDocument(await fs.readFile(process.env.DELTA_CELL_TEST_PDF),'423.pdf');
 const p=parseDelta(extracted);assert.deepEqual(p.errors,[]);assert.equal(p.pageCount,2);assert.equal(p.claimsCount,1);
 const c=p.claims[0];assert.equal(c.claimNumber,'20261515105668');assert.equal(c.date,'2026-06-10');assert.equal(c.headerPaidCents,55420);
 assert.deepEqual(c.printedTotals,[6300,6300,6300,0,5040,1260]);assert.equal(c.rawProcedures.length,4);
 assert.equal(c.paymentPayload.amount,'50.40');assert.equal(c.paymentPayload.checkNum,'');
 assert.deepEqual(c.paymentPayload.splits.map(s=>[s.code,s.date,s.amount]),[['D0220','2026-02-08','2.86'],['D0230','2026-02-08','47.54']]);
 assert.deepEqual(c.procedures.map(s=>[s.code,s.feeCents,s.patientDueCents]),[['D0220',2500,71],['D0230',3800,1189]]);
 assert.ok(p.warnings.some(s=>s.includes('554.20')));
});
