import {test} from 'node:test';import assert from 'node:assert/strict';
import {validateConnection} from '../lib/connection.mjs';import {Workspace} from '../lib/workspace.mjs';
test('connection accepts HTTPS or loopback only and excludes credentials in URLs',()=>{
 const token='x'.repeat(64);assert.equal(validateConnection({url:'https://example.com/',token}).url,'https://example.com');
 for(const url of ['http://8.8.8.8','file:///tmp/file','https://user:pass@example.com','https://example.com/?token=x'])assert.throws(()=>validateConnection({url,token}));
 assert.throws(()=>validateConnection({url:'https://example.com',token:'short'}));
});
test('remote PDF context follows selected PatNum even when file names repeat',()=>{
 const w=new Workspace();const tables={patient:[{PatNum:'99',FName:'TEST'}],document:[{DocNum:'55',PatNum:'99',FileName:'same.pdf',DocCategory:'1'}],definition:[{DefNum:'1',ItemName:'FINISHED CLAM'}],patplan:[],inssub:[],insplan:[],carrier:[],procedurelog:[],procedurecode:[],payment:[],paysplit:[],claim:[],claimproc:[],claimpayment:[]};
 w.snapshots.set('99',{readOnly:true,patNum:'99',capturedAt:new Date().toISOString(),warnings:[],tables});
 w.snapshots.set('100',{readOnly:true,patNum:'100',capturedAt:new Date().toISOString(),warnings:[],tables:{...tables,patient:[{PatNum:'100',FName:'OTHER'}],document:[{DocNum:'56',PatNum:'100',FileName:'same.pdf'}]}});
 const item={name:'same.pdf',path:'same.pdf',remote:{patNum:'99',docNum:'55'},parsed:{patient:'TEST',errors:[],warnings:[],procedures:[],claimRaw:'x',group:'1'}};
 assert.equal(w.result(item).patient.PatNum,'99');item.remote.docNum='56';assert.match(w.result(item).blocks[0],/DocNum\/PatNum/);
});
if(process.env.METLIFE_SAMPLE_PDF)test('identical PDF bytes and filename still keep separate remote document identities',async()=>{
 const fs=await import('node:fs/promises');const bytes=await fs.readFile(process.env.METLIFE_SAMPLE_PDF),w=new Workspace();
 const a=await w.addBytes(bytes,'same.pdf',{patNum:'99',docNum:'1',serverUrl:'https://one.test'});
 const b=await w.addBytes(bytes,'same.pdf',{patNum:'100',docNum:'2',serverUrl:'https://one.test'});
 assert.notEqual(a,b);assert.equal(await w.addBytes(bytes,'same.pdf',{patNum:'99',docNum:'1',serverUrl:'https://one.test'}),a);
});

test('automatic LAN connection excludes credential-free Internet URLs',()=>{
 assert.equal(validateConnection({url:'http://SERVER:3008',token:''}).token,'');
 assert.throws(()=>validateConnection({url:'https://od-bridge.lukdental.us',token:''}));
 assert.throws(()=>validateConnection({url:'http://8.8.8.8:3008',token:''}));
});
