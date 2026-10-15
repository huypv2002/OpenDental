import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
const ttl=30*24*60*60*1000;
export function issueSession(secret,admin,now=Date.now()){
 const body=Buffer.from(JSON.stringify({aud:'metlife',sub:String(admin.adminId),exp:now+ttl,id:randomUUID()})).toString('base64url');
 return `ml1.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function readSession(secret,token,now=Date.now()){
 try{
  if(typeof token!=='string'||token.length>2048)return null;
  const [prefix,body,sig,...extra]=token.split('.');if(prefix!=='ml1'||!body||!sig||extra.length)return null;
  const expected=createHmac('sha256',secret).update(body).digest(),actual=Buffer.from(sig,'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
  const data=JSON.parse(Buffer.from(body,'base64url').toString());
  return data.aud==='metlife'&&/^\d+$/.test(data.sub)&&Number.isFinite(data.exp)&&data.exp>now&&data.exp<=now+ttl?data:null;
 }catch{return null;}
}
export function loginLimiter(now=()=>Date.now()){
 const buckets=new Map();
 return key=>{
  const time=now();for(const [k,b] of buckets)if(b.until<=time)buckets.delete(k);
  const bucket=buckets.get(key)||{count:0,until:time+15*60*1000};
  if(buckets.size>=10000&&!buckets.has(key))return false;
  buckets.set(key,bucket);return ++bucket.count<=10;
 };
}
