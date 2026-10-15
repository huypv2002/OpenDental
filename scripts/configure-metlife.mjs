// One-time configuration of the MetLife routes inside the EXISTING Bridge process.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
export async function configureMetlife(base,urlArg='https://od-bridge.lukdental.us'){
 const url=new URL(urlArg);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Use the existing Bridge HTTPS address.');
 const envPath=path.join(base,'.env'),env=await fs.readFile(envPath,'utf8');
 const match=env.match(/^METLIFE_API_TOKEN\s*=\s*["']?([a-f0-9]{64})["']?\s*$/m);
 if(!match&&/^METLIFE_API_TOKEN[^\S\r\n]*=[^\S\r\n]*[^\s#]+/m.test(env))throw new Error('Existing METLIFE_API_TOKEN has a different format; configuration was not changed.');
 const token=match?.[1]||randomBytes(32).toString('hex');
 let next=env.replace(/^METLIFE_API_TOKEN[^\S\r\n]*=[^\S\r\n]*(?:#.*)?$/gm,'').replace(/^METLIFE_JOB_DIR[^\S\r\n]*=[^\S\r\n]*(?:#.*)?$/gm,'').replace(/\s*$/,'');
 if(!match)next+=`\nMETLIFE_API_TOKEN=${token}`;
 if(!/^METLIFE_JOB_DIR[^\S\r\n]*=/m.test(next))next+=`\nMETLIFE_JOB_DIR=${path.join(base,'metlife-operations').replace(/\\/g,'/')}`;
 if(next+'\n'!==env){
  const backup=path.join(base,'metlife-backups',new Date().toISOString().replace(/[:.]/g,'-'));
  await fs.mkdir(backup,{recursive:true});await fs.copyFile(envPath,path.join(backup,'.env'));
  await fs.writeFile(envPath,next+'\n',{mode:0o600});
 }
 const connection=path.join(base,'metlife-r5-connection.json');
 await fs.writeFile(connection,JSON.stringify({url:url.href.replace(/\/$/,''),token},null,2),{mode:0o600});
 return {connection};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const {connection}=await configureMetlife(base,process.argv[2]);
 console.log('Configured /api/metlife inside this Bridge. Restart the existing Bridge once.');
 console.log('R5: MetLife Assistant 0.3.2 connects automatically on clinic LAN; no login or JSON needed.');
}
