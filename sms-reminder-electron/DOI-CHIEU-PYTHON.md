# Đối chiếu Python → Electron 1.0.1 cho R5

Ngày rà soát: 11/10/2026. Bản 1.0.0 trước đó chưa được đối chiếu đủ; không dùng kết quả build của bản đó làm bằng chứng nghiệm thu.

> Tài liệu lịch sử. Hai bản Python đã được xóa khỏi repo ngày 25/10/2026; các đường dẫn dưới đây chỉ ghi lại nguồn đã đối chiếu trước đây. Có thể tra cứu mã cũ trong lịch sử Git. Hiện chỉ duy trì Electron.

## Nguồn đối chiếu

- `../sms-reminder-tool/sms_reminder_app.py`: giao diện, nghiệp vụ, Phone Link và Open Dental.
- `../sms-reminder-tool/scheduler-on.bat`, `scheduler-off.bat`, `setup-scheduler-tasks.ps1`: baseline scheduler R5.
- Bộ `../sms-reminder-tool-uiautomation/`: so khác biệt với bản UIAutomation. Hai bộ có cùng luồng nghiệp vụ; phần backend UIA khác nhau. BAT của bản chuẩn khóa lúc **12:05**, bản UIAutomation lúc **11:05**. Bản Electron lấy **12:05** từ BAT của bản chuẩn, cho phép chỉnh và lưu.

## Ma trận luồng chức năng

“Đã kiểm tra” ở đây là nguồn + test tự động/mô phỏng, không phải xác nhận SMS đã tới điện thoại trên R5.

| Luồng Python | Luồng Electron | Kết quả rà soát |
|---|---|---|
| Dashboard: chọn ngày hẹn, tải status cấu hình, lọc RECALL | `SmsService.load`, `expandAppointments` | Kiểm tra nghiệp vụ; API thật đọc được |
| Đếm lịch hẹn, chưa gửi, đã gửi, thiếu Wireless | `renderTable`, ledger/log | Có; không tính needs-review thành sent |
| Chọn nhiều dòng, tìm theo tên/phone/email/#PatNum, kéo cột | bảng ảo, selection/template map, column state | GUI đã chạy |
| Combo template: US/VI/ES, ngôn ngữ mặc định, cờ | SVG + customizable select của Chromium | Có cờ cả lựa chọn hiện tại và từng option; GUI kiểm tra ảnh tải thành công |
| Preview Dashboard: nội dung, default template, activity | dialog Preview | Đã bổ sung default/activity |
| Test selected (no send) | `compose(...,testOnly=true)` | Đã sửa lỗi áp dụng nhầm guard gửi thật; không Enter gửi, không log sent |
| Patient test khi không có hẹn | cảnh báo thiếu ngữ cảnh rồi tạo draft test | Khớp nhánh `ComposeReminderWorker` Python |
| Gửi/fill thật dùng template ngày/giờ nhưng không có hẹn | preflight dialog + backend guard | Khớp `start_send` Python; không tạo ngày/giờ giả |
| Send selected/all appointment | R5 sequential `send` | needs-review sau thao tác; chặn sent/dry-run/needs-review |
| Mark selected sent | `resetOrMark` | Chỉ đổi các lần gửi cần review, không ghi sent cho dòng chưa thử gửi |
| Reset selected not sent | reset-log + bỏ ledger + reset daily marker | Đã bổ sung reset marker; outbox chưa đồng bộ thì chặn reset |
| Clear dry-run, mở Phone Link, gửi test SMS thật có xác nhận | IPC/native actions | Có; không chạy gửi thật trong đợt kiểm tra này |
| Patient search debounce, Enter, #PatNum, nhiều kết quả | paged Bridge query, load more | Có; lỗi feed hẹn phụ không làm mất kết quả tìm bệnh nhân |
| Patient fill / Create FD2 draft | tuần tự, giữ draft, staff Sent/Not sent | Có; xác nhận từng dòng trước khi sang dòng tiếp theo |
| Patient Logs, Open Dental View | patient-history + native lookup | GUI History/View mô phỏng đã chạy; Open Dental thật cần R5 |
| Recall: tháng/codes/filter/count/last sent/logs | candidates + table + history | Có; lưu filter vào config và cảnh báo đã gửi ≥2 lần |
| Treatment: days/codes/statuses/count/last sent | candidates + manual drafts | Có; route log treatment giữ nguyên |
| Review Google: search/templates/review link/manual fill | candidates + review templates + manual draft | Có; không auto-send, không ghi giả log sent; hỗ trợ tiếp tục từng draft |
| Holiday/Birthday: ngày, lọc, campaign name | birthday feed + local filter, date MM/DD/YYYY | Đã sửa campaign/holiday placeholder sang ngày được chọn |
| Holiday event add/edit/delete | sms-settings holiday_events | Có; disable các nút event khi chọn Birthday |
| Custom recipients, remove, selected/all drafts | manual target + batch | Có; custom không dùng HmPhone/WkPhone thay Wireless; không làm lệch offset trang dữ liệu |
| Template CRUD cả 5 nhóm | Bridge CRUD/category editor | Có; uppercase key, rename, duplicate guard, giữ US/last template |
| Khởi tạo template thiếu / US_TODAY | templates/init rồi đọc lại | Có, cùng điều kiện migration với Python |
| Nội dung: tuổi/giới tính/salutation/ngày/weekday/relative day/custom defaults | `shared/model.mjs` | 288 nội dung so trực tiếp với hàm Python, khớp từng ký tự |
| Phone: +1, định dạng US, Wireless hợp lệ | `digits`, `formatPhone`, `phoneFor` | Đã sửa strip +1 và loại Wireless sai độ dài; giữ manual target explicit |
| Log appointment/patient/recall/treatment/campaign | `logPayload` + outbox | 40 payload so với BridgeClient Python, khớp |
| Monitoring Start/Stop, offset cấu hình +8, Houston DST | scheduler tick + persistent marker | Test điều kiện giờ/grace/restart/concurrency đã chạy |
| Settings: URL/token/import, clinic, review link, schedule/statuses | local config + shared settings | Có; token không trả lại renderer; chỉnh review link từ Settings hoặc Review |
| Logs: refresh/filter/history | Bridge logs + patient-history | Có; thêm Sync pending logs cho trường hợp mất mạng |

