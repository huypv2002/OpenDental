import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {extractPdf} from '../metlife/parser.js';

const require=createRequire(import.meta.url);
export const isInsuranceFile=name=>/\.(pdf|jpe?g|png)$/i.test(name);
export const isImageFile=name=>/\.(jpe?g|png)$/i.test(name);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function imagePdf(bytes){
 const {loadImage}=await import('@napi-rs/canvas');const img=await loadImage(bytes);
 if(!img.width||!img.height||img.width*img.height>25000000)throw new Error('Ảnh EOB quá lớn hoặc không hợp lệ.');
 const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();
 const embedded=bytes[0]===0xff?await pdf.embedJpg(bytes):await pdf.embedPng(bytes);
 const page=pdf.addPage([img.width,img.height]);page.drawImage(embedded,{x:0,y:0,width:img.width,height:img.height});
 return Buffer.from(await pdf.save());
}

export function tsvLines(tsv){
 const lines=new Map();
 for(const row of String(tsv||'').split('\n').slice(1)){
  const f=row.split('\t');if(f[0]!=='5'||!f[11]?.trim())continue;
  const key=f.slice(1,5).join('/');const word={text:f.slice(11).join('\t').trim(),x:+f[6],y:+f[7],width:+f[8],height:+f[9],confidence:+f[10]};
  if(!lines.has(key))lines.set(key,[]);lines.get(key).push(word);
 }
 return [...lines.values()].map(words=>({words:words.sort((a,b)=>a.x-b.x),y:Math.min(...words.map(w=>w.y))})).sort((a,b)=>a.y-b.y);
}

function normalizeAmounts(text){
 return text.replace(/\b\d{1,3}(?:[.,]\d{3})+\.\d{2}\b/g,s=>s.slice(0,-3).replace(/[.,]/g,'')+s.slice(-3)).replace(/\b0{3}\b/g,'0.00');
}

