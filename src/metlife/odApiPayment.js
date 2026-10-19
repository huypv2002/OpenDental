import {readPatientContext} from './context.js';
import {validatePostingPlan} from './posting.js';
export function odApiConfig(){return {enabled:process.env.METLIFE_OD_API_ENABLED==='true',baseUrl:process.env.METLIFE_OD_API_URL||'http://127.0.0.1:30223/api/v1',developerKey:process.env.METLIFE_OD_API_DEVELOPER_KEY||'',customerKey:process.env.METLIFE_OD_API_CUSTOMER_KEY||''};}
export function supportsExactApiSplits(version){const n=String(version).split('.').map(Number);return n.length===4&&n.every(Number.isInteger)&&(n[0]>25||(n[0]===25&&(n[1]>1||(n[1]===1&&n[2]>=11))));}
function checkedConfig(config){
 if(!config.enabled||!config.developerKey||!config.customerKey)throw new Error('OD API payment integration is not configured.');
 if([config.developerKey,config.customerKey].some(s=>typeof s!=='string'||s.length>256||/[\s/]/.test(s)))throw new Error('Invalid OD API credential configuration.');
 const url=new URL(config.baseUrl);
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('OD API must use HTTPS or a loopback service.');
 return {...config,baseUrl:url.href.replace(/\/$/,'')};
}
export async function apiPaymentStatus(pool,{getConfig=odApiConfig}={}){
 const [rows]=await pool.execute("SELECT ValueString FROM preference WHERE PrefName='ProgramVersion'");
 const version=rows[0]?.ValueString||'';let configured=false;
 try{checkedConfig(getConfig());configured=true;}catch{}
 return {configured,version,supportsExactAllocation:supportsExactApiSplits(version),ready:configured&&supportsExactApiSplits(version)};
}
const safeId=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new Error('OD API identity is outside supported integer range.');return n;};
const financial=s=>JSON.stringify({payment:s.tables.payment,paysplit:s.tables.paysplit,claimpayment:s.tables.claimpayment,claimproc:s.tables.claimproc});
export function createOdApiPaymentWriter(pool,{getConfig=odApiConfig,fetchApi=fetch,readContext=readPatientContext}={}){
 return async(op,onProgress=async()=>{})=>{
  let requestStarted=false;
  try{
   const config=checkedConfig(getConfig());
   const status=await apiPaymentStatus(pool,{getConfig});
   if(!status.supportsExactAllocation)throw new Error('Exact procedure amounts require OD API version 25.1.11 or later.');
   const fresh=await readContext(pool,op.patNum),plan=validatePostingPlan(fresh,op.plan);
   if(financial(fresh)!==financial(op.before))throw new Error('Financial data changed before OD API payment.');
   const createBody={PatNum:safeId(plan.patNum),PayAmt:plan.amount,PayType:safeId(plan.paymentTypeDefNum),PayDate:plan.date,CheckNum:plan.checkNum,PayNote:plan.note,isPatientPreferred:'true',procNums:plan.splits.map(s=>safeId(s.ProcNum))};
   const allocation={procNumsAndAmounts:plan.splits.map(s=>({ProcNum:safeId(s.ProcNum),Amount:s.amountCents/100}))};
   async function send(method,endpoint,body){
    const response=await fetchApi(config.baseUrl+endpoint,{method,headers:{Authorization:`ODFHIR ${config.developerKey}/${config.customerKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!response.ok)throw new Error(`OD API payment request failed (HTTP ${response.status}).`);
    const text=await response.text();if(text.length>262144)throw new Error('OD API payment response is too large.');
    try{return text?JSON.parse(text):{};}catch{throw new Error('OD API payment response is not valid JSON.');}
   }
   // Persisted coordinator state already says posting. Never retry a timed-out
   // create, and never replace an API error with a SQL or UI write.
   requestStarted=true;
   const created=await send('POST','/payments',createBody);
   const payNum=String(safeId(created.PayNum));
   await onProgress({payNum,stage:'created'});
   await send('PUT',`/payments/${payNum}/Partial`,allocation);
   const receipt={payNum,stage:'allocated'};await onProgress(receipt);return receipt;
  }catch(e){e.noWrite=!requestStarted;throw e;}
 };
}
