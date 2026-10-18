import {test} from 'node:test';
import assert from 'node:assert/strict';
import {databaseDiagnostics,postingTables} from './databaseDiagnostics.js';
import {paymentRows} from './directPayment.js';
test('diagnostics reads metadata only and distinguishes schema from SERVER configuration',async()=>{
 const rows=paymentRows({splits:[{}]},'7','0'),calls=[];
 const columns=Object.entries({payment:rows.payment,paysplit:{...rows.splits[0],PayNum:1}}).flatMap(([t,row])=>[...Object.keys(row),'DateEntry',t==='payment'?'PayNum':'SplitNum'].map(k=>({TABLE_NAME:t,COLUMN_NAME:k,COLUMN_DEFAULT:null,IS_NULLABLE:'NO',EXTRA:k===(t==='payment'?'PayNum':'SplitNum')?'auto_increment':''})));
 const pool={execute:async(sql,args)=>{calls.push(sql);if(sql.includes('INFORMATION_SCHEMA.TABLES'))return [postingTables.map(t=>({TABLE_NAME:t,ENGINE:t==='payment'?'MyISAM':'InnoDB'}))];if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [columns];if(sql.includes('FROM preference'))return [[{PrefName:'ProgramVersion',ValueString:'24.4'}]];throw Error('Unexpected query');}};
 const result=await databaseDiagnostics(pool,{enabled:()=>false});
 assert.equal(result.readOnly,true);assert.equal(result.schemaCompatible,false);assert.equal(result.writeConfigured,false);assert.ok(result.schemaProblems.some(p=>p.includes('MyISAM')));assert.equal(result.configurationProblems.length,1);
 assert.ok(calls.every(sql=>sql.startsWith('SELECT ')));assert.ok(!calls.some(sql=>/FROM (patient|payment|paysplit)\b/.test(sql)));assert.ok(calls.every(sql=>!/password|token/i.test(sql)));
});
