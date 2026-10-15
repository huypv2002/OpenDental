let state=null,selected=null,view='review',working=false,pdfToken=0;
let lastSearch={q:'',kind:'all',page:0};
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=n=>n===null||n===undefined?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
const events=[];let lastMessage='';
async function request(op,arg){const r=await window.metlife.call(op,arg);if(!r.ok)throw new Error(r.error);return r.data;}
function toast(msg){$('#toast').textContent=msg;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6500);}
async function action(op,arg){if(working)return;working=true;document.body.setAttribute('aria-busy','true');updateButtons();try{const s=await request(op,arg);if(s?.items){if(op==='open-document'){selected=s.patientBrowser.openedId;view='review';$('nav [data-tab="queue"]').click();}render(s);}return s;}catch(e){toast(e.message);}finally{working=false;document.body.removeAttribute('aria-busy');updateButtons();}}
function updateButtons(){document.querySelectorAll('[data-action],#import-pdf,#import-snapshot,#choose-folder,#scan,#inspect-od,#save-settings,#empty-import,#connect-server,#disconnect-server,#search-patients,#patients-prev,#patients-next,#refresh-documents,#verify-save').forEach(b=>b.disabled=working||b.dataset.blocked==='true');}
function field(label,value,cls=''){return `<div><span class="field-label">${esc(label)}</span><span class="field-value ${cls}">${esc(value||'—')}</span></div>`;}
function addEvent(message){if(!message||message===lastMessage)return;lastMessage=message;events.unshift({at:new Date().toLocaleTimeString('vi-VN'),message});$('#events').innerHTML=events.map(e=>`<div class="event"><time>${esc(e.at)}</time>${esc(e.message)}</div>`).join('');}
function render(s){
 state=s;if(!selected||!s.items.some(i=>i.id===selected))selected=s.items[0]?.id||null;
 $('#version').textContent=`v${s.version}`;$('#status-text').textContent=s.status.message;$('#runtime').textContent=s.status.platform==='win32'?'Windows · OD UI Automation':'macOS · Đọc & đối chiếu PDF';
 $('#folder-path').textContent=s.status.folder||'Chưa chọn thư mục';$('#folder-path').title=s.status.folder||'';$('#watch').checked=s.status.watching;
 $('#count-total').textContent=s.items.length;$('#count-ready').textContent=s.items.filter(i=>!i.result.blocks.length).length;$('#count-blocked').textContent=s.items.filter(i=>i.result.blocks.length).length;$('#count-snapshots').textContent=s.snapshots.length;
 $('#snapshot-list').textContent=s.snapshots.length?s.snapshots.map(p=>`PatNum ${p.patNum} · ${new Date(p.capturedAt).toLocaleString('vi-VN')}`).join(' | '):'Chưa nạp snapshot.';
 if(document.activeElement!==$('#note-template'))$('#note-template').value=s.config.noteTemplate;
 if(document.activeElement!==$('#payment-type'))$('#payment-type').value=s.config.paymentType;
 $('#pending-save-banner').hidden=!s.pendingSave;
 addEvent(s.status.message);for(const e of s.status.errors)addEvent(e);
 renderPatients();renderList();renderDetail();updateButtons();
}
function renderPatients(){
 const b=state.patientBrowser||{patients:[],documents:[]};
 $('#server-status').textContent=b.connected?`Đã kết nối ${b.url} · Tìm bệnh nhân để xem FINISHED CLAM.`:'Chưa kết nối SERVER. Chọn file kết nối một lần; dữ liệu OD sẽ được lấy tự động.';
 $('#connect-server').textContent=b.connected?'Đổi kết nối SERVER':'Kết nối SERVER';
 $('#patient-results').innerHTML=b.patients.map(p=>`<tr class="${String(b.selectedPatient?.PatNum)===String(p.PatNum)?'patient-selected':''}"><td><b class="patient-name">${esc(p.LName)}, ${esc(p.FName)}</b><br><small>Patient ID ${esc(p.PatNum)}${p.ChartNumber?' · Chart '+esc(p.ChartNumber):''}</small></td><td>${esc(p.Birthdate||'—')}</td><td class="patient-insurance">${(p.insurance||[]).map(i=>`${esc(i.CarrierName)}<br>Subscriber: ${esc(i.SubscriberID||'—')}<br>Group: ${esc(i.GroupNum||'—')}`).join('<hr>')||'—'}</td><td><button class="small" data-patient="${esc(p.PatNum)}" data-action="patient-documents">Xem hồ sơ</button></td></tr>`).join('');
 $('#patient-results-empty').hidden=!!b.patients.length;
 $('#patients-prev').dataset.blocked=String(!b.connected||!b.page);$('#patients-next').dataset.blocked=String(!b.connected||!b.hasMore);$('#refresh-documents').dataset.blocked=String(!b.selectedPatient);
 const p=b.selectedPatient;$('#documents-patient').textContent=p?`${p.LName}, ${p.FName} · Patient ID ${p.PatNum}`:'Chọn bệnh nhân để xem tài liệu';
 $('#patient-documents').innerHTML=b.documents.length?b.documents.map(d=>`<div class="document-row"><div class="document-symbol">PDF</div><div class="doc-info"><strong>${esc(d.FileName)}</strong><p>${esc(d.Description||'')}<br>${esc(d.DateCreated||'')} · DocNum ${esc(d.DocNum)}</p></div><button class="primary small" data-document="${esc(d.DocNum)}" data-action="open-document">Chọn PDF</button></div>`).join(''):`<div class="empty"><div class="document-symbol">PDF</div><p>${p?'Không có PDF trong FINISHED CLAM của bệnh nhân này.':'Chọn bệnh nhân để lấy tài liệu từ Imaging.'}</p></div>`;
}
function renderList(){
 const q=$('#search').value.trim().toLowerCase();
 const items=state.items.filter(i=>`${i.name} ${i.parsed.patient} ${i.parsed.claimRaw}`.toLowerCase().includes(q));
 $('#file-list').innerHTML=items.map(i=>`<button class="file-card ${i.id===selected?'active':''}" data-file="${i.id}" aria-pressed="${i.id===selected}"><strong>${esc(i.name)}</strong><span class="file-meta"><span>${esc(i.parsed.patient||'Chưa nhận diện')}</span><span>${usd(i.parsed.payment?.amountCents)}</span></span><span class="file-meta"><span>Claim ${esc(i.parsed.claimRaw||'—')}</span></span><span class="badge ${i.result.blocks.length?'':'ready'}">${i.result.blocks.length?'Cần xử lý':'Đủ dữ liệu bản nháp'}</span></button>`).join('')||'<div class="empty"><p>Chưa có PDF phù hợp.</p></div>';
}
function noteOf(p){const v={claim:p.claimRaw,group:p.group,method:p.payment?.method||'',trace:p.payment?.trace||'',date:p.payment?.date||''};return state.config.noteTemplate.replace(/\{(claim|group|method|trace|date)\}/g,(_,k)=>v[k]);}
function renderDetail(){
 const item=state.items.find(i=>i.id===selected);$('#empty').hidden=!!item;$('#detail').hidden=!item;if(!item)return;
 const p=item.parsed,r=item.result,blocked=r.blocks.length>0;
 $('#detail').innerHTML=`<div class="detail-heading"><div><h2>${esc(p.patient||item.name)} <span class="badge ${blocked?'':'ready'}">${blocked?'Cần đối chiếu':'Đủ dữ liệu bản nháp'}</span></h2><p>${esc(item.name)} · ${p.pageCount} trang${r.patient?' · PatNum '+esc(r.patient.PatNum):''}</p></div><button class="small" data-action="open-pdf">Mở PDF gốc ↗</button></div><div class="detail-tabs"><button data-view="review" class="${view==='review'?'active':''}">Thông tin & đối chiếu</button><button data-view="pdf" class="${view==='pdf'?'active':''}">Xem PDF</button><button data-view="source" class="${view==='source'?'active':''}">Văn bản trích xuất</button></div><div id="detail-content"></div>`;
 const content=$('#detail-content');
 if(view==='pdf'){content.className='pdf-viewer';content.textContent='Đang tải PDF…';renderPdf(item.id,content);return;}
 ++pdfToken;content.className='detail-body';
 if(view==='source'){content.innerHTML=`<pre class="text-source">${esc(p.text)}</pre>`;return;}
 content.innerHTML=`<div class="field-grid">${field('Claim number đầy đủ',p.claimRaw)}${field('Group Number',p.group)}${field('Benefit Paid',usd(p.payment?.amountCents),'amount')}${field('Subscriber',p.subscriber)}${field('Payment Date',p.payment?.date)}${field('Payment Method',p.payment?.method)}${field('Check / EFT Trace',p.payment?.trace)}${field('Date Received',p.received)}${field('Processed',p.processed)}</div>
 ${blocked?`<div class="notice"><h3>Chưa thể điền OD · ${r.blocks.length} điểm cần xử lý</h3><ul>${r.blocks.map(b=>`<li>${esc(b)}</li>`).join('')}</ul></div>`:'<div class="notice ok">Đã khớp tài liệu, bệnh nhân, hợp đồng, tổng tiền và chưa thấy khoản trùng trong snapshot. Cần kiểm tra lại trên OD trước khi Save.</div>'}
 <h3 class="section-title">Dịch vụ trong PDF</h3><table><thead><tr><th>Code / ngày</th><th>Trạng thái</th><th class="num">Phí gửi</th><th class="num">Plan Benefit</th><th>Procedure OD</th></tr></thead><tbody>${p.procedures.map(row=>`<tr><td><b>${esc(row.code)}</b><br><small>${esc(row.date||'Allowable / gộp')}</small></td><td>${esc(row.status)}</td><td class="num">${usd(row.feeCents)}</td><td class="num">${usd(row.benefitCents)}</td><td>${esc(r.splits.find(s=>s.code===row.code)?.ProcNum||'—')}</td></tr>`).join('')}</tbody></table>
 ${r.warnings.length?`<div class="notice"><h3>Lưu ý từ dữ liệu</h3><ul>${r.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`:''}
 <h3 class="section-title">Payment Type dự kiến</h3><div class="field-value">${esc(state.config.paymentType)}</div>
 <h3 class="section-title">Note dự kiến</h3><div class="note-preview">${esc(noteOf(p))}</div>
 <div class="actions"><button class="primary" data-action="fill-preview" data-blocked="${blocked||state.status.platform!=='win32'||!!state.preview||!!state.pendingSave}">Auto fill · bản nháp OD</button><button class="primary" data-action="save-payment" data-blocked="${blocked||state.status.platform!=='win32'||!!state.preview||!!state.pendingSave||!item.remote}">Auto fill & Save vào OD</button><button data-action="export-plan">Xuất đối chiếu</button>${state.preview?'<button data-action="close-preview">Đóng bản nháp OD</button>':''}<button class="small danger" data-action="remove">Bỏ khỏi hàng đợi</button></div>
 ${state.preview?.id===item.id&&!state.preview.paymentTypeApplied?'<div class="notice">Payment Type chưa chọn được tự động. Chọn đúng Insurance Paid trên OD trước khi tiếp tục.</div>':''}
 <p class="action-note">Bản nháp dừng trước Save. Auto fill & Save sẽ chọn bệnh nhân, Insurance Paid, gắn Splits, lưu bằng OD và xác minh lại Payment/Splits từ SERVER. Gặp control hoặc dữ liệu không khớp sẽ dừng; tool không gọi nút thanh toán thẻ.${state.status.platform!=='win32'?' Điều khiển OD cần bản Windows trên R5.':''}</p>`;
 updateButtons();
}
async function renderPdf(id,container){
 const token=++pdfToken;
 try{
  const pdfjs=await import('../node_modules/pdfjs-dist/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs',import.meta.url).href;
  const bytes=await request('pdf-bytes',id);
  const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false});const doc=await task.promise;
  try{
   if(token!==pdfToken)return;container.textContent='';
   for(let n=1;n<=doc.numPages;n++){
    if(token!==pdfToken)return;const page=await doc.getPage(n);const viewport=page.getViewport({scale:1.4});const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;container.append(canvas);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
   }
  }finally{await task.destroy();}
 }catch(e){if(token===pdfToken)container.textContent=`Không mở được bản xem PDF: ${e.message}. Dùng Mở PDF gốc.`;}
}
for(const id of ['verify-save','connect-server','disconnect-server','import-pdf','import-snapshot','choose-folder','scan','inspect-od'])$('#'+id).addEventListener('click',()=>action(id));
$('#empty-import').addEventListener('click',()=>action('import-pdf'));
$('#watch').addEventListener('change',async e=>{await action('watch',e.target.checked);$('#watch').checked=state.status.watching;});
$('#search').addEventListener('input',renderList);
$('#save-settings').addEventListener('click',()=>action('config',{noteTemplate:$('#note-template').value,paymentType:$('#payment-type').value}));
$('nav').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(!b)return;document.querySelectorAll('nav [data-tab]').forEach(t=>t.classList.toggle('active',t===b));document.querySelectorAll('main>.page').forEach(p=>p.hidden=p.id!==b.dataset.tab);});
$('#file-list').addEventListener('click',e=>{const b=e.target.closest('[data-file]');if(b){selected=b.dataset.file;view='review';renderList();renderDetail();}});
$('#detail').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.view){view=b.dataset.view;renderDetail();}else if(b.dataset.action==='open-pdf'&&state.items.find(i=>i.id===selected)?.remote){view='pdf';renderDetail();}else if(b.dataset.action){action(b.dataset.action,selected);}});
window.metlife.onState(render);
try{render(await request('state'));}catch(e){toast(e.message);}
setInterval(()=>{if(!working)request('state').then(render).catch(()=>{});},60000);

async function searchPatients(page=0){const q=$('#patient-search-query').value.trim(),kind=$('#patient-search-kind').value;if(!q){toast('Nhập tên hoặc mã bệnh nhân / bảo hiểm.');return;}lastSearch={q,kind,page};await action('search-patients',lastSearch);}
$('#search-patients').addEventListener('click',()=>searchPatients());
$('#patient-search-query').addEventListener('keydown',e=>{if(e.key==='Enter')searchPatients();});
$('#patients-prev').addEventListener('click',()=>searchPatients(Math.max(0,(state.patientBrowser.page||0)-1)));
$('#patients-next').addEventListener('click',()=>searchPatients((state.patientBrowser.page||0)+1));
$('#refresh-documents').addEventListener('click',()=>action('patient-documents',state.patientBrowser.selectedPatient?.PatNum));
$('#patient-results').addEventListener('click',e=>{const b=e.target.closest('[data-patient]');if(b)action('patient-documents',b.dataset.patient);});
$('#patient-documents').addEventListener('click',e=>{const b=e.target.closest('[data-document]');if(b)action('open-document',b.dataset.document);});
