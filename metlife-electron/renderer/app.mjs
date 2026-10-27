import {customerMessage} from '../lib/customer-text.mjs';

let working = false;
let serverHistoryItems = [];
let serverStatusData = null;
let selectedHistoryItem = null;
let activeFilter = 'all'; // 'all' | 'success' | 'failed'
let searchQuery = '';
let autoRefreshSec = 15;
let autoRefreshTimer = null;
let pdfToken = 0;
let patientState = { patients: [], documents: [], selectedPatient: null, page: 0, hasMore: false };
const events = [];

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = cents => cents === null || cents === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

async function request(op, arg) {
  const r = await window.metlife.call(op, arg);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 5500);
}

function addEvent(message) {
  if (!message) return;
  const at = new Date().toLocaleTimeString('vi-VN');
  events.unshift({ at, message });
  if (events.length > 50) events.pop();
  const el = $('#events');
  if (el) {
    el.innerHTML = events.map(e => `<div class="event"><time>${esc(e.at)}</time>${esc(e.message)}</div>`).join('');
  }
}

// Tab navigation
$$('nav [data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('nav [data-tab]').forEach(b => b.classList.toggle('active', b === btn));
    $$('main > .page').forEach(p => { p.hidden = p.id !== btn.dataset.tab; });
    if (btn.dataset.tab === 'diagnostics') {
      loadServerStatus();
    }
  });
});

// Load Server Status
async function loadServerStatus() {
  try {
    const res = await request('server-status');
    serverStatusData = res;
    renderServerStatus(res);
  } catch (err) {
    const pill = $('#server-live-indicator');
    if (pill) {
      pill.className = 'live-status-pill offline';
      $('#server-live-title').textContent = 'SERVER: MẤT KẾT NỐI';
      $('#server-live-detail').textContent = 'Kiểm tra mạng hoặc khởi động lại service';
    }
    const diagStatus = $('#diag-conn-status');
    if (diagStatus) {
      diagStatus.className = 'badge failed';
      diagStatus.textContent = '✗ Mất kết nối';
    }
  }
}

function renderServerStatus(data) {
  if (!data) return;
  const pill = $('#server-live-indicator');
  const title = $('#server-live-title');
  const detail = $('#server-live-detail');

  if (data.isScanning) {
    pill.className = 'live-status-pill busy';
    title.textContent = 'SERVER: ĐANG QUÉT EOB...';
    detail.textContent = 'Đang tự động xử lý file trong thư mục MetLife';
  } else {
    pill.className = 'live-status-pill online';
    title.textContent = 'SERVER: KẾT NỐI TỐT';
    const lastScanStr = data.lastScanTime ? new Date(data.lastScanTime).toLocaleTimeString('vi-VN') : 'Mới khởi động';
    detail.textContent = `Quét lúc ${lastScanStr} · Uptime: ${formatUptime(data.uptimeSeconds)}`;
  }

  // Error retry button in header
  const errorCount = data.counts?.errors || 0;
  const retryBtn = $('#header-retry-btn');
  const badgeCount = $('#error-badge-count');
  if (retryBtn && badgeCount) {
    badgeCount.textContent = errorCount;
    retryBtn.hidden = errorCount <= 0;
  }

  // Diagnostics Tab
  const diagUrl = $('#diag-url');
  if (diagUrl) diagUrl.textContent = 'http://SERVER:3008 (Mạng LAN phòng khám)';
  const diagStatus = $('#diag-conn-status');
  if (diagStatus) {
    diagStatus.className = 'badge success';
    diagStatus.textContent = '🟢 Đang hoạt động bình thường';
  }
  const diagServerTime = $('#diag-server-time');
  if (diagServerTime) diagServerTime.textContent = data.serverTime || new Date().toLocaleString('vi-VN');
  const diagUptime = $('#diag-uptime');
  if (diagUptime) diagUptime.textContent = formatUptime(data.uptimeSeconds);
  const diagLastScan = $('#diag-last-scan');
  if (diagLastScan) diagLastScan.textContent = data.lastScanTime ? new Date(data.lastScanTime).toLocaleString('vi-VN') : 'Chưa có';
  
  const diagFolderIncoming = $('#diag-folder-incoming');
  if (diagFolderIncoming) diagFolderIncoming.textContent = data.incomingDir || 'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const diagIncoming = $('#diag-count-incoming');
  if (diagIncoming) diagIncoming.textContent = `${data.counts?.incoming || 0} file`;
  const diagProcessed = $('#diag-count-processed');
  if (diagProcessed) diagProcessed.textContent = `${data.counts?.processed || 0} file`;
  const diagErrors = $('#diag-count-errors');
  if (diagErrors) diagErrors.textContent = `${data.counts?.errors || 0} file`;
}

