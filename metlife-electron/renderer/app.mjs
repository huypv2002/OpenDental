import {customerMessage} from '../lib/customer-text.mjs';
let state=null,selected=null,view='review',working=false,pdfToken=0;
let lastSearch={q:'',kind:'all',page:0};
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=n=>n===null||n===undefined?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
const events=[];let lastMessage='';
async function request(op,arg){const r=await window.metlife.call(op,arg);if(!r.ok)throw new Error(r.error);return r.data;}
function toast(msg){$('#toast').textContent=msg;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6500);}
async function action(op,arg){if(working)return;working=true;document.body.setAttribute('aria-busy','true');updateButtons();try{const s=await request(op,arg);working=false;document.body.removeAttribute('aria-busy');if(s?.items){if(op==='open-document'){selected=s.patientBrowser.openedId;view='review';$('nav [data-tab="queue"]').click();}render(s);}return s;}catch(e){toast(customerMessage(e.message));}finally{working=false;document.body.removeAttribute('aria-busy');updateButtons();}}
function updateButtons(){document.querySelectorAll('[data-action],#import-pdf,#import-snapshot,#choose-folder,#scan,#inspect-od,#save-settings,#empty-import,#connect-server,#login-server,#disconnect-server,#search-patients,#patients-prev,#patients-next,#refresh-documents,#verify-save,#inspect-db,#export-db-diagnostics').forEach(b=>{if(b.dataset.action==='save-payment')b.disabled=working;else b.disabled=working||b.dataset.blocked==='true';});}
function field(label,value,cls=''){return `<div><span class="field-label">${esc(label)}</span><span class="field-value ${cls}">${esc(value||'—')}</span></div>`;}
function addEvent(message){if(!message||message===lastMessage)return;lastMessage=message;events.unshift({at:new Date().toLocaleTimeString('vi-VN'),message});$('#events').innerHTML=events.map(e=>`<div class="event"><time>${esc(e.at)}</time>${esc(e.message)}</div>`).join('');}
function render(s){
 state=s;if(!selected||!s.items.some(i=>i.id===selected))selected=s.items[0]?.id||null;
 $('#version').textContent=`v${s.version}`;$('#edition-label').textContent=s.editionName;renderEditionGuide(s.edition);$('#status-text').textContent=customerMessage(s.status.message);$('#runtime').textContent='MetLife · '+s.editionName;
 $('#folder-path').textContent=s.status.folder||'Chưa chọn thư mục';$('#folder-path').title=s.status.folder||'';$('#watch').checked=s.status.watching;
 $('#count-total').textContent=s.items.length;$('#count-ready').textContent=s.items.filter(i=>!i.result.blocks.length).length;$('#count-blocked').textContent=s.items.filter(i=>i.result.blocks.length).length;$('#count-snapshots').textContent=s.snapshots.length;
 $('#pending-save-banner').hidden=!s.pendingSave;
 const message=customerMessage(s.status.message),success=/^Đã lưu và xác minh|^Đã xác minh khoản/.test(message);
 const isErr=/^Chưa ghi DB|^Lỗi ghi|^Chưa thể lưu|^Chưa xác minh/i.test(s.status.message)||s.status.errors?.length>0;
 const feedback=$('#workflow-feedback');
 if(success){feedback.hidden=false;feedback.className='save-success';feedback.textContent=message;}
 else if(isErr){feedback.hidden=false;feedback.className='save-error';feedback.textContent=customerMessage(s.status.errors?.[0]||s.status.message);}
 else{feedback.hidden=true;}
 addEvent(customerMessage(s.status.message));for(const e of s.status.errors)addEvent(customerMessage(e));
 renderPatients();renderList();renderDetail();updateButtons();
}
let guideEdition=null;
function renderEditionGuide(id){
 if(guideEdition===id)return;guideEdition=id;
 $('#settings').innerHTML=`<div class="hero"><div><div class="eyebrow">HƯỚNG DẪN SỬ DỤNG</div><h1>Lưu thanh toán từ PDF MetLife</h1><p>Thực hiện trong một luồng từ chọn hồ sơ đến xem kết quả.</p></div></div><div class="card settings-card"><h2>4 bước thực hiện</h2><ol><li><b>Chọn hồ sơ:</b> tìm đúng bệnh nhân, sau đó chọn tài liệu trong Finished Claims.</li><li><b>Đối chiếu:</b> xem PDF gốc, kiểm tra bệnh nhân, hợp đồng, ngày, số tham chiếu và tổng tiền.</li><li><b>Kiểm tra phân bổ:</b> đối chiếu từng dịch vụ, bác sĩ, răng và số tiền được thanh toán.</li><li><b>Lưu thanh toán:</b> bấm Lưu khoản thanh toán và chờ kết quả xác minh.</li></ol><h2>Sau khi lưu</h2><p>Khi có thông báo lưu thành công, làm mới Account trong Open Dental để xem khoản thanh toán với loại Insurance Paid.</p><h2>Nếu chưa rõ kết quả</h2><p>Bấm <b>Kiểm tra kết quả</b> ở thông báo trên cùng. Chờ xác minh trước khi lưu thêm để tránh ghi trùng.</p><p>PDF mở từ máy dùng để xem và đối chiếu. Để lưu thanh toán, chọn tài liệu từ hồ sơ bệnh nhân.</p></div>`;
}
function renderPatients(){
 const b=state.patientBrowser||{patients:[],documents:[]};
 $('#server-status').textContent=b.connected?'Đã kết nối dữ liệu phòng khám. Tìm bệnh nhân để xem Finished Claims.':'Chưa kết nối dữ liệu phòng khám. Bấm Kết nối lại nếu cần.';
 $('#connect-server').textContent='Kết nối lại';
 $('#patient-results').innerHTML=b.patients.map(p=>`<tr data-patient="${esc(p.PatNum)}" tabindex="0" aria-label="Xem hồ sơ ${esc(p.LName)}, ${esc(p.FName)} · Patient ID ${esc(p.PatNum)}" class="${String(b.selectedPatient?.PatNum)===String(p.PatNum)?'patient-selected':''}"><td><b class="patient-name">${esc(p.LName)}, ${esc(p.FName)}</b><br><small>Patient ID ${esc(p.PatNum)}${p.ChartNumber?' · Chart '+esc(p.ChartNumber):''}</small></td><td>${esc(p.Birthdate||'—')}</td><td class="patient-insurance">${(p.insurance||[]).map(i=>`${esc(i.CarrierName)}<br>Subscriber: ${esc(i.SubscriberID||'—')}<br>Group: ${esc(i.GroupNum||'—')}`).join('<hr>')||'—'}</td></tr>`).join('');
 $('#patient-results-empty').hidden=!!b.patients.length;
 $('#patients-prev').dataset.blocked=String(!b.connected||!b.page);$('#patients-next').dataset.blocked=String(!b.connected||!b.hasMore);$('#refresh-documents').dataset.blocked=String(!b.selectedPatient);
 const p=b.selectedPatient;$('#documents-patient').textContent=p?`${p.LName}, ${p.FName} · Patient ID ${p.PatNum}`:'Chọn bệnh nhân để xem tài liệu';
 $('#patient-documents').innerHTML=b.documents.length?b.documents.map(d=>`<div class="document-row"><div class="document-symbol">PDF</div><div class="doc-info"><strong>${esc(d.FileName)}</strong><p>${esc(d.Description||'')}<br>${esc(d.DateCreated||'')}</p></div><button class="primary small" data-document="${esc(d.DocNum)}" data-action="open-document">Chọn PDF</button></div>`).join(''):`<div class="empty"><div class="document-symbol">PDF</div><p>${p?'Không có PDF trong Finished Claims của bệnh nhân này.':'Chọn bệnh nhân để lấy tài liệu từ Imaging.'}</p></div>`;
}
function renderList(){
  const q=$('#search').value.trim().toLowerCase();
  const items=state.items.filter(i=>`${i.name} ${i.parsed.patient} ${i.parsed.claimRaw}`.toLowerCase().includes(q));
  $('#file-list').innerHTML=items.map(i=>{
    const isSaved = i.result.duplicates && i.result.duplicates.length > 0;
    const isBlocked = !isSaved && i.result.blocks.length > 0;
    const badgeClass = isSaved ? 'saved' : isBlocked ? '' : 'ready';
    const badgeText = isSaved ? 'Đã có trong OD' : isBlocked ? 'Cần đối chiếu' : 'Sẵn sàng lưu';
    return `<button class="file-card ${i.id===selected?'active':''}" data-file="${i.id}" aria-pressed="${i.id===selected}"><strong>${esc(i.name)}</strong><span class="file-meta"><span>${esc(i.parsed.patient||'Chưa nhận diện')}</span><span>${usd(i.parsed.payment?.amountCents)}</span></span><span class="file-meta"><span>Claim ${esc(i.parsed.claimRaw||'—')}</span></span><span class="badge ${badgeClass}">${badgeText}</span></button>`;
  }).join('')||'<div class="empty"><p>Chưa có PDF phù hợp.</p></div>';
}
function noteOf(p){const v={claim:p.claimRaw,group:p.group,method:p.payment?.method||'',trace:p.payment?.trace||'',date:p.payment?.date||''};return state.config.noteTemplate.replace(/\{(claim|group|method|trace|date)\}/g,(_,k)=>v[k]);}
function renderDetail(){
 const item=state.items.find(i=>i.id===selected);$('#empty').hidden=!!item;$('#detail').hidden=!item;if(!item)return;
 const p=item.parsed,r=item.result;
 const isSaved = r.duplicates && r.duplicates.length > 0;
 const blocked = r.blocks.length > 0;
 const visibleWarnings=r.warnings.filter(w=>!/Logo MetLife/.test(w));
 const headingBadgeClass = isSaved ? 'saved' : blocked ? '' : 'ready';
 const headingBadgeText = isSaved ? 'Đã có trong Open Dental' : blocked ? 'Cần đối chiếu' : 'Sẵn sàng lưu';
 $('#detail').innerHTML=`<div class="detail-heading"><div><h2>${esc(p.patient||item.name)} <span class="badge ${headingBadgeClass}">${headingBadgeText}</span></h2><p>${esc(item.name)} · ${p.pageCount} trang${r.patient?' · Patient ID '+esc(r.patient.PatNum):''}</p></div><button class="small" data-action="open-pdf">Mở PDF gốc ↗</button></div><div class="detail-tabs"><button data-view="review" class="${view==='review'?'active':''}">Thông tin thanh toán</button><button data-view="pdf" class="${view==='pdf'?'active':''}">Đối chiếu cùng PDF</button></div><div id="detail-content"></div>`;
 const content=$('#detail-content');
 ++pdfToken;content.className='detail-body';
 content.innerHTML=`<div class="field-grid">${field('Số hồ sơ bảo hiểm',p.claimRaw)}${field('Group Number',p.group)}${field('Benefit Paid',usd(p.payment?.amountCents),'amount')}${field('Subscriber',p.subscriber)}${field('Payment Date',p.payment?.date)}${field('Payment Method',p.payment?.method)}${field('Check / EFT Trace',p.payment?.trace)}${field('Date Received',p.received)}${field('Processed',p.processed)}</div>
 ${isSaved?`<div class="notice ok saved"><h3>✓ Khoản thanh toán này đã có trong Open Dental</h3><p>Đã tìm thấy bản ghi thanh toán khớp số Claim / Check <b>${esc(p.claimRaw||p.payment?.trace)}</b> (${usd(p.payment?.amountCents)}) trong tài khoản bệnh nhân. Hệ thống tự động khóa để chống ghi trùng tiền.</p></div>`:blocked?`<div class="notice"><h3>Chưa thể lưu vào OD · ${r.blocks.length} điểm cần xử lý</h3><ul>${r.blocks.map(b=>`<li>${esc(customerMessage(b))}</li>`).join('')}</ul></div>`:'<div class="notice ok">Đã khớp tài liệu, bệnh nhân, hợp đồng, tổng tiền và chưa thấy khoản thanh toán trùng trong hồ sơ. Bạn có thể bấm Lưu khoản thanh toán vào OD.</div>'}
 <h3 class="section-title">Dịch vụ trong PDF</h3><table><thead><tr><th>Code / ngày</th><th>Trạng thái</th><th class="num">Phí gửi</th><th class="num">Plan Benefit</th><th>Đối chiếu</th></tr></thead><tbody>${p.procedures.map(row=>`<tr><td><b>${esc(row.code)}</b><br><small>${esc(row.date||'Allowable / gộp')}</small></td><td>${esc(row.status)}</td><td class="num">${usd(row.feeCents)}</td><td class="num">${usd(row.benefitCents)}</td><td>${r.splits.some(s=>s.code===row.code&&(!row.date||s.date===row.date)&&(!row.tooth||s.tooth===row.tooth))?'Đã khớp':row.benefitCents===0?'Không phân bổ':'Cần đối chiếu'}</td></tr>`).join('')}</tbody></table>
 ${visibleWarnings.length?`<div class="notice"><h3>Lưu ý từ dữ liệu</h3><ul>${visibleWarnings.map(w=>`<li>${esc(customerMessage(w))}</li>`).join('')}</ul></div>`:''}
 <h3 class="section-title">Loại thanh toán</h3><div class="field-value">${esc(state.config.paymentType)}</div>
 <h3 class="section-title">Ghi chú thanh toán</h3><div class="note-preview">${esc(noteOf(p))}</div>
 <h3 class="section-title">Hồ sơ trong Open Dental</h3><div class="field-grid">${field('Patient ID / Chart',r.patient?`${r.patient.PatNum} / ${r.patient.ChartNumber||'—'}`:'—')}${field('Họ tên OD',r.patient?`${r.patient.LName}, ${r.patient.FName} ${r.patient.MiddleI||''}`:'—')}${field('Ngày sinh OD',r.patient?.Birthdate)}${field('Subscriber ID / Carrier',r.plan?`${r.plan.SubscriberID||'—'} / ${r.plan.CarrierName||'—'}`:'—')}${field('Tên nhóm / Group',r.plan?`${r.plan.GroupName||''} / ${r.plan.GroupNum}`:'—')}${field('Tổng phân bổ',usd(r.splits.reduce((n,s)=>n+s.amountCents,0)))}</div>
 <h3 class="section-title">Phân bổ thanh toán theo dịch vụ</h3><table><thead><tr><th>Code / Ngày</th><th>Răng</th><th>Bác sĩ</th><th>Mô tả OD</th><th class="num">Số tiền</th></tr></thead><tbody>${r.splits.map(s=>`<tr><td>${esc(s.code)}<br>${esc(s.date)}</td><td>${esc(s.tooth||'—')}</td><td>${esc(s.providerAbbr)}</td><td>${esc(s.description)}</td><td class="num">${usd(s.amountCents)}</td></tr>`).join('')}</tbody></table>
 <div class="payment-submit"><div class="payment-total"><span>Tổng thanh toán</span><strong>${usd(p.payment?.amountCents)}</strong><small>${r.splits.length} dịch vụ được phân bổ</small></div><div class="submit-controls"><button class="primary ${isSaved?'already-saved':''}" data-action="save-payment" data-saved="${isSaved}" data-blocked="${blocked||!!state.pendingSave||!item.remote||!state.patientBrowser.connected}">${working?'⏳ Đang lưu vào OD…':isSaved?'✓ Đã lưu trong Open Dental':!state.patientBrowser.connected?'Chưa kết nối dữ liệu SERVER':!item.remote?'Mở từ hồ sơ bệnh nhân để lưu':blocked?'Chưa thể lưu (Cần đối chiếu)':'Lưu khoản thanh toán'}</button><button class="small danger" data-action="remove">Bỏ khỏi hàng đợi</button></div><p class="action-note">${state.pendingSave?'Đang chờ xác minh lần lưu trước. Bấm Kiểm tra kết quả ở trên.':isSaved?'Khoản thanh toán đã nằm trong tài khoản bệnh nhân trên Open Dental. Không cần lưu lại.':!item.remote?'Chọn PDF từ hồ sơ bệnh nhân để lưu khoản thanh toán.':!state.paymentSaveReady?'Chức năng lưu chưa được kích hoạt. Vui lòng liên hệ bộ phận hỗ trợ.':blocked?'Hoàn tất các điểm cần đối chiếu trước khi lưu.':'Kiểm tra 4 dịch vụ phía trên, sau đó bấm Lưu. Dữ liệu sẽ được ghi vào OD và xác minh tự động.'}</p></div>`;
 const heading=$('#detail .detail-heading');
 heading.insertAdjacentHTML('afterend',`<div class="payment-overview"><div><span>Bệnh nhân đối chiếu</span><strong>${esc(r.patient?`${r.patient.LName}, ${r.patient.FName}`:p.patient)}</strong><small>${esc(r.patient?'Mã hồ sơ '+r.patient.PatNum:'Chưa khớp hồ sơ')}</small></div><div><span>MetLife thanh toán</span><strong class="overview-amount">${usd(p.payment?.amountCents)}</strong><small>${esc(p.payment?.date||'Chưa có ngày thanh toán')}</small></div><div><span>Trạng thái đối chiếu</span><strong class="${isSaved?'review-saved':blocked?'review-needed':'review-ready'}">${isSaved?'Đã có trong OD':blocked?'Cần kiểm tra':'Sẵn sàng lưu'}</strong><small>${r.splits.length} dịch vụ · ${esc(p.payment?.trace||'Chưa có số tham chiếu')}</small></div></div>`);
 if(view==='pdf'){
  content.insertAdjacentHTML('afterend','<aside class="pdf-side"><div class="pdf-side-heading">Tài liệu gốc · Đối chiếu với thông tin bên cạnh</div><div class="pdf-viewer">Đang tải PDF…</div></aside>');
  content.parentElement.classList.add('with-pdf');renderPdf(item.id,$('#detail .pdf-viewer'));
 }else content.parentElement.classList.remove('with-pdf');
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
 }catch(e){if(token===pdfToken)container.textContent=`Không mở được bản xem PDF: ${customerMessage(e.message)}. Dùng Mở PDF gốc.`;}
}
for(const id of ['verify-save','import-pdf','choose-folder','scan'])$('#'+id).addEventListener('click',()=>action(id));
$('#empty-import').addEventListener('click',()=>action('import-pdf'));
$('#watch').addEventListener('change',async e=>{await action('watch',e.target.checked);$('#watch').checked=state.status.watching;});
$('#search').addEventListener('input',renderList);
$('nav').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(!b)return;document.querySelectorAll('nav [data-tab]').forEach(t=>t.classList.toggle('active',t===b));document.querySelectorAll('main>.page').forEach(p=>p.hidden=p.id!==b.dataset.tab);});
$('#file-list').addEventListener('click',e=>{const b=e.target.closest('[data-file]');if(b){selected=b.dataset.file;view='review';renderList();renderDetail();}});
$('#detail').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.view){view=b.dataset.view;renderDetail();}else if(b.dataset.action==='open-pdf'&&state.items.find(i=>i.id===selected)?.remote){view='pdf';renderDetail();}else if(b.dataset.action==='save-payment'){const item=state.items.find(i=>i.id===selected);if(b.dataset.saved==='true'||item?.result?.duplicates?.length){toast('Khoản thanh toán này đã có trong Open Dental. Không lưu trùng.');return;}if(!state.patientBrowser.connected){toast('Chưa kết nối dữ liệu phòng khám. Bấm Kết nối lại ở trên.');return;}if(!item?.remote){toast('Vui lòng chọn PDF từ tab Tìm bệnh nhân để lưu vào hồ sơ Open Dental.');return;}if(item?.result?.blocks?.length){toast(`Chưa thể lưu: còn ${item.result.blocks.length} điểm cần đối chiếu.`);return;}action('save-payment',selected);}else if(b.dataset.action){action(b.dataset.action,selected);}});
window.metlife.onState(render);
try{render(await request('state'));}catch(e){toast(customerMessage(e.message));}
setInterval(()=>{if(!working)request('state').then(render).catch(()=>{});},60000);

