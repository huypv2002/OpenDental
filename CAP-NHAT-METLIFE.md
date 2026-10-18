# MetLife 0.4.0 — cập nhật source SERVER và R5

Repo: https://github.com/huypv2002/OpenDental — nhánh `main`.

Trong checkout Bridge hiện có trên SERVER, lần đầu lấy launcher mới:

```bat
git pull --ff-only origin main
od-bridge.bat
```

Từ lần sau chỉ chạy `od-bridge.bat` (hoặc `start-bridge-and-tunnel.bat`). Có thể tạo shortcut tới file này trên Desktop. Launcher tự pull nhánh main, cài dependency theo lockfile, tạo cấu hình MetLife nếu thiếu, restart API đang nghe trên cổng Bridge và kiểm tra `/health`. Giữ tunnel `od-bridge` đang chạy; chỉ mở tunnel nếu chưa thấy process tương ứng. Không dừng những process Node/SMS khác. `.env` và journal được giữ nguyên, không dùng git reset. Nếu source tracked có sửa local hoặc pull lỗi thì dừng trước bước restart và hiện lỗi để xử lý.

Launcher dành cho Bridge đang chạy bằng Node/BAT. Nếu đang chạy bằng Windows service/scheduled supervisor, phải dùng đúng cơ chế restart của supervisor để tránh nó tự mở lại process cũ.

MetLife dùng cùng process, DB pool và URL `https://od-bridge.lukdental.us/api/metlife`. SERVER không chạy thêm app MetLife riêng. Electron 0.3.2 tự kết nối `http://SERVER:3008` trong mạng phòng khám khi mở: không đăng nhập và không chuyển JSON. Có nút Kết nối lại. SERVER phải phân giải được tên máy và cho phép R5 truy cập TCP 3008 trên mạng nội bộ. Có thể đặt biến môi trường `METLIFE_SERVER_URL=http://<IP-LAN-SERVER>:3008` khi cần địa chỉ riêng; chỉ nhận địa chỉ LAN/loopback.

Truy cập không cần tài khoản chỉ áp dụng với desktop đi trực tiếp trong LAN, Host là tên/IP máy SERVER và socket hai đầu là địa chỉ nội bộ. Request từ browser hoặc proxy/tunnel không được miễn xác thực. Địa chỉ Internet `od-bridge.lukdental.us` tiếp tục yêu cầu token; không nhúng khóa dùng chung vào bộ cài. Các máy trên mạng LAN phòng khám được coi là máy tin cậy cho API MetLife.

Source Electron R5 nằm trong `metlife-electron`. Chưa xác minh launcher trên Windows SERVER thật và chưa chạy driver Save trên R5 thật; kiểm thử local không thay thế các bước xác minh đó.

## Triển khai 0.4.0

Không đưa `.env`, token hay mật khẩu DB vào Git hoặc bộ cài. Người quản trị cấu hình các biến trên SERVER; launcher giữ nguyên giá trị hiện có.

SERVER, tại thư mục Bridge:

```bat
git pull --ff-only origin main
npm ci
npm run metlife:inspect -- metlife-db-diagnostics.json
od-bridge.bat
```

Lệnh inspect dùng kết nối `DB_*` hiện có, chỉ SELECT metadata schema/engine và một nhóm preference. File JSON không chứa mật khẩu/token/hồ sơ bệnh nhân. Chẩn đoán này chỉ dành cho kỹ thuật viên trên SERVER, không nằm trong giao diện khách hàng. Endpoint: `GET /api/metlife/diagnostics/database`, cùng xác thực với API MetLife hiện có. Không cần capture cửa sổ OD.

Các giá trị do quản trị viên tự cấu hình trên SERVER:

```dotenv
ENABLE_OPEN_DENTAL_WRITES=true
METLIFE_DIRECT_DB_ENABLED=true
METLIFE_OD_USER_NUM=<UserNum OD dành cho tích hợp>
```

`METLIFE_OD_USER_NUM` cần là tài khoản OD đang hoạt động, không tự chọn tài khoản khác. Khi chưa cấu hình, app vẫn đọc/đối chiếu và báo rõ mục còn thiếu; không tự bật quyền ghi. Nếu báo MyISAM/schema không hỗ trợ, giữ nguyên DB và gửi báo cáo metadata để bổ sung adapter; không tự chuyển engine hoặc bỏ kiểm tra.

R5, tại thư mục checkout cùng repo:

```bat
git pull --ff-only origin main
cd metlife-electron
npm ci
npm start
```

Đóng app cũ trước khi mở source mới. `.env` DB chỉ nằm ở SERVER, không cần chép sang R5. Nếu đã ở `metlife-electron`, bỏ dòng `cd`. Màn hình mới vẫn dùng cùng bộ style LUK của SMS tool. Giao diện hiện đầy đủ thông tin đối chiếu; lưu gọi SERVER, không cần OCR/chuột trên OD. Refresh Account trên OD để kiểm tra khoản mới.

Workflow **Validate MetLife deployment** chạy trên thay đổi MetLife ở `main`: kiểm thử SQL bằng MariaDB 10.5 với dữ liệu tổng hợp, kiểm thử Electron trên Windows và tạo portable EXE trong artifact `LUK-MetLife-0.4.0-Windows`. Các workflow SMS không được kích hoạt bởi bản cập nhật này. Không gắn tag `v*` vì tag đó thuộc luồng build SMS.

Giới hạn vẫn giữ nguyên: adapter ghi Payment/Splits theo quy trình Insurance Paid hiện có, không thay thế nghiệp vụ nhận insurance claim, OD Audit Trail hoặc aging/balance. Nghiệm thu Account, báo cáo và số dư trên clone trước khi bật cho dữ liệu thật. CI và artifact thành công không đồng nghĩa SERVER/R5 đã pull/restart hoặc dữ liệu phòng khám đã được xác minh.

Giao diện khách hàng 0.4.0 chỉ có tìm bệnh nhân, tài liệu, đối chiếu, lưu/xác minh, hướng dẫn và lịch sử thao tác. Không hiển thị URL/DB/schema, snapshot/JSON, ID nội bộ procedure/plan, OCR/driver hoặc nhật ký kỹ thuật. Dùng CLI `npm run metlife:inspect` trên SERVER cho chẩn đoán kỹ thuật.

## Kết quả phát hành source 0.4.0 — 18/10/2026

Code phát hành: `0e073aa`, đã có trên `origin/main`.

CI: https://github.com/huypv2002/OpenDental/actions/runs/39139304638 — cả hai job MariaDB và Windows thành công. MariaDB 10.5 chạy SQL thật trên database tổng hợp dùng riêng, gồm commit/readback, ghi lặp, rollback giữa các splits, mất phản hồi commit và chặn engine không hỗ trợ. Windows chạy Electron 44.7.2, kiểm thử app, lưu/xác minh giả lập, tự kết nối, kiểm tra UI khách hàng không có nội dung kỹ thuật/menu debug; portable EXE đã build và upload.

Artifact: `LUK-MetLife-0.4.0-Windows` (portable EXE). Icon răng hiện có được giữ nguyên và chuyển đổi kích thước khi đóng gói. Không nhúng `.env` hay thông tin kết nối DB vào EXE.

Chưa xác minh chạy EXE trên R5, chưa restart SERVER/R5 và chưa ghi DB thật của phòng khám. Quản trị viên cấu hình `.env` trên SERVER, kiểm tra metadata bằng CLI rồi cập nhật theo các bước phía trên.
