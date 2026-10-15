# SERVER cập nhật bằng Git

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
