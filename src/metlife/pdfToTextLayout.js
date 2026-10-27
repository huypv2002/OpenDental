// Scribe exposes word coordinates. Rebuild visual rows rather than its logical
// reading order, which can emit each financial table column separately.
export function scribePagesToText(pages,pageMetrics){
 return pages.map((page,index)=>{
  if(!page?.lines||!pageMetrics[index]?.dims?.width)throw new Error('Thư viện PDF chưa xuất đủ trang/chữ.');
  const width=pageMetrics[index].dims.width,rows=[];
  const words=page.lines.flatMap(l=>l.words||[]).filter(w=>w.text?.trim()).map(w=>{if(!w.bbox||!['left','right','top','bottom'].every(k=>Number.isFinite(w.bbox[k])))throw new Error('Thư viện xuất vị trí chữ không hợp lệ.');return w;}).map(w=>({text:w.text,bbox:w.bbox}));
  for(const w of words.sort((a,b)=>(a.bbox.top+a.bbox.bottom)-(b.bbox.top+b.bbox.bottom))){
   const cy=(w.bbox.top+w.bbox.bottom)/2,h=w.bbox.bottom-w.bbox.top;
   let row=rows.find(r=>Math.abs(r.cy-cy)<=Math.max(2,Math.min(r.h,h)*.38));
   if(!row){row={cy,h,words:[]};rows.push(row);}
   row.words.push(w);
  }
  return rows.sort((a,b)=>a.cy-b.cy).map(row=>{
   let text='';for(const w of row.words.sort((a,b)=>a.bbox.left-b.bbox.left)){
    const target=Math.max(0,Math.round(w.bbox.left/width*240));
    text=text.padEnd(Math.max(target,text.length?text.length+1:0),' ')+w.text;
   }return text;
  }).join('\n');
 }).join('\f');
}
