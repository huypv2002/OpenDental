import {DEFAULT_CONFIG,loadConfig} from '../lib/config.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMetlife,cents,money,isoDate,extractPdf,linesOf} from '../lib/metlife.mjs';
import {reconcile,draftOf,validateSnapshot,sourceDocumentPath} from '../lib/reconcile.mjs';
const stamp='2026-10-15T01:00:00Z',now=Date.parse(stamp);
function pdf(){return {sha256:'a'.repeat(64),errors:[],warnings:[],patient:'TEST',subscriber:'TEST PERSON',group:'G123',processed:'2026-09-29',claimRaw:'1234567890 99',claimBase:'1234567890',payment:{date:'2026-09-17',amountCents:30000,method:'EFT',trace:'000012345678901234'},procedures:[{code:'D0150',date:'2026-09-13',benefitCents:10000},{code:'D1110',date:'2026-09-13',benefitCents:20000}]};}
function snap(){return {readOnly:true,patNum:'99',capturedAt:stamp,warnings:[],tables:{patient:[{PatNum:'99',FName:'TEST',LName:'PERSON',ImageFolder:'PersonTest99'}],preference:[{PrefName:'AtoZfolder',ValueString:'\\\\SERVER\\OpenDentImages'}],document:[{DocNum:'1',PatNum:'99',FileName:'TEST.pdf',DocCategory:'10'}],definition:[{DefNum:'10',ItemName:'FINISHED CLAM'}],patplan:[{PatNum:'99',InsSubNum:'20'}],inssub:[{InsSubNum:'20',PlanNum:'30',Subscriber:'99'}],insplan:[{PlanNum:'30',GroupNum:'G123',CarrierNum:'40'}],carrier:[{CarrierNum:'40',CarrierName:'METLIFE GROUP DENTAL CLAIMS'}],procedurelog:[{ProcNum:'51',PatNum:'99',CodeNum:'61',ProcDate:'2026-09-13',ProcStatus:2,ProvNum:'3'},{ProcNum:'52',PatNum:'99',CodeNum:'62',ProcDate:'2026-09-13',ProcStatus:2,ProvNum:'3'}],procedurecode:[{CodeNum:'61',ProcCode:'D0150'},{CodeNum:'62',ProcCode:'D1110'}],payment:[],paysplit:[],claim:[],claimproc:[],claimpayment:[]}};}
test('money uses exact cents and refuses imprecise values',()=>{assert.equal(cents('$1,234.56'),123456);assert.equal(money(123456),'1234.56');assert.equal(cents('0.29')+cents('0.01'),30);assert.equal(money(-1),'-0.01');for(const x of ['NaN','1.001','1e4','Infinity',''])assert.throws(()=>cents(x));});
test('date parser rejects impossible dates and leap-year errors',()=>{assert.equal(isoDate('02/29/2024'),'2024-02-29');assert.equal(isoDate('02/29/2025'),null);assert.equal(isoDate('13/01/2026'),null);});
test('matching patient, document, MetLife plan and procedures permits preview only',()=>{const p=pdf(),r=reconcile(p,snap(),'C:\\TEST.pdf',now);assert.deepEqual(r.blocks,[]);assert.equal(r.splits.length,2);const d=draftOf(p,r);assert.equal(d.mode,'preview-only');assert.equal(d.amount,'300.00');assert.equal(d.checkNum,'');assert.equal(d.date,'2026-09-29');assert.equal(d.note,'Claim number: 1234567890 99');assert.equal(d.paymentType,'Insurance Paid');assert.equal(d.claimRaw,'1234567890 99');});
test('shared group never identifies another patient or non-MetLife carrier',()=>{const s=snap();s.tables.patient[0].FName='OTHER';assert.ok(reconcile(pdf(),s,'TEST.pdf',now).blocks.some(b=>b.includes('FName')));s.tables.carrier[0].CarrierName='LIBERTY';assert.ok(reconcile(pdf(),s,'TEST.pdf',now).blocks.some(b=>b.includes('hợp đồng MetLife')));});
test('missing document, duplicate document and mismatched category block fill',()=>{for(const mutation of [s=>s.tables.document=[],s=>s.tables.document.push({...s.tables.document[0],DocNum:'2'}),s=>s.tables.document[0].DocCategory='999']){const s=snap();mutation(s);const r=reconcile(pdf(),s,'TEST.pdf',now);assert.ok(r.blocks.length);assert.throws(()=>draftOf(pdf(),r));}});
test('stale or future snapshot blocks fill',()=>{assert.ok(reconcile(pdf(),snap(),'TEST.pdf',now+31*60000).blocks.some(b=>b.includes('30 phút')));assert.ok(reconcile(pdf(),snap(),'TEST.pdf',now-6*60000).blocks.some(b=>b.includes('sai giờ')));});
test('claim raw/base, EFT trace and date/amount duplicates block payment',()=>{for(const row of [{PayNum:'8',PayNote:'Claim 1234567890',PayAmt:'300.00'},{PayNum:'8',CheckNum:'000012345678901234'},{PayNum:'8',PayAmt:'300.00',PayDate:'2026-09-17'}]){const s=snap();s.tables.payment=[row];const r=reconcile(pdf(),s,'TEST.pdf',now);assert.ok(r.duplicates.length);assert.throws(()=>draftOf(pdf(),r));}});
test('claimpayment duplicates block even if payment table empty',()=>{const s=snap();s.tables.claimpayment=[{ClaimPaymentNum:'90',CheckAmt:'300.00',CheckDate:'2026-09-17'}];assert.ok(reconcile(pdf(),s,'TEST.pdf',now).duplicates.length);});
test('ambiguous completed procedure and incomplete allocations block fill',()=>{const s=snap();s.tables.procedurelog.push({...s.tables.procedurelog[0],ProcNum:'53'});assert.ok(reconcile(pdf(),s,'TEST.pdf',now).blocks.some(b=>b.includes('D0150')));});
test('invalid snapshot is rejected rather than treated as empty ledger',()=>{const s=snap();delete s.tables.claimpayment;assert.throws(()=>validateSnapshot(s));const t=snap();t.warnings=['truncated'];assert.throws(()=>validateSnapshot(t));});
test('unknown PDF layouts / scan / Liberty never parse as supported MetLife',()=>{for(const text of ['', 'Liberty Claim Number: 123']){const p=parseMetlife({sha256:'x',pages:[{page:1,width:612,items:[],lines:[{y:1,text,items:[]}]}]});assert.equal(p.template,null);assert.ok(p.errors.length);}});
test('single-page claim missing payment continuation blocks',()=>{const p=parseMetlife({pages:[{page:1,width:612,items:[],lines:[{text:'Claim Summary Relationship to Subscriber: Group Number: Claim Detail Claim Number: 123 Patient Name: TEST',items:[],y:1}]}]});assert.ok(p.errors.some(e=>e.includes('thanh toán')));});
test('text line grouping preserves left-to-right ordering',()=>{assert.equal(linesOf([{str:'B',x:20,y:12},{str:'A',x:1,y:11}])[0].text,'A B');});
// Optional integration uses the supplied local PDF; never package patient documents in fixtures.
if(process.env.METLIFE_SAMPLE_PDF)test('real supplied MetLife PDF: all 7 services, raw suffix, payment continuation',async()=>{
 const fs=await import('node:fs/promises');const p=parseMetlife(await extractPdf(await fs.readFile(process.env.METLIFE_SAMPLE_PDF)));
 assert.deepEqual(p.errors,[]);assert.equal(p.procedures.length,7);assert.equal(p.payment.amountCents,44200);assert.equal(p.payment.date,'2026-09-17');assert.equal(p.payment.method,'EFT');assert.match(p.claimRaw,/ 99$/);assert.equal(p.procedures.find(r=>r.code==='D0210').benefitCents,22200);assert.ok(p.procedures.find(r=>r.code==='D0210').bundled);assert.equal(p.procedures.reduce((n,r)=>n+r.benefitCents,0),p.benefitCents);
});

