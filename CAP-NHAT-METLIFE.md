# SERVER cập nhật bằng Git

Repo: https://github.com/huypv2002/OpenDental — nhánh `main`.

Trong checkout Bridge hiện có trên SERVER, lần đầu lấy launcher mới:

```bat
git pull --ff-only origin main
od-bridge.bat
```

Từ lần sau chỉ chạy `od-bridge.bat` (hoặc `start-bridge-and-tunnel.bat`). Có thể tạo shortcut tới file này trên Desktop. Launcher tự pull nhánh main, cài dependency theo lockfile, tạo cấu hình MetLife nếu thiếu, restart API đang nghe trên cổng Bridge và kiểm tra `/health`. Giữ tunnel `od-bridge` đang chạy; chỉ mở tunnel nếu chưa thấy process tương ứng. Không dừng những process Node/SMS khác. `.env` và journal được giữ nguyên, không dùng git reset. Nếu source tracked có sửa local hoặc pull lỗi thì dừng trước bước restart và hiện lỗi để xử lý.

Launcher dành cho Bridge đang chạy bằng Node/BAT. Nếu đang chạy bằng Windows service/scheduled supervisor, phải dùng đúng cơ chế restart của supervisor để tránh nó tự mở lại process cũ.

MetLife dùng cùng process, DB pool và URL `https://od-bridge.lukdental.us/api/metlife`. SERVER không chạy thêm app MetLife riêng. File `metlife-r5-connection.json` chứa token kết nối: chuyển riêng sang R5 và chọn một lần trong Electron; không đưa lên Git hay gửi công khai. Những lần dùng sau tool tự tìm bệnh nhân, lấy Finished Claims và PDF qua API.

Source Electron R5 nằm trong `metlife-electron`. Chưa xác minh launcher trên Windows SERVER thật và chưa chạy driver Save trên R5 thật; kiểm thử local không thay thế các bước xác minh đó.
