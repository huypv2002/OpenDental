import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import scribe from 'scribe.js-ocr';
import {scribePagesToText} from './pdfToTextLayout.js';
const require=createRequire(import.meta.url);
const [input,output]=process.argv.slice(2);
let doc;
try{
 scribe.opt.workerN=2;
 scribe.opt.langPath=path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')),'4.0.0');
 doc=await scribe.openDocument([input]);
 if(!doc.inputData.pageCount||doc.inputData.pageCount>10)throw new Error('PDF EOB cần từ 1 đến 10 trang.');
 // Scribe selects native PDF text or image recognition per page. The app never
 // crops financial cells or sends a document to a remote conversion service.
 if(doc.inputData.pdfType!=='text')for(const pm of doc.pageMetrics){const scale=Math.min(1.5,Math.sqrt(24000000/(pm.dims.width*pm.dims.height)));pm.dims.width=Math.round(pm.dims.width*scale);pm.dims.height=Math.round(pm.dims.height*scale);}
 const candidates=[];
 const modes=doc.inputData.pdfType==='text'?[{vanillaMode:true,psm:'6'}]:[
  {vanillaMode:true,psm:'6'},{vanillaMode:true,psm:'3'},
  {vanillaMode:false,psm:'6'},{vanillaMode:false,psm:'3'}
 ];
 for(const mode of modes){
  await doc.recognize({langs:['eng'],ocrPages:'auto',vanillaMode:mode.vanillaMode,combineMode:'none',config:{tessedit_pageseg_mode:mode.psm}});
  const text=scribePagesToText(doc.ocr.active,doc.pageMetrics);
  if(text.trim())candidates.push({text,mode});
 }
 if(!candidates.length)throw new Error('Thư viện không xuất được chữ từ PDF.');
 await fs.writeFile(output,JSON.stringify({candidates,native:doc.inputData.pdfType==='text'}),{mode:0o600});
}catch(error){
 // Report only our bounded operational messages, not library input/stack dumps.
 const message=/^(PDF EOB cần|Thư viện)/.test(error.message)?error.message:'Thư viện PDF sang TXT không hoàn thành; cần kiểm tra tài liệu.';
 if(process.send)process.send({error:message});
 process.exitCode=1;
}finally{
 if(doc)await doc.close().catch(()=>{});
 await scribe.terminate().catch(()=>{});
}
