// Older builds stored a compound CIGNA key. Keep API history display canonical
// even before the source PDF is explicitly replayed to migrate saved records.
export function cignaHistoryDisplay(row){
 let details=row.Details;
 try{if(typeof details==='string')details=JSON.parse(details);}catch{return row;}
 if(details?.carrier!=='CIGNA')return row;
 const raw=String(details.displayClaimNumber||row.ClaimNumber||'');
 const claim=/^([DE]\d{12})-\d+-\d+$/.exec(raw)?.[1]||raw;
 const old=row.ClaimNumber;
 const next={...details,claimNumber:claim,displayClaimNumber:claim};
 if(details.paymentNote===`Claim number: ${old}`||/^Claim number: [DE]\d{12}-\d+-\d+$/.test(details.paymentNote||''))next.paymentNote=`Claim number: ${claim}`;
 if(typeof details.documentDescription==='string')next.documentDescription=details.documentDescription.replace(/^Claim [DE]\d{12}-\d+-\d+  /,`Claim ${claim}  `);
 return {...row,ClaimNumber:claim,Details:typeof row.Details==='string'?JSON.stringify(next):next};
}
