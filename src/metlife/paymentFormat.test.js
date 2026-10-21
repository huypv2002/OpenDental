import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claimPaymentFields,metlifePaymentFields,claimDocumentFields} from './paymentFormat.js';
import {documentInsert} from './documentImport.js';

test('MetLife posts Processed date and claim-only note while leaving check empty',()=>{
 const p={claimRaw:'1234567890 99',processed:'2026-09-29',received:'2026-09-22',payment:{date:'2026-09-24'}};
 assert.deepEqual(metlifePaymentFields(p),{claimNumber:'1234567890 99',date:'2026-09-29',checkNum:'',note:'Claim number: 1234567890 99'});
 assert.throws(()=>metlifePaymentFields({...p,processed:null}),/PROCESSED/);
 assert.throws(()=>metlifePaymentFields({...p,processed:'2026-02-30'}),/ngày/);
});

test('Liberty uses the same blank check and claim note with its check date',()=>{
 assert.deepEqual(claimPaymentFields('7001','2026-10-07'),{claimNumber:'7001',date:'2026-10-07',checkNum:'',note:'Claim number: 7001'});
});

test('Imaging date and description yield date, claim number and exact amount',()=>{
 assert.deepEqual(claimDocumentFields('1234567890 99','2026-09-29',43920),{dateCreated:'2026-09-29 00:00:00',description:'Claim 1234567890 99  439.20'});
 assert.throws(()=>claimDocumentFields('7001','2026-10-07',NaN));
});

test('strict Document schema receives supported defaults, mount zero and rejects unknown required fields',()=>{
 const fields={DocCategory:55,PatNum:99,FileName:'TEST.pdf',Description:'Claim TEST  35.00',DateCreated:'2026-09-29 00:00:00'};
 const columns=[{COLUMN_NAME:'DocNum',EXTRA:'auto_increment'},...Object.keys(fields).concat(['ImgType','MountItemNum','Note','RawBase64','ExternalSource','ImageCaptureType']).map(COLUMN_NAME=>({COLUMN_NAME,IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:''})),{COLUMN_NAME:'DateTStamp',IS_NULLABLE:'NO',COLUMN_DEFAULT:'CURRENT_TIMESTAMP',EXTRA:''}];
 const s=documentInsert(fields,columns),names=[...s.sql.matchAll(/`(\w+)`/g)].map(m=>m[1]);
 const row=Object.fromEntries(names.map((n,i)=>[n,s.values[i]]));
 assert.equal(row.MountItemNum,0);assert.equal(row.ImgType,0);assert.equal(row.RawBase64,'');assert.equal(row.ExternalSource,'None');assert.equal(row.DateCreated,fields.DateCreated);
 assert.throws(()=>documentInsert(fields,[...columns,{COLUMN_NAME:'FutureRequired',IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:''}]),/FutureRequired/);
});
