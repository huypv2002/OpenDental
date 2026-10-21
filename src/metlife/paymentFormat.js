import {money} from './parser.js';

export function claimPaymentFields(claimNumber,date){
 const claim=String(claimNumber||'').trim().replace(/\s+/g,' ');
 if(!claim||claim.length>64)throw new Error('Thiếu hoặc sai số claim.');
 const parsed=/^\d{4}-\d{2}-\d{2}$/.test(date||'')?new Date(date+'T12:00:00Z'):null;
 if(!parsed||!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==date)throw new Error('Thiếu hoặc sai ngày thanh toán trên EOB.');
 return {claimNumber:claim,date,checkNum:'',note:`Claim number: ${claim}`};
}

export function metlifePaymentFields(parsed){
 if(!parsed.processed)throw new Error('MetLife thiếu ngày PROCESSED on; không dùng Date Received hoặc ngày Payment Detail thay thế.');
 return claimPaymentFields(parsed.claimRaw||parsed.claimBase,parsed.processed);
}

export function claimDocumentFields(claimNumber,date,amountCents){
 const fields=claimPaymentFields(claimNumber,date);
 if(!Number.isSafeInteger(amountCents)||amountCents<0)throw new Error('Số tiền tài liệu EOB không hợp lệ.');
 return {description:`Claim ${fields.claimNumber}  ${money(amountCents)}`,dateCreated:`${date} 00:00:00`};
}
