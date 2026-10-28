import {readInsuranceDocument,tsvLines,isImageFile} from '../liberty/document.js';

// A complete high-confidence whole-page word is a second reading, independent
// of the cell crops. Never reconstruct digits or outvote a conflicting valid crop.
export function agreeDeltaMoneyCell(reads,words,width,left,right){
 const valid=reads.filter(s=>/^\$?\d[\d,]*\.\d{2}$/.test(s));
 if(!valid.length||new Set(valid.map(s=>s.replace(/^\$/,''))).size!==1)return null;
 const overlapping=words.filter(w=>w.x+w.width>left*width&&w.x<right*width);
 if(overlapping.length!==1)return null;
 const word=overlapping[0];
 if(word.x<left*width||word.x+word.width>right*width||!Number.isFinite(word.confidence)||word.confidence<90)return null;
 if(!/^\$?\d[\d,]*\.\d{2}$/.test(word.text)||word.text.replace(/^\$/,'')!==valid[0].replace(/^\$/,''))return null;
 return valid[0];
}

export function alignDeltaTotalRows(lines,width){
 const columns=[[.38,.466],[.466,.542],[.542,.637],[.637,.73],[.807,.902],[.902,.99]],out=[];
 const money=w=>/^\$?\d[\d,]*\.\d{2}$/.test(w.text);
 for(let i=0;i<lines.length;i++){
  const row=lines[i],next=lines[i+1];
  // The large Claim total label can sit higher than its monetary baseline.
  // Use the actual six numeric boxes for crop alignment; do not invent digits
  // from the label's vertical position or merge neighboring service rows.
  if(/^Claim total\b/i.test(row.text)&&next&&row.words.filter(money).length<6&&next.words.every(w=>money(w)||w.text==='-')){
   const words=[...row.words,...next.words],values=words.filter(money);
   if(values.length===6&&columns.every(([a,b])=>values.filter(w=>(w.x+w.width/2)/width>=a&&(w.x+w.width/2)/width<b).length===1)){
    const centers=values.map(w=>w.y+w.height/2).sort((a,b)=>a-b);
    out.push({cy:(centers[2]+centers[3])/2,words,text:words.map(w=>w.text).join(' ')});i++;continue;
   }
  }
  out.push(row);
 }
 return out;
}

