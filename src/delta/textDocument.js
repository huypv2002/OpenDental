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

// Import user-converted text only. No OCR or PDF conversion is performed.
export function readDeltaTextDocument(bytes){
 if(bytes.length>30*1024*1024)throw new Error('Tài liệu EOB vượt quá 30 MB.');
 const text=decodeClaimText(bytes);
 if(!/DELTA\s+DENTAL/i.test(text)||!/Provider Tools/i.test(text))throw new Error('TXT hiện hỗ trợ mẫu Delta Dental Provider Tools; chưa nhận diện được hãng/mẫu này.');
 const warnings=[];
 const pages=text.split('\f').map(page=>({lines:page.split(/\r\n|\n|\r/).map(line=>{
  // A user-exported TXT may separate the cents with a space ($34 00).
  // Only this explicit currency token is normalized; no digits are inferred.
  const normalized=line.replace(/\$(\d[\d,]*)[ \t]+(\d{2})(?=\s|$)/g,(_,whole,cents)=>{
   warnings.push(`TXT: chuẩn hóa $${whole} ${cents} thành $${whole}.${cents}; vẫn đối chiếu đủ các cột và tổng claim.`);
   return `$${whole}.${cents}`;
  });
  return {text:normalized};
 })}));
 return {extracted:{sha256:createHash('sha256').update(bytes).digest('hex'),pages,sourceFormat:'text',ocr:false,warnings},pdfBytes:bytes};
}
