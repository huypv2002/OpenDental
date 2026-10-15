const {spawn}=require('node:child_process');
const path=require('node:path');
function runWindows(resourceDir,request) {
  if(process.platform!=='win32') return Promise.reject(new Error('Điều khiển Open Dental chỉ chạy trên Windows có OD.'));
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',path.join(resourceDir,'od-automation.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';let timeout=false;
    const timer=setTimeout(()=>{timeout=true;child.kill();},240000);
    child.stdout.on('data',b=>{stdout+=b.toString('utf8');if(stdout.length>1024*1024) child.kill();});
    child.stderr.on('data',b=>{stderr+=b.toString('utf8');});
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(timeout)return reject(new Error('OD phản hồi quá thời gian. Kiểm tra cửa sổ Payment trước khi thử lại.'));try {const result=JSON.parse(stdout.replace(/^\uFEFF/,''));if(!result.ok){const error=new Error(result.error||'Windows automation failed');error.saveInvoked=result.saveInvoked;error.windowHandle=result.windowHandle;error.diagnosticFolder=result.diagnosticFolder;reject(error);return;}resolve(result);}catch(e){reject(new Error(code && !stdout?'Không chạy được Windows UI Automation. Hãy chạy cùng quyền với Open Dental.':e.message));}});
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
module.exports={runWindows};
