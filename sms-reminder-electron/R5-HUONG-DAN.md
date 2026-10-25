# SMS Electron v1.0.6 — một lịch chung

Chỉ dùng hai file scheduler-on.bat và scheduler-off.bat.

1. Đóng Electron cũ, giải nén toàn bộ gói v1.0.6 vào thư mục cố định.
2. Chạy scheduler-off.bat rồi scheduler-on.bat trong thư mục mới bằng Run as administrator. Các BAT này gỡ lịch Daily Recall riêng của bản 1.0.5.
3. Chọn Y cho Auto start Appointment + 6M Recall monitoring (mặc định).
4. Mỗi ngày lịch mở tool 10:55; đến giờ gửi trong Settings (mặc định 11:00, America/Chicago), tool chạy nhắc hẹn rồi Recall 6 tháng. Monitoring chỉ có một Start/Stop cho cả hai.

Recall lấy bệnh nhân có dịch vụ hoàn tất D1110 hoặc D4341 hoặc D4342 đúng ngày cách 6 tháng, mỗi người một tin cho ngày dịch vụ đó. Tool lấy template có sẵn trong DB: 6M RECALL - EN / ES / VI, theo ngôn ngữ bệnh nhân, ưu tiên nhóm appointment như ảnh đã cung cấp. Không cần tạo lại hoặc chuyển nhóm template. Thiếu mẫu đúng ngôn ngữ thì báo lỗi thay vì dùng nhầm tin nhắc hẹn.

Cấu hình và lịch sử AppData cũ được giữ lại. Giờ Recall riêng của bản cũ không còn sử dụng. Bridge SERVER cần contract calendar-6-month-v2 (82bc316 trở lên). R5 phải đăng nhập, mở khóa và Phone Link sẵn sàng. Sau giờ gửi hơn 30 phút, tool không tự chạy bù.

Đã kiểm tra logic/giao diện demo/gói Windows; chưa xác nhận chạy tác vụ Windows hay gửi SMS thực tế trên R5.
