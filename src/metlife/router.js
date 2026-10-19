import express from 'express';
import {isLocalDesktop} from './local.js';
import {loginAdminAccount,isMetlifeAdminActive} from '../adminAuth.js';
import {issueSession,readSession,loginLimiter} from './session.js';
import {fileURLToPath} from 'node:url';
import {createPostingCoordinator} from './posting.js';
import {timingSafeEqual} from 'node:crypto';
import {pool} from '../db.js';
import {createRepository,validId} from './repository.js';
export function createMetlifeRouter({repository=createRepository(pool),getToken=()=>process.env.METLIFE_API_TOKEN||'',login=loginAdminAccount,isActive=isMetlifeAdminActive}={}){
 const router=express.Router();
 const posting=createPostingCoordinator({repository,directory:process.env.METLIFE_JOB_DIR||fileURLToPath(new URL('../../metlife-operations',import.meta.url))});
 const allowLogin=loginLimiter();
 router.post('/connect',express.json({limit:'4kb'}),async(req,res)=>{
  res.set('Cache-Control','no-store');
  const secret=getToken();if(secret.length<32)return res.status(503).json({ok:false,error:'MetLife chưa được cấu hình trên SERVER.'});
  // Socket address is intentional: never trust an arbitrary forwarded IP header.
  if(!allowLogin(req.socket.remoteAddress||'unknown'))return res.status(429).json({ok:false,error:'Thử đăng nhập quá nhiều lần. Thử lại sau 15 phút.'});
  if(typeof req.body?.username!=='string'||req.body.username.length>64||typeof req.body?.password!=='string'||!req.body.password||req.body.password.length>512)return res.status(401).json({ok:false,error:'Thông tin đăng nhập không hợp lệ.'});
  try{
   const {admin}=await login(req.body);
   if(!admin?.isActive||!['owner','admin'].includes(admin.role))throw new Error('Access denied');
   return res.json({ok:true,data:{token:issueSession(secret,admin)}});
  }catch{return res.status(401).json({ok:false,error:'Tài khoản/mật khẩu không đúng hoặc chưa có quyền quản trị.'});}
 });
 router.use(async(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(isLocalDesktop(req))return next();
  const expected=getToken();if(!expected||expected.length<32)return res.status(503).json({ok:false,error:'MetLife chưa được cấu hình trên SERVER.'});
  const header=req.get('authorization')||'',token=header.startsWith('Bearer ')?header.slice(7):'';
  const a=Buffer.from(token),b=Buffer.from(expected);
  if(a.length!==b.length||!timingSafeEqual(a,b)){
   const session=readSession(expected,token);
   try{if(!session||!await isActive(session.sub))return res.status(401).json({ok:false,error:'Phiên kết nối hết hạn. Đăng nhập SERVER lại.'});}
   catch{return res.status(503).json({ok:false,error:'Chưa xác minh được tài khoản SERVER.'});}
  }
  next();
 });
 const json=fn=>async(req,res)=>{try{res.json({ok:true,data:await fn(req)});}catch(e){console.error('[MetLife API Error]', e);res.status(400).json({ok:false,error:e.code?'SERVER chưa đọc được dữ liệu hoặc file OD. Kiểm tra cấu hình và quyền dịch vụ.':e.message});}};
 router.post('/operations',json(req=>posting.prepare(req.body)));
 router.post('/operations/:id/recheck',json(req=>posting.recheck(req.params.id)));
 router.post('/operations/:id/begin-ui-save',json(req=>posting.beginUiSave(req.params.id)));
 router.post('/operations/:id/post',json(req=>posting.post(req.params.id)));
 router.post('/operations/:id/verify',json(req=>posting.verify(req.params.id)));
 router.post('/operations/:id/abort',json(req=>posting.abort(req.params.id)));
 router.get('/operations/:id',json(req=>posting.status(req.params.id)));
 router.get('/health',json(()=>repository.health()));
 router.get('/diagnostics/api',json(()=>repository.apiStatus()));
 router.get('/diagnostics/database',json(()=>repository.diagnostics()));
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
