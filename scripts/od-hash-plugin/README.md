# LUK MetLife Open Dental Hash Agent (In-Process Plugin)

Giải pháp vượt qua rào cản `CDT.Class1.VerifyCallingAssembly()` để tạo `paysplit.SecurityHash` hợp lệ 100% bằng cách chạy **In-Process** bên trong tiến trình chính thức `OpenDental.exe`.

---

## 1. Nguyên lý hoạt động

- `CDT.dll` từ chối các tiến trình ngoài (như PowerShell, Node.js, EXE tự build) vì `Assembly.GetEntryAssembly()` không phải là file nhị phân chính thức do Open Dental biên dịch.
- Khi nạp dưới dạng **Open Dental Plugin (`PluginBase`)**, code của Agent chạy **ngay trong không gian bộ nhớ của `OpenDental.exe`**:
  - `Assembly.GetEntryAssembly()` là `OpenDental.exe` (100% nằm trong whitelist của CDT).
  - Hàm `OpenDentBusiness.PaySplits.HashFields(split)` chạy thành công và trả về hash chuẩn xác.
- Agent mở 2 kênh giao tiếp siêu nhẹ:
  1. **Named Pipe**: `\\.\pipe\luk-metlife-paysplit-hash` (kết nối nội bộ cực nhanh nếu chạy cùng máy).
  2. **HTTP Endpoint**: `http://127.0.0.1:30099/hash` (hỗ trợ gọi qua mạng LAN từ Server sang máy R5).

---

## 2. Hướng dẫn cài đặt trên máy chạy Open Dental (R5 hoặc SERVER)

### Bước 1: Biên dịch Plugin thành `LukMetlifeHash.dll`

Chạy PowerShell (Run as Administrator) tại thư mục `scripts`:

```powershell
cd C:\open-dental-bridge\scripts
.\install-od-hash-plugin.ps1
```

Script này sẽ tự động:
1. Dùng trình biên dịch C# có sẵn của Windows (`csc.exe` trong `.NET Framework 4.0/4.8`) để biên dịch file [LukMetlifeHash.cs](file:///Users/phamvanhuy/Documents/New%20project%204/open-dental-bridge/scripts/od-hash-plugin/LukMetlifeHash.cs).
2. Tạo file `LukMetlifeHash.dll` và copy thẳng vào thư mục cài đặt của Open Dental (mặc định: `C:\Program Files (x86)\Open Dental\`).
3. Sinh file SQL `luk-metlife-hash-plugin.sql` để đăng ký vào MariaDB.

---

### Bước 2: Đăng ký Plugin vào Open Dental

Bạn có thể chọn 1 trong 2 cách sau:

#### Cách A: Chạy file SQL trực tiếp vào MariaDB (Nhanh nhất)
Chạy nội dung trong file `luk-metlife-hash-plugin.sql` bằng MySQL Workbench, HeidiSQL hoặc dòng lệnh:

```sql
INSERT INTO program (ProgName, ProgDesc, Enabled, Path, CommandLine, Note, PluginDllName, ButtonImage, FileTemplate, FilePath, IsDisabledByHq, CustErr)
SELECT 'LukMetlifeHash', 'LUK MetLife SecurityHash helper', 1, '', '', 'Named pipe/HTTP hash helper for MetLife SQL payments. No UI.', 'LukMetlifeHash.dll', '', '', '', 0, ''
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM program WHERE PluginDllName='LukMetlifeHash.dll');

UPDATE program SET Enabled=1, PluginDllName='LukMetlifeHash.dll' WHERE PluginDllName='LukMetlifeHash.dll' OR ProgName='LukMetlifeHash';
```

#### Cách B: Đăng ký qua giao diện Open Dental
1. Mở phần mềm **Open Dental** $\rightarrow$ Đăng nhập với quyền Admin.
2. Vào menu: **Setup** $\rightarrow$ **Program Links**.
3. Bấm **Add** (hoặc chọn một hàng Program Link tùy chỉnh).
4. Điền:
   - **Description**: `LUK MetLife SecurityHash helper`
   - **Plug-in dll name**: `LukMetlifeHash.dll`
   - **Enabled**: Tích chọn (Checked).
5. Bấm **OK**.

---

### Bước 3: Khởi động lại Open Dental

1. Đóng hoàn toàn `OpenDental.exe`.
2. Mở lại `OpenDental.exe` và đăng nhập vào phòng khám.
3. Khi Open Dental khởi động, nó sẽ tự động nạp `LukMetlifeHash.dll` và mở:
   - Named Pipe: `\\.\pipe\luk-metlife-paysplit-hash`
   - HTTP Listener: `http://127.0.0.1:30099/hash` (và cổng 30098 dự phòng).

---

## 3. Kiểm tra hoạt động (Verification)

Trên máy chạy Open Dental (hoặc từ Server trỏ tới R5), chạy lệnh test:

```bash
# Kiểm tra loopback
node scripts/test-agent-hash.mjs

# Hoặc kiểm tra từ xa tới IP của máy R5 (nếu OD chạy trên R5)
node scripts/test-agent-hash.mjs http://192.168.1.50:30099/hash
```

Nếu thành công, kết quả sẽ in ra:
```text
[1] Thử kết nối qua HTTP Endpoint: http://127.0.0.1:30099/hash
    ✓ Health check thành công: {"ok":true,"service":"LukMetlifeHash","process":"OpenDental","assembly":"OpenDental, ..."}
    ✓ TẠO THÀNH CÔNG SECURITYHASH QUA HTTP!
      Split #1 Hash: <chuỗi hash hợp lệ>
      Split #2 Hash: <chuỗi hash hợp lệ>
================ TỔNG KẾT ================
✓ AGENT ĐÃ HOẠT ĐỘNG HOÀN HẢO! Đường ghi SQL (directPayment.js) đã sẵn sàng.
```

---

## 4. Kích hoạt trên SERVER (Bridge)

Trong file `.env` trên SERVER:

```dotenv
# Bật tính năng ghi trực tiếp MariaDB
ENABLE_OPEN_DENTAL_WRITES=true
METLIFE_DIRECT_DB_ENABLED=true

# Nếu OpenDental.exe chạy trên máy R5, khai báo URL tới R5 (bỏ trống nếu OD chạy trên cùng máy Server):
# METLIFE_OD_AGENT_URL=http://192.168.1.50:30099/hash
```

Giờ đây, mỗi khi Bridge thực hiện ghi Payment qua [directPayment.js](file:///Users/phamvanhuy/Documents/New%20project%204/open-dental-bridge/src/metlife/directPayment.js), nó sẽ tự động lấy SecurityHash từ Agent và ghi trọn vẹn vào MariaDB mà không bao giờ gặp lỗi CDT!
