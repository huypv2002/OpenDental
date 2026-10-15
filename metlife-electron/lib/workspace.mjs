import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG} from './config.mjs';
import {extractPdf,parseMetlife} from './metlife.mjs';
import {validateSnapshot,reconcile,draftOf} from './reconcile.mjs';
export class Workspace {
  constructor(){this.items=new Map();this.snapshots=new Map();this.config={...DEFAULT_CONFIG};this.preview=null;}
  async addPdf(file){
    const stat=await fs.stat(file);
    if(!stat.isFile()||path.extname(file).toLowerCase()!=='.pdf'||stat.size>30*1024*1024) throw new Error('Chỉ nhận PDF tối đa 30 MB.');
    const bytes=await fs.readFile(file);if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('File không có header PDF.');
    return this.addBytes(bytes,file);
  }
  async addBytes(bytes,file,remote=null){
    if(bytes.length>30*1024*1024||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('PDF không hợp lệ hoặc quá lớn.');
    const parsed=parseMetlife(await extractPdf(bytes));
    const existing=[...this.items.values()].find(i=>i.parsed.sha256===parsed.sha256&&i.path===file&&(remote?(i.remote?.patNum===remote.patNum&&i.remote?.docNum===remote.docNum&&i.remote?.serverUrl===remote.serverUrl):!i.remote));
    if(existing)return existing.id;
    const id=randomUUID();this.items.set(id,{id,path:file,name:String(file).split(/[\\/]/).at(-1),parsed,bytes,remote});return id;
  }
  async addSnapshot(file){
    const stat=await fs.stat(file);if(stat.size>30*1024*1024)throw new Error('Snapshot quá lớn.');
    const s=validateSnapshot(JSON.parse(await fs.readFile(file,'utf8')));
    this.snapshots.set(String(s.patNum),s);return s.patNum;
  }
  result(item){
    const matching=item.remote?[this.snapshots.get(String(item.remote.patNum))].filter(Boolean):[...this.snapshots.values()].filter(s=>s.tables.document.some(d=>String(d.FileName).split(/[\\/]/).at(-1).toLowerCase()===item.name.toLowerCase()));
    if(matching.length>1)return {blocks:['Tên PDF xuất hiện ở nhiều bệnh nhân; cần xử lý trùng tên tài liệu.'],warnings:[],patient:null,document:null,plan:null,splits:[],duplicates:[]};
    const context=matching[0];
    if(item.remote&&context&&!context.tables.document.some(d=>String(d.DocNum)===String(item.remote.docNum)&&String(d.PatNum)===String(item.remote.patNum)&&String(d.FileName).split(/[\\/]/).at(-1)===item.name))return {blocks:['PDF không còn khớp DocNum/PatNum đã chọn.'],warnings:[],patient:null,document:null,plan:null,splits:[],duplicates:[]};
    return reconcile(item.parsed,context||null,item.path,Date.now(),{verifyUncPath:!item.remote});
  }
  plan(id){const item=this.items.get(id);if(!item)throw new Error('PDF không còn trong hàng đợi.');return draftOf(item.parsed,this.result(item),this.config);}
  state(){return {items:[...this.items.values()].map(i=>({id:i.id,name:i.name,path:i.path,remote:i.remote,parsed:i.parsed,result:this.result(i)})),config:this.config,snapshots:[...this.snapshots.values()].map(s=>({patNum:s.patNum,capturedAt:s.capturedAt})),preview:this.preview};}
}
export async function scanPdfs(root,limit=500){
 const todo=[root],files=[];let seen=0;
 while(todo.length){
  const dir=todo.shift();
  const entries=await fs.readdir(dir,{withFileTypes:true});
  for(const e of entries){
   if(++seen>15000)throw new Error('Thư mục quá lớn; chọn thư mục bệnh nhân hoặc nhóm nhỏ hơn.');
   const f=path.join(dir,e.name);
   if(e.isSymbolicLink())continue;
   if(e.isDirectory())todo.push(f);
   else if(e.isFile()&&/\.pdf$/i.test(e.name)){files.push(f);if(files.length>limit)throw new Error(`Chỉ quét tối đa ${limit} PDF mỗi thư mục.`);}
  }
 }
 return files;
}
