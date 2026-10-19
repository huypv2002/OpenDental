// Test runner for In-Process OD Hash Agent (HTTP and Named Pipe)
// Usage: node scripts/test-agent-hash.mjs [agent-url]
import net from 'node:net';

const agentUrl = process.argv[2] || process.env.METLIFE_OD_AGENT_URL || 'http://127.0.0.1:30099/hash';
const pipeName = '\\\\.\\pipe\\luk-metlife-paysplit-hash';

const sampleInput = {
  splits: [
    { patNum: '1', amount: '10.00', date: '2026-10-19' },
    { patNum: 1, amount: '25.50', date: '2026-10-19' }
  ]
};

console.log('--- Kiểm tra In-Process OD Hash Agent (LukMetlifeHash) ---');

async function testHttp() {
  console.log(`\n[1] Thử kết nối qua HTTP Endpoint: ${agentUrl}`);
  try {
    const healthUrl = agentUrl.replace(/\/hash\/?$/, '/hash');
    const healthRes = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (healthRes.ok) {
      const info = await healthRes.json();
      console.log('    ✓ Health check thành công:', JSON.stringify(info));
    }
  } catch (e) {
    console.log('    ℹ Health check GET bỏ qua hoặc không hỗ trợ:', e.message);
  }

  try {
    const res = await fetch(agentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleInput),
      signal: AbortSignal.timeout(5000)
    });
    console.log(`    HTTP status: ${res.status}`);
    const data = await res.json();
    console.log('    Phản hồi từ Agent:', JSON.stringify(data, null, 2));

    if (data.ok && Array.isArray(data.hashes) && data.hashes.length === 2) {
      console.log('    ✓ TẠO THÀNH CÔNG SECURITYHASH QUA HTTP!');
      data.hashes.forEach((h, i) => console.log(`      Split #${i + 1} Hash: ${h}`));
      return true;
    } else {
      console.log('    ✗ Agent trả kết quả lỗi:', data.error);
      return false;
    }
  } catch (e) {
    console.log('    ✗ Lỗi kết nối HTTP:', e.message);
    return false;
  }
}

function testPipe() {
  if (process.platform !== 'win32') {
    console.log('\n[2] Bỏ qua kiểm tra Named Pipe (chỉ chạy trên Windows).');
    return Promise.resolve(false);
  }
  console.log(`\n[2] Thử kết nối qua Named Pipe cục bộ: ${pipeName}`);
  return new Promise((resolve) => {
    const socket = net.connect({ path: pipeName });
    let output = '';
    const timer = setTimeout(() => {
      socket.destroy();
      console.log('    ✗ Named pipe timed out.');
      resolve(false);
    }, 5000);

    socket.setEncoding('utf8');
    socket.on('error', (err) => {
      clearTimeout(timer);
      console.log('    ✗ Không kết nối được pipe:', err.message);
      resolve(false);
    });
    socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(output.trim().split(/\r?\n/)[0] || '');
        console.log('    Phản hồi từ Pipe:', JSON.stringify(data, null, 2));
        if (data.ok && Array.isArray(data.hashes) && data.hashes.length === 2) {
          console.log('    ✓ TẠO THÀNH CÔNG SECURITYHASH QUA NAMED PIPE!');
          data.hashes.forEach((h, i) => console.log(`      Split #${i + 1} Hash: ${h}`));
          resolve(true);
        } else {
          console.log('    ✗ Pipe trả kết quả lỗi:', data.error);
          resolve(false);
        }
      } catch (e) {
        console.log('    ✗ Lỗi đọc dữ liệu từ Pipe:', e.message);
        resolve(false);
      }
    });
    socket.on('connect', () => {
      socket.write(JSON.stringify(sampleInput) + '\n');
    });
  });
}

async function run() {
  const httpOk = await testHttp();
  const pipeOk = await testPipe();

  console.log('\n================ TỔNG KẾT ================');
  if (httpOk || pipeOk) {
    console.log('✓ AGENT ĐÃ HOẠT ĐỘNG HOÀN HẢO! Đường ghi SQL (directPayment.js) đã sẵn sàng.');
  } else {
    console.log('✗ Chưa kết nối được Agent. Hãy đảm bảo:');
    console.log('  1. Đã biên dịch LukMetlifeHash.dll vào thư mục cài Open Dental.');
    console.log('  2. Đã chạy file SQL đăng ký Plugin vào MariaDB.');
    console.log('  3. OpenDental.exe đang mở và đăng nhập.');
  }
}

run();
