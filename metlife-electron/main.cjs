const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage,Menu}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createHash}=require('node:crypto');
const windows=require('./lib/windows.cjs');
const {resolveEdition,assertEditionAction}=require('./lib/edition.cjs');
const edition=resolveEdition({packaged:app.isPackaged,metadata:require('./package.json').metlifeEdition,argv:process.argv});
const profileBase=app.getPath('userData');
app.setName(edition.productName);
const profilePath=path.join(profileBase,edition.profile);
require('node:fs').mkdirSync(profilePath,{recursive:true});
app.setPath('userData',profilePath);
if(process.platform==='win32')app.setAppUserModelId(edition.appId);
let win,workspace,folder='',watchTimer=null,busy=false,scanBusy=false,activeDraft=null;
const resources=()=>app.isPackaged?path.join(process.resourcesPath,'windows'):path.join(__dirname,'windows');
const rootUrl=pathToFileURL(path.join(__dirname,'renderer/index.html')).href;
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{if(win){win.show();win.focus();}});
const status={message:'Sẵn sàng nhập PDF MetLife.',watching:false,platform:process.platform,folder:'',errors:[]};
const stamps=new Map();
let serverClient=null;
let pendingSave=null;
let paymentSaveReady=false;
async function refreshSaveStatus(){
 if(edition.id!=='api-od'||!serverClient){paymentSaveReady=false;return;}
 const health=await serverClient.health().catch(()=>({}));
 paymentSaveReady=health.directPaymentEnabled===true;
}
const patientBrowser={connected:false,url:'',patients:[],page:0,hasMore:false,selectedPatient:null,documents:[],openedId:null};
async function audit(event,data={}){const dest=path.join(app.getPath('userData'),'audit.jsonl');await fs.appendFile(dest,JSON.stringify({at:new Date().toISOString(),event,...data})+'\n',{mode:0o600});}
function state(){return {...workspace.state(),patientBrowser:{...patientBrowser},pendingSave:pendingSave?{...pendingSave}:null,status:{...status},version:app.getVersion(),edition:edition.id,editionName:edition.displayName,paymentSaveReady,apiPaymentReady:paymentSaveReady};}
function notify(){if(win&&!win.isDestroyed())win.webContents.send('metlife:state',state());}
async function scan(){
 if(scanBusy)return;scanBusy=true;status.errors=[];notify();
 try{
  const {scanPdfs}=await import('./lib/workspace.mjs');
  const files=await scanPdfs(folder);
  for(const f of files){
   try{
    const s=await fs.stat(f),mark=`${s.size}:${s.mtimeMs}`;
    if(stamps.get(f)===mark)continue;
    // Avoid files still being downloaded/copied on a network share.
    if(Date.now()-s.mtimeMs<3000)continue;
    const id=await workspace.addPdf(f);stamps.set(f,mark);await audit('pdf-import',{hash:workspace.items.get(id).parsed.sha256});
   }catch(e){status.errors.push(`${path.basename(f)}: ${e.message}`);}
  }
  status.message=`Đã quét ${files.length} PDF. Tự điền chỉ chạy khi bạn chọn bản nháp.`;
 }catch(e){status.errors.push(e.message);status.message='Quét thư mục chưa hoàn tất.';}finally{scanBusy=false;notify();}
}
async function choose(properties,filters,title){const r=await dialog.showOpenDialog(win,{properties,filters,title});return r.canceled?[]:r.filePaths;}
function idArg(id){if(typeof id!=='string'||!workspace.items.has(id))throw new Error('Invalid PDF id');return id;}
async function connectLocal(){
 if(activeDraft)throw new Error('Đóng bản nháp trước khi đổi kết nối.');
 const {autoConnect}=await import('./lib/connection.mjs');
 const client=await autoConnect([...(pendingSave?[pendingSave.serverUrl]:[]),process.env.METLIFE_SERVER_URL||'http://SERVER:3008']);
 if(pendingSave&&pendingSave.serverUrl!==client.connection.url)throw new Error('Cần kết nối đúng SERVER của lượt ghi đang chờ.');
 if(serverClient&&serverClient.connection.url!==client.connection.url){workspace.snapshots.clear();Object.assign(patientBrowser,{patients:[],selectedPatient:null,documents:[],openedId:null});}
 serverClient=client;await refreshSaveStatus();Object.assign(patientBrowser,{connected:true,url:client.connection.url});status.message='Đã kết nối SERVER. Tìm bệnh nhân để bắt đầu.';notify();
}
async function call(op,arg){
 assertEditionAction(edition,op);
 switch(op){
  case 'state':return state();
  case 'reconnect-server':await connectLocal();break;
  case 'login-server':
  case 'connect-server':{
   if(activeDraft)throw new Error('Đóng bản nháp trước khi đổi kết nối SERVER.');
   const {MetlifeClient,validateConnection,loginConnection}=await import('./lib/connection.mjs');
   let c;
   if(op==='login-server')c=await loginConnection(arg||{});
   else{
    const files=await choose(['openFile'],[{name:'Kết nối MetLife R5',extensions:['json']}],'Nhập cấu hình kết nối cũ');if(!files.length)break;
    if((await fs.stat(files[0])).size>65536)throw new Error('File kết nối quá lớn.');
    c=validateConnection(JSON.parse(await fs.readFile(files[0],'utf8')));
   }
   const client=new MetlifeClient(c);
   if(pendingSave&&pendingSave.serverUrl!==c.url)throw new Error('Cần kết nối đúng SERVER của lượt ghi chưa xác minh.');
   await client.health();if(!safeStorage.isEncryptionAvailable())throw new Error('Kho bảo vệ thông tin kết nối chưa sẵn sàng trên máy này.');
   await fs.writeFile(path.join(app.getPath('userData'),'server-connection.enc'),safeStorage.encryptString(JSON.stringify(c)),{mode:0o600});
   serverClient=client;await refreshSaveStatus();workspace.snapshots.clear();Object.assign(patientBrowser,{connected:true,url:c.url,patients:[],selectedPatient:null,documents:[],openedId:null});status.message='Đã kết nối SERVER. Có thể tìm bệnh nhân và mở FINISHED CLAM.';break;
  }
  case 'disconnect-server':{
   if(activeDraft||pendingSave)throw new Error('Hoàn tất bản nháp/lượt ghi trước khi ngắt kết nối SERVER.');
   await fs.unlink(path.join(app.getPath('userData'),'server-connection.enc')).catch(()=>{});serverClient=null;
   Object.assign(patientBrowser,{connected:false,url:'',patients:[],selectedPatient:null,documents:[],openedId:null});workspace.snapshots.clear();status.message='Đã ngắt kết nối SERVER.';break;
  }
  case 'search-patients':{
   if(!serverClient)throw new Error('Kết nối SERVER một lần để tìm bệnh nhân.');
   if(!arg||typeof arg.q!=='string'||!arg.q.trim()||arg.q.length>100||!['all','name','patientId','subscriberId','groupNumber'].includes(arg.kind)||!Number.isInteger(arg.page)||arg.page<0||arg.page>10000)throw new Error('Từ khóa hoặc loại tìm kiếm không hợp lệ.');
   const r=await serverClient.search(arg.q.trim(),arg.kind,arg.page);patientBrowser.connected=true;patientBrowser.patients=r.patients;patientBrowser.page=r.page;patientBrowser.hasMore=r.hasMore;status.message=`Tìm thấy ${r.patients.length} bệnh nhân${r.hasMore?' (còn trang tiếp theo)':''}. Chọn đúng bệnh nhân để xem FINISHED CLAM.`;break;
  }
  case 'patient-documents':{
   if(!serverClient)throw new Error('Chưa kết nối SERVER.');
   const patient=patientBrowser.patients.find(p=>String(p.PatNum)===String(arg));if(!patient)throw new Error('Chọn bệnh nhân trong kết quả tìm kiếm.');
   const r=await serverClient.documents(patient.PatNum);
   const pending=await serverClient.pending(patient.PatNum);if(pending.pending&&pending.operationId){if(pendingSave&&pendingSave.operationId!==pending.operationId)throw new Error('Còn lượt ghi chưa xác minh của bệnh nhân khác.');pendingSave={operationId:pending.operationId,serverUrl:serverClient.connection.url,state:pending.state,at:new Date().toISOString()};await fs.writeFile(path.join(app.getPath('userData'),'pending-save.json'),JSON.stringify(pendingSave),{mode:0o600});}
   patientBrowser.selectedPatient=patient;patientBrowser.documents=r.documents;status.message=`${patient.LName}, ${patient.FName}: ${r.documents.length} PDF trong FINISHED CLAM.`;break;
  }
  case 'open-document':{
   if(!serverClient||!patientBrowser.selectedPatient)throw new Error('Chọn bệnh nhân trước.');
   const patNum=String(patientBrowser.selectedPatient.PatNum),doc=patientBrowser.documents.find(d=>String(d.DocNum)===String(arg)&&String(d.PatNum)===patNum);
   if(!doc)throw new Error('Chọn PDF thuộc FINISHED CLAM của bệnh nhân.');
   const context=await serverClient.context(patNum);const {validateSnapshot}=await import('./lib/reconcile.mjs');validateSnapshot(context);
   if(String(context.patNum)!==patNum)throw new Error('SERVER trả sai bệnh nhân.');
   workspace.snapshots.set(patNum,context);await refreshSaveStatus();
   const bytes=await serverClient.pdf(patNum,doc.DocNum),id=await workspace.addBytes(bytes,doc.FileName,{patNum,docNum:String(doc.DocNum),serverUrl:serverClient.connection.url});
   patientBrowser.openedId=id;status.message='Đã mở PDF và lấy dữ liệu OD mới tự động. Kiểm tra đối chiếu trước khi lưu.';break;
  }
  case 'import-pdf':{
   const files=await choose(['openFile','multiSelections'],[{name:'PDF MetLife',extensions:['pdf']}]);
   status.errors=[];for(const f of files){try{const id=await workspace.addPdf(f);await audit('pdf-import',{hash:workspace.items.get(id).parsed.sha256});}catch(e){status.errors.push(`${path.basename(f)}: ${e.message}`);}}
   status.message=`Đang có ${workspace.items.size} PDF trong hàng đợi.`;break;
  }
  case 'import-snapshot':{
   const files=await choose(['openFile','multiSelections'],[{name:'OD read-only snapshot (.json)',extensions:['json']}],'Chọn JSON snapshot OD tạo trên SERVER; không chọn PDF');
   status.errors=[];let loaded=0;
   for(const f of files){try{await workspace.addSnapshot(f);loaded++;}catch(e){status.errors.push(`${path.basename(f)}: ${e.message}`);}}
   const total=workspace.snapshots.size;
   status.message=loaded?`Đã nạp ${loaded} file snapshot OD; hiện có ${total} bệnh nhân${status.errors.length?`; ${status.errors.length} file lỗi`:''}.`:files.length?`Không nạp được snapshot OD. Hiện có ${total} bệnh nhân; cần JSON snapshot tạo trên SERVER.`:`Chưa nạp thêm snapshot OD. Hiện có ${total} bệnh nhân.`;break;
  }
  case 'choose-folder':{
   const dirs=await choose(['openDirectory']);if(dirs[0]){folder=dirs[0];status.folder=folder;stamps.clear();await scan();}break;
  }
  case 'scan':if(!folder)throw new Error('Chưa chọn thư mục PDF.');await scan();break;
  case 'watch':{
   if(typeof arg!=='boolean')throw new Error('Invalid watch flag');
   if(arg&&!folder)throw new Error('Chọn thư mục trước.');
   clearInterval(watchTimer);watchTimer=null;status.watching=arg;
   if(arg){await scan();watchTimer=setInterval(()=>scan().catch(()=>{}),15000);}break;
  }
  case 'config':{
   if(!arg||typeof arg.noteTemplate!=='string'||arg.noteTemplate.length>2000||typeof arg.paymentType!=='string'||arg.paymentType.length>100)throw new Error('Cấu hình không hợp lệ.');
   workspace.config={schemaVersion:3,noteTemplate:arg.noteTemplate,paymentType:arg.paymentType};
   await fs.writeFile(path.join(app.getPath('userData'),'settings.json'),JSON.stringify(workspace.config),{mode:0o600});break;
  }
  case 'pdf-bytes':return new Uint8Array(workspace.items.get(idArg(arg)).bytes);
  case 'open-pdf':{const item=workspace.items.get(idArg(arg));const error=await shell.openPath(item.path);if(error)throw new Error(error);return true;}
  case 'inspect-od':{const r=await windows.runWindows(resources(),{diagnosticDir:path.join(app.getPath('userData'),'od-diagnostics'),action:'inspect'});if(activeDraft&&!r.modals.includes('Payment')){workspace.snapshots.delete(activeDraft.patNum);activeDraft=null;workspace.preview=null;await audit('preview-closed-externally',{saveState:'unknown'});}status.message=`OD: ${r.title}${r.modals.length?' | Popup: '+r.modals.join(', '):''}`;notify();return r;}
  case 'fill-preview':{
   if(activeDraft||pendingSave)throw new Error('Đang có bản nháp hoặc lượt ghi chưa xác minh; hoàn tất trước khi mở bản khác.');
   const id=idArg(arg),item=workspace.items.get(id);
   let original;
   if(item.remote){
    if(!serverClient)throw new Error('Kết nối lại SERVER trước Auto fill.');
    if(item.remote.serverUrl!==serverClient.connection.url)throw new Error('PDF này thuộc kết nối SERVER khác; tìm lại bệnh nhân trên SERVER hiện tại.');
    const {validateSnapshot}=await import('./lib/reconcile.mjs');
    const context=validateSnapshot(await serverClient.context(item.remote.patNum));
    if(String(context.patNum)!==item.remote.patNum)throw new Error('SERVER trả sai bệnh nhân.');
    workspace.snapshots.set(item.remote.patNum,context);
    original=await serverClient.pdf(item.remote.patNum,item.remote.docNum);
   }
   const draft=workspace.plan(id),matched=workspace.result(item);
   if(!item.remote){
    const snapshot=workspace.snapshots.get(String(matched.patient.PatNum));
    const {sourceDocumentPath}=await import('./lib/reconcile.mjs');
    const source=sourceDocumentPath(snapshot,matched);
    const stat=await fs.stat(source);if(stat.size>30*1024*1024)throw new Error('PDF gốc quá lớn.');
    original=await fs.readFile(source);
   }
   if(createHash('sha256').update(original).digest('hex')!==draft.sha256)throw new Error('Nội dung PDF không trùng tài liệu gốc trên SERVER.');
   // Revalidate a fresh snapshot and all derived values in the privileged process.
   const result=await windows.runWindows(resources(),{diagnosticDir:path.join(app.getPath('userData'),'od-diagnostics'),action:'fill-preview',draft});
   if(!result.windowHandle||!result.paymentTypeApplied||!result.splitsApplied)throw new Error('Chưa điền đủ nội dung trên Open Dental. Kiểm tra cửa sổ đang mở.');
   activeDraft={...draft,windowHandle:result.windowHandle};workspace.preview={id,amount:draft.amount,paymentType:draft.paymentType,paymentTypeApplied:result.paymentTypeApplied,at:new Date().toISOString()};
   await audit('preview-filled',{hash:draft.sha256,saveInvoked:false});
   status.message='Đã tự điền trên Open Dental. Chưa lưu. Kiểm tra bản nháp trên OD; bạn tự quyết định lưu hoặc đóng bản nháp.';break;
  }
  case 'save-payment':{
   await refreshSaveStatus();if(!paymentSaveReady)throw new Error('Chức năng lưu chưa được kích hoạt. Vui lòng liên hệ bộ phận hỗ trợ.');
   if(activeDraft||pendingSave)throw new Error('Còn bản nháp hoặc lượt ghi chưa xác minh. Hoàn tất lượt trước.');
   const id=idArg(arg),item=workspace.items.get(id);
   if(!item.remote||!serverClient||item.remote.serverUrl!==serverClient.connection.url)throw new Error('Lưu cần PDF đã chọn từ SERVER hiện tại.');
   const reviewed=workspace.plan(id);
   const {validateSnapshot}=await import('./lib/reconcile.mjs');
   const fresh=validateSnapshot(await serverClient.context(item.remote.patNum));
   if(String(fresh.patNum)!==item.remote.patNum)throw new Error('SERVER trả sai bệnh nhân.');
   workspace.snapshots.set(item.remote.patNum,fresh);
   const draft=workspace.plan(id);
   if(JSON.stringify(reviewed)!==JSON.stringify(draft))throw new Error('Thông tin OD đã đổi. Kiểm tra lại bảng đối chiếu mới trước khi lưu.');
   const prepared=await serverClient.prepare({patNum:item.remote.patNum,docNum:item.remote.docNum,draft,transport:'direct-db'});
   pendingSave={operationId:prepared.operationId,serverUrl:serverClient.connection.url,itemId:id,at:new Date().toISOString(),state:'started'};
   await fs.writeFile(path.join(app.getPath('userData'),'pending-save.json'),JSON.stringify(pendingSave),{mode:0o600});
   notify();
   let postError=null;
   try{await serverClient.post(prepared.operationId);}
   catch(e){postError=e;
    // Release only a server-confirmed pre-write failure. Network timeouts never retry.
    const operation=await serverClient.operation(prepared.operationId);
    if(['prepared','failed-no-write'].includes(operation.state)){
     const aborted=await serverClient.abort(prepared.operationId);
     if(aborted.released){await fs.unlink(path.join(app.getPath('userData'),'pending-save.json'));pendingSave=null;status.message=`Chưa ghi DB: ${e.message}`;await audit('direct-save-aborted',{hash:draft.sha256});break;}
    }
   }
   const result=await serverClient.verify(prepared.operationId);
   workspace.snapshots.set(item.remote.patNum,validateSnapshot(await serverClient.context(item.remote.patNum)));
   if(result.verified){
    await audit('direct-save-verified',{hash:draft.sha256,payNum:result.payNum});await fs.unlink(path.join(app.getPath('userData'),'pending-save.json'));pendingSave=null;
    status.message=`Đã ghi và xác minh Payment #${result.payNum}, tổng ${result.amount}, ${result.splitNums.length} Splits. Refresh Account trên OD để xem.`;
   }else{
    pendingSave.state='unverified';await fs.writeFile(path.join(app.getPath('userData'),'pending-save.json'),JSON.stringify(pendingSave),{mode:0o600});
    status.message=`Chưa xác minh transaction. ${result.reason}${postError?' '+postError.message:''} Không bấm ghi lại.`;
   }
   break;
  }
  case 'verify-save':{
   if(!pendingSave||!serverClient||pendingSave.serverUrl!==serverClient.connection.url)throw new Error('Kết nối đúng SERVER của lượt ghi đang chờ.');
   const operation=await serverClient.operation(pendingSave.operationId);
   if(edition.id==='client'&&operation.transport==='od-ui'&&operation.state==='prepared'){
    const inspected=await windows.runWindows(resources(),{action:'inspect'});
    if(Array.isArray(inspected.modals)&&inspected.modals.length===0){
     const aborted=await serverClient.abort(pendingSave.operationId);
     if(aborted.released){await fs.unlink(path.join(app.getPath('userData'),'pending-save.json')).catch(()=>{});pendingSave=null;activeDraft=null;workspace.preview=null;status.message='Lượt trước chưa lưu. Mở lại hồ sơ để đối chiếu.';break;}
    }
   }
   if(['direct-db','od-api'].includes(operation.transport)&&['prepared','failed-no-write','aborted-no-change'].includes(operation.state)){
    const aborted=await serverClient.abort(pendingSave.operationId);
    if(aborted.released){await fs.unlink(path.join(app.getPath('userData'),'pending-save.json')).catch(()=>{});pendingSave=null;status.message='SERVER xác nhận lượt trước chưa ghi dữ liệu. Tải lại hồ sơ để đối chiếu.';break;}
   }
   const result=await serverClient.verify(pendingSave.operationId);
   if(result.verified){activeDraft=null;workspace.preview=null;await audit('save-recovered-verified',{payNum:result.payNum});pendingSave=null;await fs.unlink(path.join(app.getPath('userData'),'pending-save.json')).catch(()=>{});status.message=`Đã xác minh Payment #${result.payNum}.`;}
   else status.message=`Chưa xác minh: ${result.reason} Giữ khóa chống nhập lại.`;
   break;
  }
  case 'close-preview':{
   if(!activeDraft)throw new Error('Không có bản nháp do tool đang quản lý.');
   if(pendingSave){const operation=await serverClient.operation(pendingSave.operationId);if(operation.state!=='prepared')throw new Error('Lượt này có thể đã lưu. Kiểm tra kết quả trước khi đóng.');}
   let alreadyClosed=false;
   try{await windows.runWindows(resources(),{diagnosticDir:path.join(app.getPath('userData'),'od-diagnostics'),action:'close-preview',draft:activeDraft});}
   catch(e){
    // The operator may already have saved or closed this preview in OD.
    // Empty UI clears only local draft tracking; it never claims DB success.
    const inspected=await windows.runWindows(resources(),{action:'inspect'});
    if(!Array.isArray(inspected.modals)||inspected.modals.length!==0)throw e;
    alreadyClosed=true;
   }
   await audit('preview-closed',{hash:activeDraft.sha256});workspace.snapshots.delete(activeDraft.patNum);activeDraft=null;workspace.preview=null;status.message=alreadyClosed?'Bản nháp đã được đóng trên Open Dental. Mở lại hồ sơ để đối chiếu kết quả.':'Đã đóng bản nháp.';
   if(pendingSave){const aborted=await serverClient.abort(pendingSave.operationId);if(aborted.released){await fs.unlink(path.join(app.getPath('userData'),'pending-save.json')).catch(()=>{});pendingSave=null;}}
   break;
  }
  case 'export-plan':{
   const id=idArg(arg),item=workspace.items.get(id),result=workspace.result(item);
   const r=await dialog.showSaveDialog(win,{defaultPath:'metlife-review.json',filters:[{name:'JSON',extensions:['json']}]});
   if(!r.canceled)await fs.writeFile(r.filePath,JSON.stringify({exportedAt:new Date().toISOString(),pdf:{...item.parsed,text:undefined},reconciliation:result,draft:result.blocks.length?null:workspace.plan(id)},null,2),{mode:0o600});break;
  }
  case 'remove':{if(workspace.preview?.id===arg)throw new Error('Đóng bản nháp OD trước.');workspace.items.delete(idArg(arg));break;}
  default:throw new Error('Unknown action');
 }
 notify();return state();
}
app.whenReady().then(async()=>{
 Menu.setApplicationMenu(null);
 if(process.platform==='win32'&&app.isPackaged)process.env.NAPI_RS_NATIVE_LIBRARY_PATH=path.join(process.resourcesPath,'native','skia.win32-x64-msvc.node');
 const {Workspace}=await import('./lib/workspace.mjs');workspace=new Workspace();
 try{const saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'pending-save.json'),'utf8'));if(typeof saved.operationId==='string'&&typeof saved.serverUrl==='string')pendingSave=saved;}catch{}
 const {loadConfig}=await import('./lib/config.mjs');
 try{workspace.config=loadConfig(JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'settings.json'),'utf8')));}catch{}
 win=new BrowserWindow({width:1400,height:920,minWidth:1050,minHeight:700,title:edition.productName,webPreferences:{devTools:!app.isPackaged,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e,url)=>{if(url!==rootUrl)e.preventDefault();});
 ipcMain.handle('metlife:call',async(event,op,arg)=>{
  if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==rootUrl)throw new Error('Untrusted sender');
  const read=['state','pdf-bytes','open-pdf'];
  if(busy&&!read.includes(op))return {ok:false,error:'Tool đang thực hiện thao tác khác.'};
  const mutation=!read.includes(op);if(mutation)busy=true;
  try{return {ok:true,data:await call(op,arg)}}catch(e){status.message=e.message;notify();return {ok:false,error:e.message}}finally{if(mutation)busy=false;}
 });
 await win.loadFile(path.join(__dirname,'renderer/index.html'));
 connectLocal().catch(e=>{if(!serverClient){patientBrowser.connected=false;status.message=e.message;notify();}});
 win.on('close',e=>{if(activeDraft){e.preventDefault();status.message='Còn bản nháp OD. Đóng bằng nút Đóng bản nháp trước khi thoát tool.';notify();}});
});
app.on('window-all-closed',()=>{clearInterval(watchTimer);app.quit();});