// This reader supports the Delta Provider Tools table, not arbitrary EOB layouts.
// Cell boundaries are tied to verified headings; changed layouts require review.
export async function recognizeDeltaPage(worker,image,{imageLayout=false}={}){
 const {createCanvas}=await import('@napi-rs/canvas');
 const scale=Math.min(2,Math.sqrt(18000000/(image.width*image.height)));
 const c=createCanvas(Math.round(image.width*scale),Math.round(image.height*scale));c.getContext('2d').drawImage(image,0,0,c.width,c.height);
 await worker.setParameters({tessedit_pageseg_mode:'3',tessedit_char_whitelist:'',preserve_interword_spaces:'1'});
 const {data}=await worker.recognize(c.toBuffer('image/png'),{},{text:true,tsv:true});
 const words=tsvLines(data.tsv).flatMap(l=>l.words),lines=[];
 for(const w of words.sort((a,b)=>a.y+a.height/2-b.y-b.height/2)){
  const cy=w.y+w.height/2;let l=lines.find(l=>Math.abs(l.cy-cy)<Math.max(5,w.height*.45));
  if(!l){l={cy,words:[]};lines.push(l);}l.words.push(w);
 }
 lines.sort((a,b)=>a.cy-b.cy);for(const l of lines){l.words.sort((a,b)=>a.x-b.x);l.text=l.words.map(w=>w.text).join(' ');}
 const heading=words.find(w=>w.text==='Submitted');
 if(!heading||Math.abs(heading.x/c.width-.394)>.025||[['Accepted',.475],['deductible',.65],['allowance',.55],['benefit',.744],['Patient',.913]].some(([label,x])=>!words.some(w=>w.text===label&&Math.abs(w.x/c.width-x)<.03)))throw new Error('Chưa nhận diện đúng các cột bảng Delta Dental; cần đối chiếu.');
 async function cell(l,left,right,whitelist){
  const h=Math.max(...l.words.map(w=>w.height)),top=Math.max(0,l.cy-h/2-5*scale),bottom=Math.min(c.height,l.cy+h/2+5*scale);
  const reads=[];let lastCrop;
  // Money glyphs need 3x crops: 2x can merge thin 1s; 4x can lose decimal dots.
  // Keep date/code recognition unchanged and cross-check complete monetary reads.
  const attempts=whitelist.startsWith('$')?[['7',3],['6',3],['13',3]]:[['7',2],['7',3],['13',2]];
  for(const [mode,up] of attempts){
   const crop=createCanvas(Math.ceil((right-left)*c.width*up),Math.ceil((bottom-top)*up));const ctx=crop.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,crop.width,crop.height);ctx.drawImage(c,left*c.width,top,(right-left)*c.width,bottom-top,0,0,crop.width,crop.height);
   lastCrop=crop;await worker.setParameters({tessedit_pageseg_mode:mode,tessedit_char_whitelist:whitelist,preserve_interword_spaces:'0'});reads.push((await worker.recognize(crop.toBuffer('image/png'))).data.text.replace(/\s/g,''));
  }
  const valid=reads.filter(s=>whitelist.includes('/')?/^\d{2}\/\d{2}\/\d{4}$/.test(s):whitelist.startsWith('D')?/^D\d{4}$/.test(s):/^\$?\d[\d,]*\.\d{2}$/.test(s));
  if(valid.length>=2&&new Set(valid.map(s=>s.replace(/^\$/,''))).size===1)return valid[0];
  if(whitelist.startsWith('$')){
   const agreed=agreeDeltaMoneyCell(reads,l.words,c.width,left,right);
   if(agreed!==null)return agreed;
  }
  if(whitelist.startsWith('D')){
   // Thin printed 1s are merged as M/I by whole-word OCR. Segment the five
   // separated glyphs, keeping the financial cells on the strict money path.
   const inkThreshold=imageLayout?160:130;
   const ctx=lastCrop.getContext('2d'),pixels=ctx.getImageData(0,0,lastCrop.width,lastCrop.height).data,spans=[];let start;
   for(let x=0;x<lastCrop.width;x++){
    let dark=0;for(let y=0;y<lastCrop.height;y++){const i=(y*lastCrop.width+x)*4;if(pixels[i]<inkThreshold&&pixels[i+1]<inkThreshold&&pixels[i+2]<inkThreshold)dark++;}
    if(dark>2)start??=x;else if(start!==undefined){spans.push([start,x]);start=undefined;}
   }
   for(let i=spans.length-1;i>0;i--)if(spans[i][0]-spans[i-1][1]<=(imageLayout?3:2)){spans[i-1][1]=spans[i][1];spans.splice(i,1);}
   if(spans.length===5){
    let code='';
    for(let n=0;n<5;n++){
     const [left,right]=spans[n];let top=lastCrop.height,bottom=0;
     for(let y=0;y<lastCrop.height;y++)for(let x=left;x<right;x++){const i=(y*lastCrop.width+x)*4;if(pixels[i]<inkThreshold){top=Math.min(top,y);bottom=Math.max(bottom,y);}}
     if(n&&right-left<(bottom-top)*.24){code+='1';continue;}
     const glyph=createCanvas((right-left)+40,bottom-top+41),gc=glyph.getContext('2d');gc.fillStyle='white';gc.fillRect(0,0,glyph.width,glyph.height);gc.drawImage(lastCrop,left,top,right-left,bottom-top+1,20,20,right-left,bottom-top+1);
     await worker.setParameters({tessedit_pageseg_mode:'10',tessedit_char_whitelist:n?'0123456789':'D'});const s=(await worker.recognize(glyph.toBuffer('image/png'))).data.text.trim();code+=(!n&&!s&&reads.filter(s=>s.startsWith('D')).length>=2)?'D':s;
    }
    if(/^D\d{4}$/.test(code)&&valid.every(s=>s===code))return code;
   }
  }
  throw Object.assign(new Error('Các lần đọc ô bảng Delta không khớp; cần đối chiếu tài liệu gốc.'),{ocrCell:{left,right,reads,row:l.text}});
 }
 const result=[];
 for(const l of imageLayout?alignDeltaTotalRows(lines,c.width):lines){
  const date=l.words.find(w=>w.x/c.width>(imageLayout?.095:.115)&&w.x/c.width<.18&&/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(w.text));
  if(date){
   const serviceDate=await cell(l,imageLayout?Math.max(.09,date.x/c.width-.005):.12,imageLayout?Math.min(.207,(date.x+date.width)/c.width+.005):.207,'0123456789/');
   if(/^\d{2}\/\d{2}\/\d{4}$/.test(date.text)&&date.text!==serviceDate)throw new Error('Hai lần đọc ngày dịch vụ Delta không khớp.');
   const codeWords=l.words.filter(w=>(w.x+w.width/2)/c.width>.18&&(w.x+w.width/2)/c.width<.28&&/^[D0][A-Za-z0-9]{2,}$/.test(w.text));
   if(imageLayout&&!codeWords.length)throw new Error('Chưa nhận diện vị trí mã dịch vụ Delta; cần đối chiếu.');
   const codeLeft=imageLayout?.19:.207,codeRight=imageLayout?.27:.286;
   const code=await cell(l,codeLeft,codeRight,'D0123456789');
   if(!/^D\d{4}$/.test(code))throw new Error('Chưa đọc rõ mã dịch vụ Delta Dental.');
   const tooth=l.words.filter(w=>w.x/c.width>=.286&&w.x/c.width<.333).map(w=>w.text).join('');
   const money=[];for(const [a,b] of [[.39,.471],[.471,.547],[.547,.643],[.643,.736],[.813,.908],[.908,.99]]){
    const s=await cell(l,a,!imageLayout&&b===.99?.975:b,'$0123456789,.-');if(!/^\$?\d[\d,]*\.\d{2}$/.test(s))throw new Error('Chưa đọc rõ số tiền dịch vụ Delta Dental.');money.push(s.startsWith('$')?s:'$'+s);
   }
   const percent=l.words.find(w=>w.x/c.width>=.736&&w.x/c.width<.813&&/^\d+(?:\.\d+)?%$/.test(w.text))?.text;
   if(!percent)throw new Error('Thiếu tỷ lệ hưởng dịch vụ Delta Dental.');
   const explanation=l.words.filter(w=>w.x/c.width<.115).map(w=>w.text).join('');
   result.push({text:`${/^[A-Z]+$/.test(explanation)?explanation+' ':''}${serviceDate} ${code} ${tooth||'-'} ${money.slice(0,4).join(' ')} ${percent} ${money.slice(4).join(' ')}`});
  }else if(/^Claim total\b/i.test(l.text)){
   const money=[];for(const [a,b] of [[.38,.466],[.466,.542],[.542,.637],[.637,.73],[.807,.902],[.902,.99]]){
    const s=await cell(l,a,!imageLayout&&b===.99?.975:b,'$0123456789,.-');if(!/^\$?\d[\d,]*\.\d{2}$/.test(s))throw new Error('Chưa đọc rõ tổng claim Delta Dental.');money.push(s.startsWith('$')?s:'$'+s);
   }result.push({text:'Claim total '+money.join(' ')});
  }else result.push({text:l.text});
 }
 return {width:c.width,height:c.height,lines:result,ocrConfidence:data.confidence};
}

export function readDeltaDocument(bytes,fileName,options={}){
 return readInsuranceDocument(bytes,fileName,{...options,recognize:(worker,image)=>recognizeDeltaPage(worker,image,{imageLayout:isImageFile(fileName)})});
}
