export function validateConnection(value){
 if(!value||typeof value.url!=='string'||typeof value.token!=='string'||value.token.length<32||value.token.length>512)throw new Error('File kết nối SERVER không hợp lệ.');
 const url=new URL(value.url);
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('Kết nối cần HTTPS hoặc localhost.');
 return {url:url.href.replace(/\/$/,''),token:value.token};
}
export class MetlifeClient{
 constructor(connection){this.connection=validateConnection(connection);}
 async request(endpoint,pdf=false,body=undefined){
  const response=await fetch(`${this.connection.url}/api/metlife${endpoint}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.connection.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000),redirect:'error'});
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
 recheck(id){return this.request(`/operations/${encodeURIComponent(id)}/recheck`,false,{});}
 verify(id){return this.request(`/operations/${encodeURIComponent(id)}/verify`,false,{});}
 abort(id){return this.request(`/operations/${encodeURIComponent(id)}/abort`,false,{});}
 operation(id){return this.request(`/operations/${encodeURIComponent(id)}`);}
 pending(patNum){return this.request(`/patients/${encodeURIComponent(patNum)}/pending`);}
 health(){return this.request('/health');}
 search(q,kind='all',page=0){return this.request('/patients?'+new URLSearchParams({q,kind,page:String(page)}));}
 documents(patNum){return this.request(`/patients/${encodeURIComponent(patNum)}/documents`);}
 context(patNum){return this.request(`/patients/${encodeURIComponent(patNum)}/context`);}
 pdf(patNum,docNum){return this.request(`/patients/${encodeURIComponent(patNum)}/documents/${encodeURIComponent(docNum)}/pdf`,true);}
}