test('server document path uses verified AtoZ root and patient folder; traversal rejected',()=>{
 const s=snap(),r=reconcile(pdf(),s,'TEST.pdf',now);
 assert.equal(sourceDocumentPath(s,r),'\\\\SERVER\\OpenDentImages\\P\\PersonTest99\\TEST.pdf');
 r.document.FileName='../TEST.pdf';assert.throws(()=>sourceDocumentPath(s,r));
});
test('existing insurance payment on same procedure/plan blocks repeat posting',()=>{
 const s=snap();s.tables.claimproc.push({ProcNum:'51',PlanNum:'30',InsPayAmt:'100.00'});
 assert.ok(reconcile(pdf(),s,'TEST.pdf',now).blocks.some(b=>b.includes('đã có khoản bảo hiểm')));
});

test('claim-only note replaces saved group notes for every payment',()=>{
 assert.deepEqual(loadConfig({paymentType:'',noteTemplate:'old provisional note'}),DEFAULT_CONFIG);
 assert.deepEqual(loadConfig(null),DEFAULT_CONFIG);
 assert.equal(loadConfig({schemaVersion:3,paymentType:'Insurance Paid',noteTemplate:'group number : {group}'}).noteTemplate,'Claim number: {claim}');
 const d=draftOf(pdf(),reconcile(pdf(),snap(),'TEST.pdf',now));
 assert.equal(d.note,'Claim number: 1234567890 99');assert.equal(d.paymentType,'Insurance Paid');
});