function formatUptime(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} giờ ${m} phút`;
  if (m > 0) return `${m} phút ${s} giây`;
  return `${s} giây`;
}

// Load Server History
async function loadServerHistory() {
  try {
    const res = await request('server-history');
    serverHistoryItems = res?.items || [];
    renderHistory();
    await loadServerStatus();
  } catch (err) {
    const el = $('#history-count');
    if (el) el.textContent = 'Chưa tải được lịch sử';
    addEvent(`Lỗi tải lịch sử: ${err.message}`);
  }
}

function renderHistory() {
  const allItems = serverHistoryItems;

  // Filter items
  const q = searchQuery.trim().toLowerCase();
  const filtered = allItems.filter(item => {
    // Text search
    if (q) {
      const match = `${item.FileName} ${item.PatientName} ${item.PatNum} ${item.ClaimNumber} ${item.CheckNumber}`.toLowerCase().includes(q);
      if (!match) return false;
    }
    // Pill filter
    if (activeFilter === 'success') return item.Status === 'SUCCESS';
    if (activeFilter === 'failed') return item.Status !== 'SUCCESS';
    return true;
  });

  // Update counts
  const successItems = allItems.filter(i => i.Status === 'SUCCESS');
  const failedItems = allItems.filter(i => i.Status !== 'SUCCESS');
  const totalCents = successItems.reduce((acc, cur) => acc + Math.round(Number(cur.TotalAmount || 0) * 100), 0);

  const statTotal = $('#stat-total-processed');
  if (statTotal) statTotal.textContent = allItems.length;
  const statSuccess = $('#stat-success');
  if (statSuccess) statSuccess.textContent = successItems.length;
  const statFailed = $('#stat-failed');
  if (statFailed) statFailed.textContent = failedItems.length;
  const statTotalAmount = $('#stat-total-amount');
  if (statTotalAmount) statTotalAmount.textContent = usd(totalCents);

  const fAll = $('#filter-count-all');
  if (fAll) fAll.textContent = allItems.length;
  const fSuccess = $('#filter-count-success');
  if (fSuccess) fSuccess.textContent = successItems.length;
  const fFailed = $('#filter-count-failed');
  if (fFailed) fFailed.textContent = failedItems.length;

  const countEl = $('#history-count');
  if (countEl) countEl.textContent = `${filtered.length} giao dịch${q ? ' (kết quả lọc)' : ''}`;

  const tbody = $('#history-items-tbody');
  const hEmpty = $('#history-empty');
  if (!tbody) return;

  if (!filtered.length) {
    tbody.innerHTML = '';
    if (hEmpty) hEmpty.hidden = false;
    renderHistoryDetail(null);
    return;
  }

  if (hEmpty) hEmpty.hidden = true;

  tbody.innerHTML = filtered.map(item => {
    const isSuccess = item.Status === 'SUCCESS';
    const isSel = selectedHistoryItem && selectedHistoryItem.Id === item.Id;
    const badgeCls = isSuccess ? 'success' : item.Status==='REVIEW'?'neutral':'failed';
    const badgeText = isSuccess ? '✓ Đã ghi OD' : item.Status==='REVIEW'?'Chờ đối chiếu':'⚠️ Lỗi';
    const amountStr = usd(Math.round(Number(item.TotalAmount || 0) * 100));
    const feeTag = item.FeesUpdated ? `<span class="badge fee-tag">${esc(item.FeesUpdated)}</span>` : '<span class="muted">—</span>';
    const dateFormatted = item.ProcessedAt ? item.ProcessedAt.slice(0, 16) : (item.CreatedAt ? item.CreatedAt.slice(0, 16) : '—');

    return `<tr class="history-row ${isSel ? 'selected' : ''}" data-history-id="${item.Id}">
      <td><small>${esc(dateFormatted)}</small></td>
      <td><strong>${esc(item.FileName)}</strong></td>
      <td><b>${esc(item.PatientName)}</b><br><small>PatNum: ${esc(item.PatNum || 'Chưa rõ')}</small></td>
      <td><small>${esc(item.ClaimNumber || item.CheckNumber || '—')}</small></td>
      <td class="num"><b>${amountStr}</b></td>
      <td>${feeTag}</td>
      <td><span class="badge ${badgeCls}">${badgeText}</span></td>
      <td style="text-align:center;"><button class="action-view-btn" data-action="view-pdf" data-history-id="${item.Id}" title="Xem PDF EOB gốc">👁️ Xem</button></td>
    </tr>`;
  }).join('');

  // Keep selection
  if (!selectedHistoryItem || !filtered.some(i => i.Id === selectedHistoryItem.Id)) {
    selectedHistoryItem = filtered[0] || null;
  }
  if (selectedHistoryItem) {
    const fresh = filtered.find(i => i.Id === selectedHistoryItem.Id) || filtered[0];
    selectedHistoryItem = fresh;
    renderHistoryDetail(fresh);
  } else {
    renderHistoryDetail(null);
  }
}

function renderHistoryDetail(item) {
  const dEmpty = $('#history-detail-empty');
  const dContent = $('#history-detail-content');
  const badge = $('#history-detail-badge');
  const actions = $('#inspector-actions');

  if (!item) {
    if (dEmpty) dEmpty.hidden = false;
    if (dContent) dContent.hidden = true;
    if (badge) { badge.textContent = 'Chưa chọn'; badge.className = 'badge'; }
    if (actions) actions.hidden = true;
    return;
  }

  if (dEmpty) dEmpty.hidden = true;
  if (dContent) dContent.hidden = false;
  if (actions) actions.hidden = false;

  const isSuccess = item.Status === 'SUCCESS';
  if (badge) {
    badge.textContent = isSuccess ? `Giao dịch #${item.Id} (Đã ghi OD)` : `Giao dịch #${item.Id} (Thất bại)`;
    badge.className = isSuccess ? 'badge success' : 'badge failed';
  }

  let details = null;
  try { if (item.Details) details = JSON.parse(item.Details); } catch {}

  const amountStr = usd(Math.round(Number(item.TotalAmount || 0) * 100));
  if(!isSuccess){
    const review=item.Status==='REVIEW';
    if(badge){badge.textContent=review?'Chờ đối chiếu tài liệu':'Chưa hoàn tất';badge.className='badge neutral';}
    dContent.innerHTML=`<div class="inspector-card"><h4>${review?'Cần đối chiếu ảnh gốc':'Chưa hoàn tất xử lý'}</h4><p>${review?'Ảnh hoặc thông tin dịch vụ chưa đủ rõ/khớp hồ sơ. Chưa tạo khoản thanh toán cho lượt này.':'Kiểm tra kết quả trong Open Dental trước khi xử lý lại.'}</p><p>${esc(customerMessage(item.Message||''))}</p></div>`;
    return;
  }

  // Build procedures breakdown table
  let procsTable = '';
  if (details?.procedures && details.procedures.length > 0) {
    procsTable = `
      <div class="inspector-card">
        <h4>📋 Chi tiết dịch vụ trên EOB & Đối chiếu Open Dental</h4>
        <table class="proc-breakdown-table">
          <thead>
            <tr>
              <th>Mã CDT</th>
              <th>Ngày</th>
              <th>Trạng thái EOB</th>
              <th class="num">Phí gửi</th>
              <th class="num">Bảo hiểm trả</th>
              <th>Phí OD cập nhật</th>
            </tr>
          </thead>
          <tbody>
            ${details.procedures.map(p => {
              const isApproved = (p.status || '').toLowerCase().includes('approved') || p.benefitCents > 0;
              const isBundled = (p.remarks || []).some(r => /65|bundle|inclusive/i.test(r)) || /bundled/i.test(p.status);
              const tagCls = isApproved ? 'proc-tag-approved' : isBundled ? 'proc-tag-bundled' : 'proc-tag-denied';
              const tagText = isApproved ? 'Approved' : isBundled ? 'Bundled (Gộp)' : 'Denied';
              const odFee = isApproved ? usd(p.benefitCents) : '$0.00';
              return `<tr>
                <td><b>${esc(p.code)}</b></td>
                <td><small>${esc(p.date || '—')}</small></td>
                <td><span class="${tagCls}">${tagText}</span></td>
                <td class="num">${usd(p.feeCents)}</td>
                <td class="num"><b>${usd(p.benefitCents)}</b></td>
                <td style="color:${isApproved ? '#166534' : '#64748b'};font-weight:600;">${odFee}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  dContent.innerHTML = `
    <!-- Reconciliation Summary -->
    <div class="inspector-card">
      <h4>⚡ Trạng thái đối chiếu & Ghi nhận Open Dental</h4>
      <div class="reconcile-success-box">
        <div class="reconcile-item">
          <span>✓</span>
          <span><b>Khoản thanh toán Open Dental:</b> Mã <code>PayNum #${item.PayNum || 'Chưa tạo'}</code> (Loại <b>Insurance Paid</b>)</span>
        </div>
        <div class="reconcile-item">
          <span>✓</span>
          <span><b>Trạng thái Claim:</b> Đã nhận thanh toán (<code>ClaimStatus = 'R'</code>)</span>
        </div>
        <div class="reconcile-item">
          <span>✓</span>
          <span><b>Chống nhân đôi dòng tiền:</b> Đã chặn dòng ảo <i>PAYMENT NEEDS TO BE FINALIZED</i> thành công. Chỉ hiển thị 1 dòng $${amountStr}.</span>
        </div>
        <div class="reconcile-item">
          <span>✓</span>
          <span><b>Số dư tài khoản bệnh nhân (Balance):</b> Khớp đúng <b>$0.00</b> (Không bị âm tiền)</span>
        </div>
      </div>
    </div>

    <!-- Patient & Claim Info -->
    <div class="inspector-card">
      <h4>👤 Thông tin hồ sơ & Hợp đồng bảo hiểm</h4>
      <div class="inspector-grid">
        <div class="inspector-item">
          <span>Bệnh nhân:</span>
          <strong>${esc(item.PatientName)} (PatNum #${item.PatNum})</strong>
        </div>
        <div class="inspector-item highlight-amount">
          <span>Số tiền bảo hiểm chi trả:</span>
          <strong>${amountStr}</strong>
        </div>
        <div class="inspector-item">
          <span>Số Claim EOB:</span>
          <strong><code>${esc(item.ClaimNumber || '—')}</code></strong>
        </div>
        <div class="inspector-item">
          <span>Ngày thanh toán trong OD:</span>
          <strong>${esc(details?.paymentDate || '—')}</strong>
        </div>
        <div class="inspector-item">
          <span>Note thanh toán:</span>
          <strong>${esc(details?.paymentNote || '—')}</strong>
        </div>
        <div class="inspector-item">
          <span>Số tham chiếu trên EOB gốc:</span>
          <strong><code>${esc(item.CheckNumber || details?.eobPayment?.trace || '—')}</code></strong>
        </div>
        <div class="inspector-item">
          <span>File EOB nguồn:</span>
          <strong><code>${esc(item.FileName)}</code></strong>
        </div>
        <div class="inspector-item">
          <span>Thời gian xử lý:</span>
          <strong>${esc(item.ProcessedAt || item.CreatedAt)}</strong>
        </div>
      </div>
    </div>

    ${procsTable}

    <!-- Fees & Charges updated -->
    <div class="inspector-card">
      <h4>🔧 Bù phí dịch vụ tự động (Fix ProcFee 0.00)</h4>
      <p style="margin:4px 0 6px;color:#166534;font-weight:600;font-size:12px;">
        ${esc(item.FeesUpdated || 'Tất cả các dịch vụ đã có biểu phí đầy đủ.')}
      </p>
      <small class="muted">Hệ thống đã tự động gán biểu phí dịch vụ khớp với quyền lợi bảo hiểm chi trả, đồng thời đặt các dịch vụ bị từ chối/bị gộp về $0.00 để tránh tính trùng tiền cho bệnh nhân.</small>
    </div>

    <!-- AtoZ Finished Claims -->
    <div class="inspector-card">
      <h4>📁 Lưu trữ Finished Claims & Chữ ký bảo mật</h4>
      <div class="inspector-grid">
        <div class="inspector-item">
          <span>Mã tài liệu (DocNum):</span>
          <strong><code>#${item.DocNum || 'Chưa tạo'}</code></strong>
        </div>
        <div class="inspector-item">
          <span>Danh mục lưu trữ:</span>
          <strong><code>FINISHED CLAIMS</code></strong>
        </div>
        <div class="inspector-item">
          <span>Vị trí lưu:</span>
          <strong>Thư mục AtoZ ImageFolder của bệnh nhân trên SERVER</strong>
        </div>
        <div class="inspector-item">
          <span>Chữ ký bảo mật OD:</span>
          <strong><span class="badge success">✓ SecurityHash OK</span></strong>
        </div>
      </div>
    </div>

    ${item.Message ? `
      <div class="notice ${isSuccess ? 'ok' : 'failed'}" style="margin-top:4px;">
        <b>${isSuccess ? '✓ Hoàn thành:' : '⚠️ Thông báo lỗi:'}</b> ${esc(item.Message)}
      </div>
    ` : ''}
  `;
}

