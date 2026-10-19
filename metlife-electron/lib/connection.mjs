import net from 'node:net';
export const DEFAULT_SERVER_URL='http://SERVER:3008';
export function localServerUrl(value){
 try{const u=new URL(value);if(u.protocol!=='http:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')return false;
 const h=u.hostname.toLowerCase();if(['server','localhost','127.0.0.1','[::1]'].includes(h)||(!h.includes('.')&&/^[a-z0-9_-]+$/i.test(h))||h.endsWith('.local'))return true;
 if(net.isIP(h)!==4)return false;const p=h.split('.').map(Number);return p[0]===10||p[0]===192&&p[1]===168||p[0]===172&&p[1]>=16&&p[1]<=31;
 }catch{return false;}
}
export async function autoConnect(urls=[DEFAULT_SERVER_URL, 'http://127.0.0.1:3008', 'http://localhost:3008']){
 for(const url of urls){if(!localServerUrl(url))continue;try{const client=new MetlifeClient({url,token:''});await client.health();return client;}catch{}}
 throw new Error('Chưa kết nối được SERVER trong mạng phòng khám. Kiểm tra SERVER và cổng 3008 rồi bấm Kết nối lại.');
}
export async function loginConnection({url=DEFAULT_SERVER_URL,username,password}){
 const base=validateConnection({url,token:'x'.repeat(64)}).url;
 if(typeof username!=='string'||!username.trim()||username.length>64||typeof password!=='string'||!password||password.length>512)throw new Error('Nhập tài khoản và mật khẩu quản trị LUK Dental.');
 const r=await fetch(base+'/api/metlife/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username.trim(),password}),signal:AbortSignal.timeout(30000),redirect:'error'});
 const text=await r.text();if(text.length>8192)throw new Error('SERVER trả sai định dạng.');
 let data;try{data=JSON.parse(text);}catch{throw new Error('SERVER cần cập nhật API đăng nhập MetLife.');}
 if(!r.ok||!data.ok)throw new Error(data.error||'Đăng nhập SERVER chưa thành công.');
 return validateConnection({url:base,token:data.data.token});
}
export function validateConnection(value){
 if(!value||typeof value.url!=='string'||typeof value.token!=='string'||(value.token.length<32&&!(value.token===''&&localServerUrl(value.url)))||value.token.length>2048)throw new Error('File kết nối SERVER không hợp lệ.');
 const url=new URL(value.url);
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&localServerUrl(value.url))))throw new Error('Kết nối cần HTTPS hoặc localhost.');
 return {url:url.href.replace(/\/$/,''),token:value.token};
}
export class MetlifeClient{
 constructor(connection){this.connection=validateConnection(connection);}
 async request(endpoint,pdf=false,body=undefined){
  const timeoutMs=endpoint==='/scan'?90000:30000;
  const response=await fetch(`${this.connection.url}/api/metlife${endpoint}`,{method:body===undefined?'GET':'POST',headers:{...(this.connection.token?{Authorization:`Bearer ${this.connection.token}`}:{'X-LUK-Desktop':'metlife'}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
  const limit=pdf?30*1024*1024:30*1024*1024;
  if(Number(response.headers.get('content-length')||0)>limit)throw new Error('Phản hồi SERVER quá lớn.');
  const chunks=[];let total=0;
  for await(const chunk of response.body){total+=chunk.length;if(total>limit){await response.body.cancel().catch(()=>{});throw new Error('Phản hồi SERVER quá lớn.');}chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(pdf&&response.ok&&response.headers.get('content-type')?.startsWith('application/pdf'))return bytes;
  let result;try{result=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('SERVER chưa có API MetLife hoặc trả sai định dạng.');}
  if(!response.ok||!result.ok)throw new Error(result.error||'Không lấy được dữ liệu MetLife.');return result.data;
 }
 prepare(args){return this.request('/operations',false,args);}
 post(id){return this.request(`/operations/${encodeURIComponent(id)}/post`,false,{});}
 beginUiSave(id){return this.request(`/operations/${encodeURIComponent(id)}/begin-ui-save`,false,{});}
 recheck(id){return this.request(`/operations/${encodeURIComponent(id)}/recheck`,false,{});}
 verify(id){return this.request(`/operations/${encodeURIComponent(id)}/verify`,false,{});}
 abort(id){return this.request(`/operations/${encodeURIComponent(id)}/abort`,false,{});}
 operation(id){return this.request(`/operations/${encodeURIComponent(id)}`);}
 pending(patNum){return this.request(`/patients/${encodeURIComponent(patNum)}/pending`);}
 health(){return this.request('/health');}
 apiStatus(){return this.request('/diagnostics/api');}
 diagnostics(){return this.request('/diagnostics/database');}
 search(q,kind='all',page=0){return this.request('/patients?'+new URLSearchParams({q,kind,page:String(page)}));}
 documents(patNum){return this.request(`/patients/${encodeURIComponent(patNum)}/documents`);}
 context(patNum){return this.request(`/patients/${encodeURIComponent(patNum)}/context`);}
 pdf(patNum,docNum){return this.request(`/patients/${encodeURIComponent(patNum)}/documents/${encodeURIComponent(docNum)}/pdf`,true);}
 history(){return this.request('/history');}
 scan(){return this.request('/scan',false,{});}
}
