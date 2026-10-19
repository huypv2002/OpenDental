const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json'),{EDITIONS}=require('../lib/edition.cjs');
const requested=process.argv[2]||'all',target=process.argv[3]||'portable';
const ids=requested==='all'?Object.keys(EDITIONS):[requested];
if(ids.some(id=>!Object.hasOwn(EDITIONS,id))||!['portable','dir'].includes(target))throw new Error('Invalid edition build');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'metlife-edition-build-'));
try{
 for(const id of ids){
  const edition=EDITIONS[id],config=structuredClone(pkg.build);
  config.appId=edition.appId;config.productName=edition.productName;
  config.extraMetadata={metlifeEdition:id};
  config.directories.output=path.join('dist',id);
  config.artifactName=`LUK-MetLife-${id==='client'?'Client':'API-OD'}-${pkg.version}.exe`;
  if(id==='api-od')config.extraResources=[{from:'windows/native',to:'native'}];
  const file=path.join(temp,id+'.json');fs.writeFileSync(file,JSON.stringify(config,null,2));
  execFileSync(process.execPath,[require.resolve('electron-builder/cli.js'),'--win',target,'--x64','--config',file],{cwd:root,stdio:'inherit'});
 }
}finally{fs.rmSync(temp,{recursive:true,force:true});}