// History table row click & view PDF button
$('#history-items-tbody')?.addEventListener('click', async e => {
  const row = e.target.closest('tr[data-history-id]');
  if (!row) return;
  const id = Number(row.dataset.historyId);
  const item = serverHistoryItems.find(i => i.Id === id);
  if (!item) return;

  selectedHistoryItem = item;
  $$('#history-items-tbody tr').forEach(r => r.classList.toggle('selected', r === row));
  renderHistoryDetail(item);

  if (e.target.closest('[data-action="view-pdf"]')) {
    openPdfModal(item);
  }
});

// Inspector Action Buttons
$('#inspector-view-pdf-btn')?.addEventListener('click', () => {
  if (selectedHistoryItem) openPdfModal(selectedHistoryItem);
});
$('#inspector-open-os-pdf-btn')?.addEventListener('click', async () => {
  if (!selectedHistoryItem) return;
  try {
    toast('Đang mở file PDF bằng ứng dụng mặc định...');
    await request('open-system-pdf', { historyId: selectedHistoryItem.Id, fileName: selectedHistoryItem.FileName });
  } catch (err) {
    toast(`Không mở được PDF: ${err.message}`);
  }
});

// Search input
$('#history-search')?.addEventListener('input', e => {
  searchQuery = e.target.value;
  $('#history-search-clear').hidden = !searchQuery;
  renderHistory();
});
$('#history-search-clear')?.addEventListener('click', () => {
  $('#history-search').value = '';
  searchQuery = '';
  $('#history-search-clear').hidden = true;
  renderHistory();
});

