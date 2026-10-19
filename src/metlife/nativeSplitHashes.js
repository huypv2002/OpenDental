import {spawn} from 'node:child_process';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const pipeName='\\\\.\\pipe\\luk-metlife-paysplit-hash';
const agentUrls=[
 process.env.METLIFE_OD_AGENT_URL,
 'http://127.0.0.1:30099/hash',
 'http://127.0.0.1:30098/hash'
].filter(Boolean);

async function hashesFromHttp(input,url){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),6000);
 try{
  const res=await fetch(url,{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify(input),
   signal:controller.signal
  });
  if(!res.ok)throw new Error(`Agent HTTP status ${res.status}`);
  const data=await res.json();
  if(!data.ok||!Array.isArray(data.hashes)||data.hashes.length!==input.splits.length||data.hashes.some(h=>typeof h!=='string'||h.length===0||h.length>4096||/Exception$|\s/.test(h))){
   throw new Error(data.error||'Agent trả SecurityHash không hợp lệ.');
  }
  return data.hashes;
 }finally{clearTimeout(timer);}
}

function hashesFromRunningOpenDental(input){
 return new Promise((resolve,reject)=>{
  const socket=net.connect({path:pipeName});
  let output='',finished=false;
  const done=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
  const timer=setTimeout(()=>{socket.destroy();done(new Error('Open Dental hash plugin timed out.'));},8000);
  socket.setEncoding('utf8');
  socket.on('error',()=>done(new Error('Open Dental is not serving the hash plugin on SERVER. Start Open Dental after installing LukMetlifeHash.dll.')));
  socket.on('data',chunk=>{output+=chunk;if(output.length>65536){socket.destroy();done(new Error('Open Dental hash plugin returned too much data.'));}});
  socket.on('end',()=>{
   try{
    const line=output.replace(/^\uFEFF/,'').trim().split(/\r?\n/)[0]||'';
    const result=JSON.parse(line);
    if(!result.ok)throw new Error(result.error||'Open Dental hash plugin failed.');
    if(!Array.isArray(result.hashes)||result.hashes.length!==input.splits.length||result.hashes.some(h=>typeof h!=='string'||h.length===0||h.length>4096||/Exception$|\s/.test(h)))throw new Error('Open Dental hash plugin returned an invalid SecurityHash.');
    done(null,result.hashes);
   }catch(e){done(new Error(e instanceof SyntaxError?'Open Dental hash plugin returned invalid JSON.':e.message));}
  });
  socket.on('connect',()=>socket.write(JSON.stringify(input)+'\n'));
 });
}
export async function nativeSplitHashes(plan){
 if(process.platform!=='win32')throw new Error('Schema cần SecurityHash: helper phải chạy trên Windows SERVER đã cài OD 24.3.');
 const script=fileURLToPath(new URL('../../scripts/metlife-new-split-hashes.ps1',import.meta.url));
 const root=process.env.SystemRoot||'C:\\Windows';
 const input={splits:plan.splits.map(s=>({patNum:String(plan.patNum),amount:(s.amountCents/100).toFixed(2),date:plan.date}))};
 for(const url of agentUrls){
  try{return await hashesFromHttp(input,url);}catch{}
 }
 try{return await hashesFromRunningOpenDental(input);}catch(pipeError){
  // Fall through to the out-of-process helper only when the in-process plugin is absent.
  if(!/not serving the hash plugin/i.test(pipeError.message))throw pipeError;
 }
 async function run(architecture,install){return new Promise((resolve,reject)=>{
  const ps=path.join(root,architecture===32?'SysWOW64':'System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(ps,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...(install?{METLIFE_OD_INSTALL_DIR:install}:{})}});
  let output='',stderr='',finished=false;
  const done=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
  const timer=setTimeout(()=>{child.kill();done(new Error('Helper SecurityHash của OD quá thời gian; chưa ghi dữ liệu.'));},15000);
  child.on('error',()=>done(new Error('Không mở được helper OD trên SERVER.')));
  child.stdin.on('error',()=>{});
  child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>65536){child.kill();done(new Error('Helper OD trả dữ liệu quá lớn.'));}});
  child.stderr.on('data',b=>{if(stderr.length<8192)stderr+=b.toString('utf8');});
  child.on('close',()=>{try{
   const result=JSON.parse(output.replace(/^\uFEFF/,''));
   if(result.retry32===true&&architecture===64&&typeof result.install==='string'){done(null,{retry32:true,install:result.install});return;}
   if(!result.ok)throw new Error(result.error||'Helper OD thất bại.');
   if(!Array.isArray(result.hashes)||result.hashes.length!==plan.splits.length||result.hashes.some(h=>typeof h!=='string'||h.length===0||h.length>4096||/Exception$|\s/.test(h)))throw new Error('Helper OD trả SecurityHash không hợp lệ.');
   done(null,result.hashes);
  }catch(e){done(new Error(e instanceof SyntaxError?'Helper OD không trả kết quả hợp lệ; kiểm tra bản cài OD/CDT.dll trên SERVER.':e.message));}});
  child.stdin.end(JSON.stringify(input));
 });}
 const first=await run(64);
 return first?.retry32?run(32,first.install):first;
}