## Scheduler on/off: đối chiếu từng bước

| Bước trong Python | Bản Electron 1.0.1 |
|---|---|
| `scheduler-on.bat` yêu cầu Administrator | BAT kiểm tra `net session`; PowerShell kiểm tra Administrator lần nữa |
| Bốn `SET ..._TIME` | Giữ tên và mặc định 08:59, 09:00, 10:55, 12:05; Settings/Monitoring đọc và ghi BAT, lưu state |
| Chọn username/domain | BAT cho nhập; setup GUI dùng Windows credential prompt có thể đổi tài khoản |
| Mật khẩu thật, không phải PIN | SecureString/Get-Credential; Sysinternals Autologon; không lưu Windows password trong JSON/BAT |
| Chọn tự Start Reminder, file flag | Checkbox/BAT prompt; `scheduler-start-reminder.flag` 0/1; bỏ flag holiday/treatment cũ |
| Enable Auto Login: SYSTEM | Task bật `AutoAdminLogon=1` đúng giờ |
| Daily Restart: SYSTEM | `shutdown.exe /r /t 0` |
| Start Monitoring: tài khoản Windows, desktop interactive | Task `INTERACTIVE`, Highest; runtime mở Phone Link, chờ 15 giây, mở EXE với flag tùy chọn |
| Lock Screen: tài khoản Windows interactive | Tắt AutoAdminLogon rồi gọi LockWorkStation; vẫn gửi lệnh lock nếu việc ghi registry lỗi |
| Kết thúc setup: giữ credential nhưng tắt auto-login ngoài cửa sổ sáng | `AutoAdminLogon=0` sau setup |
| `scheduler-on.bat run/enable-login/lock` | Có đủ entrypoint, gọi native runtime đã package |
| `scheduler-off.bat` | Xóa đúng task Electron (kể cả Screen Off cũ), tắt auto-login |
| Log task: thời điểm, whoami, mở Phone Link/tool, lỗi | `scheduler-run.log` cạnh EXE; activity app lưu trong settings folder |
| Setup gặp lỗi | Xóa task Electron tạo dở, tắt auto-login nếu Autologon đã bị thay đổi, giải phóng BSTR |
| Task name prefix | `LUK Dental SMS Electron`; không tự xóa `LUK Dental SMS` hoặc `LUK Dental SMS UIAutomation` |

