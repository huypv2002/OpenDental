# Bản Electron cho R5 Windows

Đây là project riêng, chuyển giao diện và nghiệp vụ SMS từ Python sang Electron. Đợt này ưu tiên R5; FD2 sẽ kiểm chứng riêng sau. Không cần cài Python hoặc Node trên R5.

## Mở lần đầu

1. Giải nén **toàn bộ** `LUK-Dental-SMS-Electron-R5-v1.0.2-win-x64.zip` vào thư mục cố định, ví dụ `C:\LUK\SMS-Electron`. Không chỉ chép mỗi EXE; giữ nguyên thư mục `resources` và các DLL.
2. Mở **LUK Dental SMS Electron.exe**.
3. Gói R5 đã kèm cấu hình Bridge thật trong `sms_config.json` cạnh EXE. Lần mở đầu app tự nhập cấu hình này; những lần sau giữ cấu hình đã lưu. Nếu máy đã mở bản Electron trước đó, vào **Settings → Import Python config** và chọn file kèm gói. File chứa API token riêng của phòng khám; không chia sẻ công khai. Template và lịch sử tiếp tục dùng Bridge hiện có.
4. Chọn **R5 — automated reminders**, kiểm tra URL Bridge trỏ tới SERVER, múi giờ `America/Chicago`, giờ gửi `11:00` hoặc giờ phòng khám đang dùng. Bấm **Save settings**, rồi **Test bridge connection**.
5. Giữ Phone Link đã đăng nhập/kết nối điện thoại, desktop đang mở khóa. Trong Dashboard chọn một bệnh nhân và bấm **Test selected (no send)**. Kiểm tra số điện thoại và đầy đủ nội dung bản nháp. Thao tác này không bấm gửi và không ghi log đã gửi.
6. Sau khi bản nháp đúng, có thể dùng **Send selected** để thử một tin đã được duyệt. Log nhắc lịch là **needs-review**; kiểm tra Phone Link rồi chọn **Mark sent**.

Bản 1.0.2 đã đối chiếu lại các luồng; xem `DOI-CHIEU-PYTHON.md`. Vẫn cần nghiệm thu trên R5 trước khi giao khách.

## Nhắc lịch tự động

Tab **Monitoring → Start Monitoring** chạy nhắc lịch theo mốc được cấu hình (mặc định 1 ngày) và 8 ngày trước hẹn. Cửa sổ chạy là 30 phút sau giờ gửi, không tự gửi bù cả ngày khi mở tool muộn. **Stop Monitoring** hoàn tất thao tác SMS hiện tại rồi dừng trước bệnh nhân tiếp theo.

Nếu dùng lịch Windows, hãy tắt scheduler Python cũ trên R5 trước. Chọn **Set up Windows scheduler**, cung cấp file Microsoft Sysinternals `Autologon64.exe`, chấp nhận UAC và nhập mật khẩu Windows thật, không dùng PIN. Các mốc mặc định:

- 08:59: bật tự đăng nhập.
- 09:00: khởi động lại Windows.
- 10:55: mở Electron và bắt đầu Monitoring.
- 12:05: tắt tự đăng nhập và khóa Windows.

Có thể dùng `scheduler-on.bat` / `scheduler-off.bat` cạnh EXE với quyền Administrator; đặt `Autologon64.exe` cùng thư mục nếu dùng BAT. Các tham số `run`, `enable-login`, `lock` cũng được giữ. Các giờ trong BAT có thể đọc/ghi bằng nút Reload/Save BAT times trong Monitoring; lưu giờ xong phải chạy setup lại để cập nhật task.

Lịch task dùng múi giờ Windows; lịch nhắc trong app dùng múi giờ phòng khám. Đặt R5 về Houston/Central để hai lịch khớp. Các task Electron có tên đầu **LUK Dental SMS Electron**, không tự xóa task Python.

Có thể chạy `r5-check.bat` để xuất `r5-check-result.json`: chỉ đọc trạng thái task, timezone, Bridge và tiến trình Phone Link; không gửi SMS hoặc chỉnh task.

## Khi cần kiểm tra lỗi

- `scheduler-run.log` cạnh EXE ghi luồng task on/run/lock.
- **Settings → Open settings folder** mở nơi lưu cấu hình, ledger, outbox và `scheduler-run.log`.
- Bridge mất kết nối sau thao tác gửi: log giữ ở máy và có thể **Sync pending logs**; không gửi lại SMS khi đồng bộ.
- Thao tác Phone Link chưa rõ thành công hay không: bản nhắc giữ **needs-review**, không tự thử gửi lại. Kiểm tra trong Phone Link trước khi reset.
- Lỗi tìm ô nhập trên Phone Link: dùng **Settings → Phone Link UI snapshot**. Metadata được lưu vào `phone-link-snapshot.json`.

## Mức kiểm chứng

Đã kiểm tra luồng nghiệp vụ bằng test mô phỏng, chạy giao diện Electron với dữ liệu giả và build gói Windows x64. **Chưa kiểm chứng gửi SMS, layout Phone Link hay scheduler trên R5 thực tế.** Cần hoàn tất thử bản nháp, một tin đã duyệt và lịch mở/khóa máy trên R5 trước khi thay tool Python đang chạy.

## Sửa nhận diện Phone Link 1.0.2

Dựa trên capture R5: ưu tiên InputTextBox và NewMessageButton theo AutomationId, gọi UIA SetFocus rồi kiểm tra focus thực tế, tránh vùng emoji/GIF khi click fallback, thống nhất tọa độ theo DPI. Capture mới bổ sung name/focused/focusable để chẩn đoán. Hãy đóng Electron cũ, giải nén bản mới, mở rồi dùng Test selected (no send) trước. Chưa có xác nhận chạy thành công trên R5.

## Cập nhật v1.0.3: Recall tự động theo code

Cập nhật Bridge trên SERVER trước. Đóng Electron cũ, giải nén toàn bộ gói v1.0.3 và mở LUK Dental SMS Electron.exe. Giữ nguyên cấu hình, template và lịch cũ; bấm Start Monitoring như trước. Sau lượt nhắc hẹn, tool chạy Recall đúng 6 tháng cho D1110/D4341/D4342 và chọn template Recall theo ngôn ngữ bệnh nhân. Không cần chạy bản Python.
