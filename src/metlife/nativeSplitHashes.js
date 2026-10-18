import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export async function nativeSplitHashes(plan){
 if(process.platform!=='win32')throw new Error('Schema cần SecurityHash: helper phải chạy trên Windows SERVER đã cài OD 24.3.');
 const script=fileURLToPath(new URL('../../scripts/metlife-new-split-hashes.ps1',import.meta.url));
 const root=process.env.SystemRoot||'C:\\Windows';
 const input={splits:plan.splits.map(s=>({patNum:plan.patNum,amount:(s.amountCents/100).toFixed(2),date:plan.date}))};
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
   if(!Array.isArray(result.hashes)||result.hashes.length!==plan.splits.length||result.hashes.some(h=>typeof h!=='string'||h.length<16||h.length>4096||/Exception$|\s/.test(h)))throw new Error('Helper OD trả SecurityHash không hợp lệ.');
   done(null,result.hashes);
  }catch(e){done(new Error(e instanceof SyntaxError?'Helper OD không trả kết quả hợp lệ; kiểm tra bản cài OD/CDT.dll trên SERVER.':e.message));}});
  child.stdin.end(JSON.stringify(input));
 });}
 const first=await run(64);
 return first?.retry32?run(32,first.install):first;
}