Định nghĩa bốn task được thực thi bằng PowerShell SDK trong test: tên task, bốn giờ, SYSTEM/INTERACTIVE, restart action và quoting đường dẫn có khoảng trắng đều đạt. Các file PowerShell được kiểm tra bằng parser PowerShell thật.

## Khác biệt có chủ đích

- Python scheduler dùng taskkill để giết tool cũ. Electron dùng single-instance và chuyển yêu cầu Monitoring sang instance hiện tại; không giết ngang một thao tác SMS hoặc draft đang mở.
- Lỗi native có thể xảy ra sau Enter. Electron giữ needs-review và ledger trước thao tác, không tự thử lại SMS mơ hồ. Python có nhánh ghi failed và thử lại theo timer; nhánh đó không được sao chép vì có thể gửi trùng.
- Outbox lưu log khi Bridge mất mạng, rồi chỉ đồng bộ log. Đây là bổ sung cho Python.
- Rename default US bị chặn; Python có thể xóa US trong nhánh rename rồi khởi tạo lại mặc định. Electron giữ US và yêu cầu Add template khi muốn key mới.
- Review Google không ghi sent nếu chưa có loại log tương ứng. Nguồn Python dùng batch chung nhưng không đặt cờ loại manual cho Review; giữ ý định manual-only và thêm Next draft rõ ràng.
- Native adapter dùng .NET UIA/PowerShell thay pywinauto/uiautomation Python: cùng chuỗi đóng/mở → new message → recipient → paste → verify → send hoặc giữ draft. Có scoring InputTextBox, vị trí compose pane, coordinate/Tab fallback và Value/Text/Legacy patterns. Electron dừng nếu không xác minh được số/nội dung; Python FD2 có nhánh trả thành công khi verification không rõ.

## Bằng chứng và phần chưa nghiệm thu

Đã chạy: JavaScript syntax; 32 service/domain tests; 288 message cases +40 log payloads +6 phone cases cho mỗi bộ Python gốc (chuẩn và UIAutomation); GUI demo mở đủ 10 tab và các luồng CRUD/draft/birthday/scheduler control; PowerShell parser và task-plan execution. Bridge thật đã đọc được dữ liệu bằng HTTPS; không gửi SMS, không sửa dữ liệu bệnh nhân trong quá trình kiểm tra.

**Chưa xác nhận trên R5 Windows thật:** UIA tree/layout của Phone Link đang cài, paste Unicode thực tế, một SMS được duyệt, Open Dental lookup, UAC/Autologon theo tài khoản R5, task startup sau restart, task lock đúng session và trạng thái log trong Task Scheduler. Kiểm tra source/parser/build không thay thế các bước này. FD2 vẫn là đợt nghiệm thu sau R5.

Vì chưa có kết quả R5 thực tế, gói 1.0.1 là bản để nghiệm thu trên R5, chưa được đánh dấu sẵn sàng bàn giao khách. Không chạy cả scheduler Python và Electron cùng lúc.

## Bản vá Phone Link 1.0.2 từ capture R5

Capture có InputTextBox (Edit, enabled, onscreen) tại 872,759,614,40; Search TextBox và emoji/GIF/attach/send là các control riêng. Adapter mới ưu tiên AutomationId, SetFocus trước click vùng chữ bên trái, kiểm tra focused element thực tế, giữ xác minh nội dung trước Send và thêm DPI context. Snapshot cũ không có Name/focus, nên chưa kết luận nguyên nhân duy nhất. Test policy được thực thi bằng PowerShell SDK với toàn bộ metadata capture và edge cases; vẫn cần Test selected (no send) trên R5.

## Bản vá scheduler sau phản hồi R5

Đối chiếu lại BAT + PowerShell chuẩn/UIAutomation: bản cũ dùng Start-Process -Wait -PassThru và Process.ExitCode. Electron trước bản vá dùng native invocation + LASTEXITCODE và thêm /accepteula phía sau password. Bản vá R5-scheduler-fix.zip khôi phục launch đồng bộ và đúng ba đối số, thêm quoting password và hiển thị mã thoát thực tế. Launch contract được test với LASTEXITCODE cũ/sai, exit 0/42/null và argument có khoảng trắng, quote, backslash. Vẫn chưa chứng minh tự đăng nhập thực tế trên R5.
