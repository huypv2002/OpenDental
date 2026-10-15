import express from 'express';
import {fileURLToPath} from 'node:url';
import {createPostingCoordinator} from './posting.js';
import {timingSafeEqual} from 'node:crypto';
import {pool} from '../db.js';
import {createRepository,validId} from './repository.js';
export function createMetlifeRouter({repository=createRepository(pool),getToken=()=>process.env.METLIFE_API_TOKEN||''}={}){
 const router=express.Router();
 const posting=createPostingCoordinator({repository,directory:process.env.METLIFE_JOB_DIR||fileURLToPath(new URL('../../metlife-operations',import.meta.url))});
 router.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  const expected=getToken();if(!expected||expected.length<32)return res.status(503).json({ok:false,error:'MetLife chưa được cấu hình trên SERVER.'});
  const header=req.get('authorization')||'',token=header.startsWith('Bearer ')?header.slice(7):'';
  const a=Buffer.from(token),b=Buffer.from(expected);
  if(a.length!==b.length||!timingSafeEqual(a,b))return res.status(401).json({ok:false,error:'Kết nối MetLife chưa được xác thực.'});
  next();
 });
 const json=fn=>async(req,res)=>{try{res.json({ok:true,data:await fn(req)});}catch(e){res.status(400).json({ok:false,error:e.code?'SERVER chưa đọc được dữ liệu hoặc file OD. Kiểm tra cấu hình và quyền dịch vụ.':e.message});}};
 router.post('/operations',json(req=>posting.prepare(req.body)));
 router.post('/operations/:id/recheck',json(req=>posting.recheck(req.params.id)));
 router.post('/operations/:id/verify',json(req=>posting.verify(req.params.id)));
 router.post('/operations/:id/abort',json(req=>posting.abort(req.params.id)));
 router.get('/operations/:id',json(req=>posting.status(req.params.id)));
 router.get('/health',json(()=>repository.health()));
 router.get('/patients',json(req=>repository.search(req.query)));
 router.get('/patients/:patNum/documents',json(req=>repository.documents(req.params.patNum)));
 router.get('/patients/:patNum/pending',json(req=>posting.patientPending(req.params.patNum)));
 router.get('/patients/:patNum/context',json(req=>{if(!validId(req.params.patNum))throw new Error('Invalid PatNum');return repository.context(req.params.patNum);}));
 router.get('/patients/:patNum/documents/:docNum/pdf',async(req,res)=>{
  try{const file=await repository.pdf(req.params.patNum,req.params.docNum);res.set({'Content-Type':'application/pdf','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'X-Content-Type-Options':'nosniff','X-Metlife-SHA256':file.sha256});res.send(file.bytes);}
  catch(e){res.status(400).json({ok:false,error:e.code?'SERVER chưa đọc được PDF. Kiểm tra quyền truy cập thư mục Images.':e.message});}
 });
 return router;
}