async function searchPatients(page=0){
 if(working)return;
 const q=$('#patient-search-query').value.trim(),kind=$('#patient-search-kind').value;
 if(!q){toast('Nhập tên hoặc mã bệnh nhân / bảo hiểm.');return;}
 lastSearch={q,kind,page};
 const result=await action('search-patients',lastSearch),browser=result?.patientBrowser;
 if(browser?.patients.length===1&&!browser.hasMore)await action('patient-documents',String(browser.patients[0].PatNum));
}
$('#search-patients').addEventListener('click',()=>searchPatients());
$('#patient-search-query').addEventListener('keydown',e=>{if(e.key==='Enter')searchPatients();});
$('#patients-prev').addEventListener('click',()=>searchPatients(Math.max(0,(state.patientBrowser.page||0)-1)));
$('#patients-next').addEventListener('click',()=>searchPatients((state.patientBrowser.page||0)+1));
$('#refresh-documents').addEventListener('click',()=>action('patient-documents',state.patientBrowser.selectedPatient?.PatNum));
$('#patient-results').addEventListener('click',e=>{const b=e.target.closest('[data-patient]');if(b)action('patient-documents',b.dataset.patient);});
$('#patient-results').addEventListener('keydown',e=>{if(!['Enter',' '].includes(e.key))return;const row=e.target.closest('[data-patient]');if(row){e.preventDefault();action('patient-documents',row.dataset.patient);}});
$('#patient-documents').addEventListener('click',e=>{const b=e.target.closest('[data-document]');if(b)action('open-document',b.dataset.document);});

$('#connect-server').addEventListener('click',()=>action('reconnect-server'));
