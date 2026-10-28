// Reproducible local evidence. Never points a test at the clinic database.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const out=path.resolve(option('--output')||path.join(root,'output','insurance-handover'));
const fixtures=option('--fixtures')?path.resolve(option('--fixtures')):null;
await fs.mkdir(out,{recursive:true});
const env={...process.env};delete env.METLIFE_TEST_DB_URL;
const fixtureKeys=['INSURANCE_TXT_PDF_DIR','DELTA_TEXT_TEST_FILE','EOB_PDF_TO_TEXT_DIR','DELTA_REDUCED_TEST_PDF','DELTA_CELL_TEST_PDF','DELTA_FLB_TEST_PDF','DELTA_TEST_PDF','EOB_CURRENT_FEEDBACK_DIR','INSURANCE_FEEDBACK_DIR','METLIFE_TEST_PDF','METLIFE_QUADRANT_TEST_PDF','CIGNA_TEST_PDF','LIBERTY_TEST_SINGLE_PDF','LIBERTY_TEST_MULTI_PDF','LIBERTY_TEST_IMAGE','LIBERTY_TEST_SINGLE_IMAGE'];
for(const k of fixtureKeys)delete env[k];
const manifest={startedAt:new Date().toISOString(),platform:os.platform(),architecture:os.arch(),node:process.version,realDatabase:false,realPaymentWrites:false,realSms:false,fixtures:[],suites:[]};
try{manifest.commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();manifest.trackedChanges=execFileSync('git',['diff','--name-only','HEAD'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);}catch{}
if(fixtures){
 const names=await fs.readdir(fixtures);
 const enable=async(key,name)=>{if(!names.includes(name))return;env[key]=path.join(fixtures,name);const bytes=await fs.readFile(env[key]);manifest.fixtures.push({key,name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});};
 for(const [key,name] of Object.entries({DELTA_TEXT_TEST_FILE:'1793111377468_1279.txt',DELTA_REDUCED_TEST_PDF:'1793110627097_423.pdf',DELTA_CELL_TEST_PDF:'1792789329060_423.pdf',DELTA_FLB_TEST_PDF:'1792771310824_1012.pdf',DELTA_TEST_PDF:'280.pdf',METLIFE_TEST_PDF:'1307.pdf',METLIFE_QUADRANT_TEST_PDF:'1792775940841_621.pdf',CIGNA_TEST_PDF:'1275.pdf',LIBERTY_TEST_SINGLE_PDF:'1282.pdf',LIBERTY_TEST_MULTI_PDF:'1041.pdf',LIBERTY_TEST_IMAGE:'AAA.jpg'}))await enable(key,name);
 const complete=list=>list.every(name=>names.includes(name));
 if(complete(['1307.pdf','1041.pdf','1275.pdf','1792775940841_621.pdf','584.pdf']))env.INSURANCE_TXT_PDF_DIR=fixtures;
 if(complete(['1041.pdf','584.pdf','1283.pdf']))env.EOB_CURRENT_FEEDBACK_DIR=fixtures;
 if(['493','1307','1283','1282','1278','1041'].every(id=>names.some(n=>n.startsWith(id+' ')&&n.endsWith('.pdf'))))env.INSURANCE_FEEDBACK_DIR=fixtures;
 if(complete(['1793111377468_1279.pdf','1793110627097_423.pdf','1307.pdf','1041.pdf','1275.pdf','1792775940841_621.pdf','584.pdf','1283.pdf','280.pdf','1792771310824_1012.pdf']))env.EOB_PDF_TO_TEXT_DIR=fixtures;
 // A single-patient JPEG generated from the real Liberty PDF complements AAA.jpg.
 if(env.LIBERTY_TEST_SINGLE_PDF){
  const {createCanvas}=await import('@napi-rs/canvas'),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(await fs.readFile(env.LIBERTY_TEST_SINGLE_PDF)),isEvalSupported:false,useSystemFonts:true});
  try{const doc=await task.promise,p=await doc.getPage(1),v=p.getViewport({scale:2}),canvas=createCanvas(Math.ceil(v.width),Math.ceil(v.height));await p.render({canvasContext:canvas.getContext('2d'),viewport:v}).promise;env.LIBERTY_TEST_SINGLE_IMAGE=path.join(out,'liberty-single.jpg');await fs.writeFile(env.LIBERTY_TEST_SINGLE_IMAGE,canvas.toBuffer('image/jpeg',95),{mode:0o600});}finally{await task.destroy();}
 }
}
manifest.enabledFixtureKeys=fixtureKeys.filter(k=>env[k]);
const testFiles=async dir=>(await fs.readdir(path.join(root,dir))).filter(n=>/\.test\.(?:js|mjs)$/.test(n)).sort().map(n=>path.join(root,dir,n));
async function run(name,files,cwd=root){
 const command=['--test','--test-concurrency=2','--test-reporter=junit',`--test-reporter-destination=${path.join(out,name+'.xml')}`,'--test-reporter=spec',`--test-reporter-destination=${path.join(out,name+'.log')}`,...files];
 const exitCode=await new Promise(resolve=>{const child=spawn(process.execPath,command,{cwd,env,stdio:'inherit',windowsHide:true});child.once('error',()=>resolve(1));child.once('close',code=>resolve(code??1));});
 const result={name,exitCode,files:files.map(f=>path.relative(root,f))};manifest.suites.push(result);return result;
}
console.log('Running four-carrier insurance suite. Evidence:',out);
await run('bridge-tests',(await Promise.all(['metlife','liberty','cigna','delta'].map(n=>testFiles('src/'+n)))).flat());
await run('electron-unit',await testFiles('metlife-electron/tests'),path.join(root,'metlife-electron'));
if(args.includes('--ui')){
 const file=await fs.open(path.join(out,'electron-ui.log'),'w');
 try{const exitCode=await new Promise(resolve=>{const child=spawn(process.execPath,['scripts/ui-test.cjs'],{cwd:path.join(root,'metlife-electron'),env:{...env,INSURANCE_UI_SCREENSHOT:path.join(out,'electron-audit-ui.png')},stdio:['ignore',file.fd,file.fd],windowsHide:true});child.once('error',()=>resolve(1));child.once('close',code=>resolve(code??1));});manifest.suites.push({name:'electron-ui',exitCode});}finally{await file.close();}
}
manifest.finishedAt=new Date().toISOString();
const decode=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const cases=[];
for(const suite of manifest.suites.filter(s=>s.name!=='electron-ui')){
 const xml=await fs.readFile(path.join(out,suite.name+'.xml'),'utf8');
 for(const m of xml.matchAll(/<testcase\b((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g)){
  const body=m[2]?"":xml.slice(m.index+m[0].length,xml.indexOf('</testcase>',m.index));
  const attrs=Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])]));
  cases.push({id:`TC-${String(cases.length+1).padStart(3,'0')}`,suite:suite.name,name:attrs.name,file:path.relative(root,attrs.file||root),seconds:Number(attrs.time),status:/<failure\b|<error\b/.test(body)?'FAIL':/<skipped\b/.test(body)?'SKIP':'PASS'});
 }
}
manifest.summary=Object.fromEntries(['PASS','FAIL','SKIP'].map(k=>[k,cases.filter(c=>c.status===k).length]));
await fs.writeFile(path.join(out,'run-manifest.json'),JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(out,'test-cases.json'),JSON.stringify(cases,null,2));
const cell=s=>String(s??'').replaceAll('|','\\|').replaceAll('\n',' ');
await fs.writeFile(path.join(out,'full-test-cases.md'),`# Danh sách đầy đủ các test đã chạy\n\nCommit: ${manifest.commit}; ${manifest.platform}/${manifest.architecture}; ${manifest.node}.\n\n${JSON.stringify(manifest.summary)}. PASS nghĩa là đúng kỳ vọng; case lỗi được chặn an toàn cũng là PASS. Không phải mọi PASS đều là import thành công.\n\n| ID | Kết quả | Case | Mã nguồn kiểm thử | Giây |\n|---|---|---|---|---:|\n`+cases.map(c=>`| ${c.id} | ${c.status} | ${cell(c.name)} | ${cell(c.file)} | ${c.seconds} |`).join('\n')+'\n');
console.log(JSON.stringify({summary:manifest.summary,suites:manifest.suites.map(({name,exitCode})=>({name,exitCode})),evidence:out},null,2));
process.exitCode=manifest.suites.some(s=>s.exitCode!==0)?1:0;
