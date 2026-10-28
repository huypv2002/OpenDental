import {createHash} from 'node:crypto';
export function decodeClaimText(bytes){
 let encoding='utf-8',data=bytes;
 if(bytes[0]===0xff&&bytes[1]===0xfe){encoding='utf-16le';data=bytes.subarray(2);}
 else if(bytes[0]===0xfe&&bytes[1]===0xff){encoding='utf-16be';data=bytes.subarray(2);}
 let text;
 try{text=new TextDecoder(encoding,{fatal:true}).decode(data).replace(/\uFEFF/g,'');}
 catch{throw new Error('TXT cần mã hóa UTF-8 hoặc UTF-16 có BOM; chưa đọc được nội dung.');}
 if(text.includes('\0'))throw new Error('TXT chứa ký tự không hợp lệ.');
 return text;
}

const review=message=>Object.assign(new Error(message),{code:'EOB_REVIEW_REQUIRED'});
const tokens=line=>[...line.matchAll(/\(\s*D\d{4}\s*\)|\S+/g)].map(m=>({str:/^\(\s*D\d{4}/.test(m[0])?m[0].match(/D\d{4}/)[0]:m[0],x:m.index,width:m[0].length}));
function anchors(lines,labels){
 const found=labels.map(([label,target])=>{
  const matches=lines.flatMap(l=>tokens(l)).filter(t=>t.str===label);
  const positions=[...new Set(matches.map(t=>t.x))];
  if(!positions.length||(positions.length!==1&&label!=='Date'))return null;
  return [Math.min(...positions),target];
 });
 if(found.some(x=>!x)||found.some((a,i)=>i&&a[0]<=found[i-1][0]))return null;
 return found;
}
function mapX(x,a){
 let i=a.findIndex(p=>p[0]>=x);if(i<0)i=a.length-1;else if(i===0)i=1;
 const [lo,hi]=[a[i-1],a[i]];
 return lo[1]+(x-lo[0])*(hi[1]-lo[1])/(hi[0]-lo[0]);
}
// TXT columns are character offsets, not PDF coordinates. Retain whitespace
// and map verified MetLife headings onto the existing parser's column system.
// CIGNA uses its own headings directly; it does not use MetLife's mapping.
function layoutPage(raw,page,carrier){
 const lines=raw.split(/\r\n|\n|\r/).map(l=>{let out='';for(const ch of l)out+=ch==='\t'?' '.repeat(8-out.length%8):ch;return out;}).filter(l=>l.trim());
 let detailAnchors,paymentAnchors;
 if(carrier==='METLIFE'){
  const start=lines.findIndex(l=>l.trim().replace(/\s+/g,' ')==='Claim Detail'),first=lines.findIndex(l=>/\bD\d{4}\b/.test(l));
  if(start>=0&&first>start){
   const h=lines.slice(start+1,first);
   detailAnchors=anchors(h,[['(Code)',245],['Tooth',405],['Charged',490],['Negotiated',590],['Expense',680],['Applied',770],['Plan',850]]);
   if(!detailAnchors)throw review('TXT MetLife chưa giữ rõ cột Charged / Negotiated / Expense / Applied / Plan; cần xuất TXT giữ bố cục bảng.');
  }
  const payment=lines.findIndex(l=>l.trim().replace(/\s+/g,' ')==='Payment Detail');
  if(payment>=0){
   const end=lines.findIndex((l,i)=>i>payment&&(/\d{2}\/\d{2}\/\d{4}/.test(l)||/^\s*Paid\s*\//.test(l)));
   const h=lines.slice(payment+1,end<0?undefined:end);
   paymentAnchors=anchors(h,[['Status',70],['Date',200],['Paid',310],['Method',660],['ID',800]]);
   if(!paymentAnchors)throw review('TXT MetLife chưa giữ rõ cột Payment Detail; cần xuất TXT giữ bố cục bảng.');
  }
 }
 let paymentSection=false;
 const output=lines.map((line,i)=>{
  if(line.trim().replace(/\s+/g,' ')==='Payment Detail')paymentSection=true;
  const a=paymentSection?paymentAnchors:detailAnchors;
  const items=tokens(line).map(t=>{
   const x=a?mapX(t.x,a):carrier==='CIGNA'?t.x*3:t.x;
   // Mentions of CDT codes in footnotes must not become service rows.
   const str=carrier==='METLIFE'&&/^D\d{4}$/.test(t.str)&&(!detailAnchors||paymentSection||Math.abs(x-245)>15)?`${t.str}.`:t.str;
   return {...t,str,x,y:(i+1)*10};
  });
  return {text:line.trim().replace(/\s+/g,' '),items,y:(i+1)*10};
 });
 return {page,width:carrier==='METLIFE'?1000:(Math.max(1,...lines.map(l=>l.length))+20)*(carrier==='CIGNA'?3:1),height:(lines.length+2)*10,lines:output,items:output.flatMap(l=>l.items)};
}

export function readInsuranceTextDocument(bytes){
 if(bytes.length>30*1024*1024)throw review('Tài liệu EOB vượt quá 30 MB.');
 const text=decodeClaimText(bytes),carriers=[];
 const signature=text.replace(/\s+/g,' ');
 if(/DELTA\s+DENTAL/i.test(signature)&&/Provider Tools/i.test(signature))carriers.push('DELTA DENTAL');
 if(/LIBERTY Dental Plan/i.test(signature)&&/PAYMENT DETAILS/i.test(signature))carriers.push('LIBERTY');
 if(/Claim\/Reference Number:/.test(signature)&&/Date Processed:/.test(signature)&&/Claim Amount Paid:/.test(signature))carriers.push('CIGNA');
 if(/Claim Summary/.test(signature)&&/Relationship to Subscriber:/.test(signature)&&/Claim Detail/.test(signature))carriers.push('METLIFE');
 if(carriers.length!==1)throw review('TXT chưa nhận diện duy nhất mẫu MetLife / Liberty / CIGNA / Delta Dental đã hỗ trợ.');
 const carrier=carriers[0],warnings=[];
 const normalized=text.replace(/\$(\d[\d,]*)[ \t]+(\d{2})(?=\s|$)/g,(all,whole,cents)=>{
  warnings.push(`TXT: đọc $${whole} ${cents} là $${whole}.${cents}.`);
  return `$${whole}.${cents}`.padEnd(all.length,' ');
 });
 // Portal printouts can strand a section title at the bottom of a page while
 // its column headings and payment rows start on the next. Move only that
 // exact trailing title, preserving the remaining page boundary and contents.
 const pageText=normalized.split('\f');
 if(carrier==='METLIFE')for(let i=0;i<pageText.length-1;i++){
  const title=/(?:^|\r?\n)[ \t]*Payment[ \t]+Detail[ \t\r\n]*$/.exec(pageText[i]);
  if(title){pageText[i]=pageText[i].slice(0,title.index);pageText[i+1]='Payment Detail\n'+pageText[i+1];}
 }
 const pages=pageText.map((s,i)=>layoutPage(s,i+1,carrier));
 return {extracted:{sha256:createHash('sha256').update(bytes).digest('hex'),sourceFormat:'text',textCarrier:carrier,ocr:false,warnings,pages},pdfBytes:bytes};
}
