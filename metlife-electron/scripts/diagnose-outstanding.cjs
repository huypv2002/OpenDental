// Read the current Payment only; diagnostic data stays on the user's machine.
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs/promises');
const {runWindows}=require('../lib/windows.cjs');
(async()=>{
 const output=process.argv[2]?path.resolve(process.argv[2]):path.join(os.tmpdir(),'LUK-MetLife-diagnostics',`outstanding-read-${Date.now()}.json`);
 const result=await runWindows(path.join(__dirname,'../windows'),{action:'inspect-outstanding'});
 if(result.readOnly!==true||result.saveInvoked!==false)throw new Error('Unexpected diagnostic response');
 await fs.mkdir(path.dirname(output),{recursive:true});
 await fs.writeFile(output,JSON.stringify(result,null,2),'utf8');
 process.stdout.write(output+'\n');
})().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
