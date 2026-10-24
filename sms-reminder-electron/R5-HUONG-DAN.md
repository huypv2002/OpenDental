# SMS Electron v1.0.5 — hai lịch độc lập

- Appointment: `scheduler-on.bat` / `scheduler-off.bat` như trước. Chỉ bật/tắt luồng Appointment.
- Recall D1110 / D4341 / D4342: `recall-scheduler-on.bat` / `recall-scheduler-off.bat`. Không bật kèm Appointment.
- Chạy BAT bằng Run as administrator trong toàn bộ thư mục bản mới đã giải nén, dưới tài khoản Windows R5 cần gửi.
- Tab Monitoring có Start/Stop Appointment và Start/Stop Recall riêng. Settings có giờ gửi riêng cho từng luồng, mặc định 11:00 theo múi giờ phòng khám.
- BAT on đăng ký lịch mở tool hằng ngày, mặc định 10:55 theo giờ Windows. Muốn bật ngay thì dùng nút Start tương ứng; vẫn chỉ gửi trong cửa sổ 30 phút tính từ giờ gửi đã đặt.
- BAT off bỏ lịch tương ứng và yêu cầu dừng luồng đó trong app đang mở; tin đang thao tác có thể hoàn tất. Luồng kia giữ nguyên.
- Recall không tạo tác vụ khởi động lại máy, tự đăng nhập hay khóa màn hình. Máy phải đăng nhập, mở khóa và Phone Link sẵn sàng. Tắt lịch Appointment cũng tắt các tác vụ tự đăng nhập/khởi động lại/khóa của lịch cũ; nếu chỉ dùng Recall thì cần bảo đảm máy sẵn sàng riêng.

Recall lấy dịch vụ đã hoàn tất đúng ngày cách 6 tháng: ngày 23/10/2026 lấy ngày 23/04/2026. Một trong ba code là đủ, một người một tin cho ngày dịch vụ đó. Có lịch hẹn hoặc làm thêm dịch vụ sau đó vẫn thuộc danh sách. Template theo ngôn ngữ trong Open Dental.

Cập nhật: đóng app cũ, giải nén toàn bộ bản 1.0.5, chạy lại Appointment on trong thư mục mới để đổi đường dẫn lịch cũ; bật Recall bằng BAT riêng nếu cần. Cấu hình cũ trong AppData được giữ lại. Bridge SERVER cần bản có contract calendar-6-month-v2 (82bc316 trở lên).

Đã kiểm tra logic và giao diện demo; chưa xác nhận chạy tác vụ Windows/gửi SMS thực tế trên R5.