async function recognizePage(worker,image){
 const {createCanvas}=await import('@napi-rs/canvas');
 const scale=Math.min(3,Math.sqrt(18000000/(image.width*image.height)));
 const canvas=createCanvas(Math.round(image.width*scale),Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
 await worker.setParameters({tessedit_pageseg_mode:'6',tessedit_char_whitelist:'',preserve_interword_spaces:'1'});
 const {data}=await worker.recognize(canvas.toBuffer('image/png'),{},{text:true,tsv:true});
 const lines=tsvLines(data.tsv),header=lines.find(l=>l.words.some(w=>w.text==='Code')&&l.words.some(w=>w.text==='Tooth')&&l.words.some(w=>w.text==='Surface'));
 if(!header){
  const text=lines.map(l=>l.words.map(w=>w.text).join(' ')).join('\n');
  if(/CLAIM:\s*\d+/i.test(text))throw new Error('Ảnh EOB chưa đọc rõ các cột Code / Tooth / Surface. Cần ảnh rõ hơn.');
  return {width:image.width,height:image.height,lines:text.split('\n').map(text=>({text})),ocrRows:0,ocrConfidence:data.confidence};
 }
 const left=name=>header.words.find(w=>w.text===name).x-7;
 const codeLeft=left('Code'),toothLeft=left('Tooth'),surfaceLeft=left('Surface');
 const dateHeader=header.words.find(w=>/Date/i.test(w.text));if(!dateHeader)throw new Error('Không đọc được cột ngày dịch vụ trong ảnh.');
 const dateLeft=dateHeader.x-7*scale;
 async function cell(line,x,width,whitelist,mode='7'){
  const rowWords=line.words.filter(w=>w.x>=dateLeft&&w.x<toothLeft),top=Math.min(...rowWords.map(w=>w.y))-11,bottom=Math.max(...rowWords.map(w=>w.y+w.height))+17;
  // Re-read a single cell with an alphabet appropriate to that field. No digit substitution.
  const up=4/scale,pad=0,crop=createCanvas(Math.ceil(width*up)+pad*2,Math.ceil((bottom-top)*up)+pad*2);
  const ctx=crop.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,crop.width,crop.height);
  ctx.drawImage(image,x/scale,top/scale,width/scale,(bottom-top)/scale,pad,pad,width*up,(bottom-top)*up);
  await worker.setParameters({tessedit_pageseg_mode:mode,tessedit_char_whitelist:whitelist,preserve_interword_spaces:'0'});
  return (await worker.recognize(crop.toBuffer('image/png'))).data.text.trim().replace(/\s+/g,'');
 }
 const output=[];let rows=0;
 for(const line of lines){
  const text=line.words.map(w=>w.text).join(' ');
  // OCR can join the row number to its date; use overlap, not only the word's left edge.
  const dateWords=line.words.filter(w=>w.x+w.width>dateLeft&&w.x<codeLeft);
  if(dateWords.some(w=>/\d{2}\/\d/.test(w.text))&&line.words.some(w=>w.x>=codeLeft&&w.x<toothLeft)){
   const dateRead=await cell(line,dateLeft,codeLeft-dateLeft,'0123456789/');
   const dateParts=/^(\d{2})\/?(\d{2})\/?(\d{2})$/.exec(dateRead);
   const date=dateParts?`${dateParts[1]}/${dateParts[2]}/${dateParts[3]}`:dateRead;
   const code=await cell(line,codeLeft,toothLeft-codeLeft,'D0123456789');
   const toothWords=line.words.filter(w=>w.x>=toothLeft&&w.x<surfaceLeft);
   let tooth='';
   if(toothWords.length){
    tooth=toothWords.map(w=>w.text).join('');
    if(!/^(?:[1-9]|[12]\d|3[0-2]|[A-T]|Q0[1-4]|UR|UL|LR|LL|UA|LA|FM)$/.test(tooth))tooth=await cell(line,toothLeft,surfaceLeft-toothLeft,'Q0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    tooth=tooth.replace(/^QO([1-4])$/,'Q0$1');
    if(!/^(?:[1-9]|[12]\d|3[0-2]|[A-T]|Q0[1-4]|UR|UL|LR|LL|UA|LA|FM)$/.test(tooth))throw new Error('Ô răng trong ảnh chưa rõ; cần đối chiếu ảnh gốc.');
   }
   if(!/^\d{2}\/\d{2}\/\d{2}$/.test(date)||!/^D\d{4}$/.test(code))throw new Error('Ngày hoặc mã dịch vụ trong ảnh chưa rõ; chưa xử lý thanh toán.');
   const rawDate=dateWords.map(w=>w.text).join('').replace(/\D/g,'').slice(-6);
   if(rawDate!==date.replace(/\D/g,''))throw new Error('Hai lần đọc ngày dịch vụ không khớp.');
   const rawCode=line.words.filter(w=>w.x>=codeLeft&&w.x<toothLeft).map(w=>w.text).join('');
   if(/^D\d{4}$/.test(rawCode)&&rawCode!==code)throw new Error('Hai lần đọc mã dịch vụ không khớp.');
   let number=line.words.find(w=>w.x<dateLeft)?.text;
   const rawNumber=number;
   if(!/^\d+$/.test(number||'')){
    const numberLeft=Math.max(0,dateLeft-(codeLeft-dateLeft)*0.65);
    number=await cell(line,numberLeft,dateLeft-numberLeft,'0123456789');
    if(!/^\d+$/.test(number))number=await cell(line,numberLeft,dateLeft-numberLeft,'0123456789','8');
    if(!/^\d+$/.test(number))number=await cell(line,numberLeft,dateLeft-numberLeft,'0123456789','10');
    // A thin printed row-index 1 can be recognized as I/l/|. This applies only
    // to the non-financial index; validation still requires the full 1..N sequence.
    if(!number&&/^[Il|]$/.test(rawNumber||''))number='1';
   }
   if(!/^\d+$/.test(number||''))throw new Error('Không đọc rõ số thứ tự dịch vụ trong ảnh.');
   output.push(`${number} ${date} ${code} ${tooth} ${normalizeAmounts(line.words.filter(w=>w.x>=surfaceLeft).map(w=>w.text).join(' '))}`.replace(/\s+/g,' '));rows++;
  }else output.push(/CLAIM TOTALS|NET PAYMENT|VENDOR TOTALS|GRAND TOTALS/i.test(text)?normalizeAmounts(text):text);
 }
 if(!rows)throw new Error('Không đọc được dòng dịch vụ Liberty trong ảnh.');
 return {width:image.width,height:image.height,lines:output.map(text=>({text})),ocrRows:rows,ocrConfidence:data.confidence};
}

async function withOcr(run){
 const {createWorker}=await import('tesseract.js');
 const langPath=path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')),'4.0.0_best_int');
 let worker,timer,cancelled=false;
 try{
  return await Promise.race([(async()=>{worker=await createWorker('eng',1,{langPath,cacheMethod:'none',errorHandler:()=>{}});if(cancelled){await worker.terminate();throw new Error('OCR đã hết thời gian.');}return run(worker);})(),new Promise((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(new Error('Đọc ảnh EOB quá thời gian; chưa ghi dữ liệu.'));},120000);})]);
 }finally{clearTimeout(timer);if(worker)await worker.terminate();}
}

