const path=require('node:path');
const {runWindows}=require('../../lib/windows.cjs');
runWindows(path.join(__dirname,'../../windows'),{action:'inspect',diagnosticDir:process.argv[2]}).then(
 result=>process.stdout.write(JSON.stringify(result)),
 error=>{process.stdout.write(JSON.stringify({ok:false,error:error.message,diagnosticFolder:error.diagnosticFolder}));process.exitCode=1;}
);