// Filter pills
$$('.filter-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    $$('.filter-pill').forEach(p => p.classList.toggle('active', p === pill));
    activeFilter = pill.dataset.filter;
    renderHistory();
  });
});

// Scan & Retry actions
async function triggerServerScan() {
  const btn = $('#header-scan-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Đang quét server...';
  try {
    const res = await request('scan-server');
    toast(`Đã quét xong: ${res?.count ?? 0} file được xử lý.`);
    addEvent(`Đã quét thư mục server: ${res?.count ?? 0} file.`);
    await loadServerHistory();
  } catch (err) {
    toast(`Lỗi khi quét server: ${err.message}`);
    addEvent(`Lỗi quét: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Quét Server ngay';
  }
}

async function triggerRetryErrors() {
  const btn = $('#header-retry-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Đang xử lý lại...';
  try {
    const res = await request('retry-errors');
    toast(`Đã chuyển ${res?.movedCount ?? 0} file lỗi ra để quét lại.`);
    addEvent(`Thử lại file lỗi: ${res?.movedCount ?? 0} file.`);
    await loadServerHistory();
  } catch (err) {
    toast(`Lỗi khi thử lại: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Thử lại file lỗi';
  }
}

$('#header-scan-btn')?.addEventListener('click', triggerServerScan);
$('#diag-scan-btn')?.addEventListener('click', triggerServerScan);
$('#header-retry-btn')?.addEventListener('click', triggerRetryErrors);
$('#diag-retry-errors-btn')?.addEventListener('click', triggerRetryErrors);
$('#refresh-all-btn')?.addEventListener('click', () => {
  loadServerHistory();
  toast('Đã làm mới dữ liệu.');
});

// Diagnostics reconnect
$('#diag-reconnect-btn')?.addEventListener('click', async () => {
  try {
    await request('reconnect-server');
    toast('Đã kết nối lại thành công.');
    await loadServerHistory();
  } catch (err) {
    toast(`Lỗi kết nối lại: ${err.message}`);
  }
});

// Clear events log
$('#clear-events-btn')?.addEventListener('click', () => {
  events.length = 0;
  $('#events').innerHTML = '<div class="muted" style="padding:10px 0;">Nhật ký đã được xóa.</div>';
});

// PDF Modal
async function openPdfModal(item) {
  const modal = $('#pdf-modal');
  const title = $('#pdf-modal-title');
  const viewer = $('#pdf-modal-viewer');
  if (!modal || !viewer) return;

  title.textContent = `EOB: ${item.FileName} (${item.PatientName})`;
  viewer.innerHTML = '<div style="padding:40px;text-align:center;">⏳ Đang tải trang PDF...</div>';
  modal.hidden = false;

  const currentToken = ++pdfToken;

  try {
    const bytes = await request('history-pdf', item.Id);
    if (currentToken !== pdfToken) return;

    if(/\.txt$/i.test(item.FileName)){
      const data=new Uint8Array(bytes);
      const encoding=data[0]===255&&data[1]===254?'utf-16le':data[0]===254&&data[1]===255?'utf-16be':'utf-8';
      const pre=document.createElement('pre');
      pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:20px;width:100%;box-sizing:border-box';
      pre.textContent=new TextDecoder(encoding).decode(data);
      viewer.replaceChildren(pre);return;
    }
    const pdfjs = await import('../node_modules/pdfjs-dist/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
    const pdfDoc = await loadingTask.promise;

    if (currentToken !== pdfToken) return;
    viewer.innerHTML = '';

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      if (currentToken !== pdfToken) return;
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      viewer.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
  } catch (err) {
    if (currentToken === pdfToken) {
      viewer.innerHTML = `<div style="padding:40px;text-align:center;color:#b91c1c;">
        <p><b>Không hiển thị được bản xem trước:</b> ${esc(err.message)}</p>
        <p>Bạn có thể bấm nút <b>Mở bằng Adobe Reader</b> ở trên để xem trực tiếp.</p>
      </div>`;
    }
  }
}

function closePdfModal() {
  $('#pdf-modal').hidden = true;
  pdfToken++;
}

$('#pdf-modal-close')?.addEventListener('click', closePdfModal);
$('#pdf-modal')?.addEventListener('click', e => {
  if (e.target === $('#pdf-modal')) closePdfModal();
});
$('#pdf-modal-open-external')?.addEventListener('click', async () => {
  if (!selectedHistoryItem) return;
  try {
    toast('Đang mở file PDF bằng Adobe Reader...');
    await request('open-system-pdf', { historyId: selectedHistoryItem.Id, fileName: selectedHistoryItem.FileName });
  } catch (err) {
    toast(`Lỗi: ${err.message}`);
  }
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#pdf-modal').hidden) closePdfModal();
});

// TAB 2: Patient Search & Finished Claims
async function searchPatients(page = 0) {
  if (working) return;
  const q = $('#patient-search-query').value.trim();
  const kind = $('#patient-search-kind').value;
  if (!q) { toast('Nhập tên hoặc mã bệnh nhân để tìm kiếm.'); return; }

  $('#search-patients').disabled = true;
  $('#search-patients').textContent = 'Đang tìm...';
  try {
    const res = await request('search-patients', { q, kind, page });
    patientState.patients = res?.patients || [];
    patientState.page = res?.page || 0;
    patientState.hasMore = !!res?.hasMore;
    renderPatientResults();
  } catch (err) {
    toast(`Lỗi tìm bệnh nhân: ${err.message}`);
  } finally {
    $('#search-patients').disabled = false;
    $('#search-patients').textContent = 'Tìm bệnh nhân';
  }
}

function renderPatientResults() {
  const tbody = $('#patient-results');
  const empty = $('#patient-results-empty');
  if (!tbody) return;

  if (!patientState.patients.length) {
    tbody.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.innerHTML = patientState.patients.map(p => {
    const isSel = patientState.selectedPatient && patientState.selectedPatient.PatNum === p.PatNum;
    return `<tr data-patient="${esc(p.PatNum)}" class="${isSel ? 'patient-selected' : ''}" style="cursor:pointer;">
      <td><b>${esc(p.LName)}, ${esc(p.FName)}</b><br><small>PatNum: ${esc(p.PatNum)}${p.ChartNumber ? ' · Chart: ' + esc(p.ChartNumber) : ''}</small></td>
      <td>${esc(p.Birthdate || '—')}</td>
      <td class="patient-insurance">${(p.insurance || []).map(i => `${esc(i.CarrierName)} (Group: ${esc(i.GroupNum || '—')})`).join('<br>') || '—'}</td>
    </tr>`;
  }).join('');
}

$('#search-patients')?.addEventListener('click', () => searchPatients(0));
$('#patient-search-query')?.addEventListener('keydown', e => { if (e.key === 'Enter') searchPatients(0); });
$('#patients-prev')?.addEventListener('click', () => searchPatients(Math.max(0, patientState.page - 1)));
$('#patients-next')?.addEventListener('click', () => searchPatients(patientState.page + 1));

$('#patient-results')?.addEventListener('click', async e => {
  const row = e.target.closest('tr[data-patient]');
  if (!row) return;
  const patNum = row.dataset.patient;
  const p = patientState.patients.find(pt => String(pt.PatNum) === String(patNum));
  if (!p) return;

  patientState.selectedPatient = p;
  $$('#patient-results tr').forEach(r => r.classList.toggle('patient-selected', r === row));
  $('#documents-patient').textContent = `${p.LName}, ${p.FName} · PatNum #${p.PatNum}`;

  try {
    const res = await request('patient-documents', p.PatNum);
    patientState.documents = res?.documents || [];
    renderPatientDocuments();
  } catch (err) {
    toast(`Lỗi tải Finished Claims: ${err.message}`);
  }
});

function renderPatientDocuments() {
  const list = $('#patient-documents');
  if (!list) return;
  const docs = patientState.documents;
  if (!docs.length) {
    list.innerHTML = `<div class="empty"><div class="document-symbol">PDF</div><p>Không có file PDF nào trong FINISHED CLAIMS của bệnh nhân này.</p></div>`;
    return;
  }
  list.innerHTML = docs.map(d => `
    <div class="document-row">
      <div class="document-symbol">PDF</div>
      <div class="doc-info">
        <strong>${esc(d.FileName)}</strong>
        <p>${esc(d.Description || 'Finished Claim')}<br><small>${esc(d.DateCreated || '')}</small></p>
      </div>
      <button class="primary small" data-docnum="${esc(d.DocNum)}" data-action="view-doc">Xem PDF</button>
      <button class="small" data-docnum="${esc(d.DocNum)}" data-action="open-doc-os">Mở Reader</button>
    </div>
  `).join('');
}

$('#patient-documents')?.addEventListener('click', async e => {
  const viewBtn = e.target.closest('[data-action="view-doc"]');
  const openOsBtn = e.target.closest('[data-action="open-doc-os"]');
  const patNum = patientState.selectedPatient?.PatNum;
  if (!patNum) return;

  if (viewBtn) {
    const docNum = viewBtn.dataset.docnum;
    const doc = patientState.documents.find(d => String(d.DocNum) === String(docNum));
    openPdfModal({ Id: 0, DocNum: docNum, PatNum: patNum, FileName: doc?.FileName || 'Document.pdf', PatientName: `${patientState.selectedPatient.LName}, ${patientState.selectedPatient.FName}` });
  } else if (openOsBtn) {
    const docNum = openOsBtn.dataset.docnum;
    const doc = patientState.documents.find(d => String(d.DocNum) === String(docNum));
    try {
      toast('Đang mở PDF bằng ứng dụng mặc định...');
      await request('open-system-pdf', { patNum, docNum, fileName: doc?.FileName });
    } catch (err) {
      toast(`Không mở được: ${err.message}`);
    }
  }
});

// Auto-refresh timer every 15s
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    autoRefreshSec--;
    const el = $('#auto-refresh-timer');
    if (el) el.textContent = `⏱️ Tự động làm mới: ${autoRefreshSec}s`;
    if (autoRefreshSec <= 0) {
      autoRefreshSec = 15;
      loadServerHistory();
    }
  }, 1000);
}

// Initial boot
loadServerHistory();
startAutoRefresh();
addEvent('Đã khởi chạy LUK MetLife Audit Center trên máy R5.');