export async function readInsuranceDocument(bytes,fileName,{extract=extractPdf,recognize=recognizePage}={}){
 if(bytes.length>30*1024*1024)throw new Error('Tài liệu EOB vượt quá 30 MB.');
 if(!isInsuranceFile(fileName))throw new Error('Chỉ hỗ trợ EOB PDF, JPG, JPEG hoặc PNG.');
 if(isImageFile(fileName)){
  if(!((bytes[0]===0xff&&bytes[1]===0xd8)||bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))throw new Error('Nội dung ảnh EOB không khớp định dạng JPG/PNG.');
  const {loadImage}=await import('@napi-rs/canvas'),image=await loadImage(bytes);
  if(image.width*image.height>25000000)throw new Error('Ảnh EOB vượt quá kích thước hỗ trợ.');
  const page=await withOcr(w=>recognize(w,image));
  return {extracted:{sha256:sha(bytes),pages:[page],sourceFormat:'image',ocr:true},pdfBytes:await imagePdf(bytes)};
 }
 if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('Nội dung EOB không phải PDF.');
 const extracted=await extract(bytes);const chars=extracted.pages.reduce((n,p)=>n+p.lines.map(l=>l.text).join('').length,0);
 if(chars>=120)return {extracted,pdfBytes:bytes};
 // Image-only PDF: rasterize locally, then use exactly the same OCR/table checks.
 const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');const {createCanvas,loadImage}=await import('@napi-rs/canvas');
 const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true});
 try{
  const doc=await task.promise;if(doc.numPages>10)throw new Error('PDF scan EOB vượt quá 10 trang.');
  let rawPdf;
  const pages=await withOcr(async worker=>{const out=[];for(let n=1;n<=doc.numPages;n++){
   const p=await doc.getPage(n),native=p.getViewport({scale:1}),ops=await p.getOperatorList();
   // A single full-page JPEG can be read without re-rasterizing and blurring its small text.
   // Only accept a simple upright image page; composed/rotated pages use the renderer below.
   const identity=[1,0,0,1,0,0],full=[native.width,0,0,native.height,0,0],near=(a,b)=>a.every((x,i)=>Math.abs(x-b[i])<0.01);
   const transforms=ops.fnArray.flatMap((op,i)=>op===OPS.transform?[ops.argsArray[i]]:[]);
   const simple=p.rotate===0&&ops.fnArray.filter(op=>op===OPS.paintImageXObject).length===1&&ops.fnArray.every(op=>[OPS.save,OPS.restore,OPS.transform,OPS.dependency,OPS.paintImageXObject].includes(op))&&transforms.filter(t=>near(t,full)).length===1&&transforms.every(t=>near(t,identity)||near(t,full));
   if(simple){
    const {PDFDocument,PDFName,PDFRawStream}=await import('pdf-lib');rawPdf ||= await PDFDocument.load(bytes);
    const objects=rawPdf.getPage(n-1).node.Resources()?.lookup(PDFName.of('XObject'));
    const entries=objects?.entries?.()||[];
    if(entries.length===1){
     const stream=rawPdf.context.lookup(entries[0][1]);
     if(stream instanceof PDFRawStream&&String(stream.dict.get(PDFName.of('Filter')))==='/DCTDecode'){
      const image=await loadImage(Buffer.from(stream.getContents()));
      if(image.width*image.height>25000000)throw new Error('Ảnh trong PDF scan EOB quá lớn.');
      out.push(await recognize(worker,image));p.cleanup();continue;
     }
    }
   }
   const viewport=p.getViewport({scale:2});
   if(viewport.width*viewport.height>25000000)throw new Error('Trang PDF scan EOB quá lớn.');
   const c=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await p.render({canvasContext:c.getContext('2d'),viewport}).promise;
   out.push(await recognize(worker,await loadImage(c.toBuffer('image/png'))));p.cleanup();
  }return out;});
  return {extracted:{sha256:sha(bytes),pages,sourceFormat:'scanned-pdf',ocr:true},pdfBytes:bytes};
 }catch(e){e.code='EOB_REVIEW_REQUIRED';throw e;}finally{await task.destroy();}
}
