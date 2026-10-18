const {execFileSync}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');const os=require('node:os');
const root=path.join(__dirname,'..'),out=path.join(root,'windows','native');fs.mkdirSync(out,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'luk-metlife-native-'));
const npmCli=process.env.npm_execpath;
if(!npmCli||!fs.existsSync(npmCli))throw new Error('Run through npm run pack:win or npm run dist:win.');
try{
 const pack=JSON.parse(execFileSync(process.execPath,[npmCli,'pack','@napi-rs/canvas-win32-x64-msvc@1.0.11','--json','--pack-destination',temp],{encoding:'utf8'}));
 execFileSync('tar',['-xf',path.join(temp,pack[0].filename),'-C',temp]);
 for(const f of ['skia.win32-x64-msvc.node','package.json'])fs.copyFileSync(path.join(temp,'package',f),path.join(out,f));
 console.log('Windows canvas native prepared.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
