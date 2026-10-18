// Synthetic test document only. No clinic records or copied patient documents.
module.exports=function syntheticMetlife(){
 const text=(x,y,s)=>`BT /F1 9 Tf 1 0 0 1 ${x} ${792-y} Tm (${s.replace(/[\\()]/g,'\\$&')}) Tj ET\n`;
 let first=text(25,35,'MetLife Claim Summary')+text(25,60,'Relationship to Subscriber: Self')+text(25,80,'Group Number: G123')+text(25,100,'Claim Number: 1234567890 99')+text(25,120,'Patient Name: TEST')+text(25,140,'Subscriber Name: TEST PERSON')+text(25,160,'Date Received: 09/16/2026')+text(25,180,'PROCESSED on 09/17/2026')+text(25,210,'Claim Detail');
 ['D0150','D1110','D0210','D0220','D0230','D0274','D1206'].forEach((code,i)=>{const y=240+i*22,amt=[100,120,222,0,0,0,0][i];first+=text(10,y,'09/13/2026')+text(110,y,code)+text(170,y,'Approved')+text(290,y,`$${amt.toFixed(2)}`)+text(390,y,`$${amt.toFixed(2)}`)+text(450,y,'$0.00')+text(500,y,`$${amt.toFixed(2)}`);});
 first+=text(25,420,'Total')+text(500,420,'$442.00');
 const second=text(25,35,'Payment Detail')+text(10,80,'Paid / Settled')+text(90,80,'09/17/2026')+text(170,80,'$442.00')+text(380,80,'EFT')+text(460,80,'000012345678901234');
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',...[first,second].map(s=>`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}endstream`)];
 let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((s,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${s}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf);
};
