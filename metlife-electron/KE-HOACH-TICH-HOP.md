# MetLife: SERVER xử lý dữ liệu, R5 thao tác Open Dental

## Bổ sung luồng chính theo yêu cầu mới

Màn hình mặc định là Tìm bệnh nhân: tên / Patient ID / Chart Number / Subscriber ID / Group Number → chọn bệnh nhân → xem FINISHED CLAM → chọn PDF → Auto fill. Tự phát hiện file mới là chức năng bổ sung, không thay thế lựa chọn hồ sơ chủ động này.

Bản 0.2.0 đã có mã nguồn API và Electron cho tìm kiếm, danh sách tài liệu, đọc PDF và context tự động. Đã kiểm thử bằng SERVER giả lập, chưa cài SERVER phòng khám. Bản 0.3.0 đã bổ sung mã driver tự chọn patient/Insurance Paid/Splits/Save, API operations với khóa bền, recheck và readback. Đã kiểm thử điều phối giả lập và logic SERVER, chưa kiểm thử driver trên R5 thật. Các endpoint jobs tự động phát hiện nền phía dưới vẫn là kế hoạch; luồng chọn bệnh nhân/PDF đang là luồng chính.

## Mục tiêu

Anh Nhân tải PDF và đưa vào Imaging / FINISHED CLAM đúng bệnh nhân như hiện tại. Từ đó hệ thống tự phát hiện, đọc PDF, lấy dữ liệu OD mới, đối chiếu, hiển thị và chuẩn bị/ghi giao dịch trên R5. Người dùng không xuất hay nhập snapshot JSON trong quy trình hằng ngày.

Hiện trạng kiểm tra từ mã nguồn local: Bridge có Express, mysql2 pool và xác thực API. App Electron 0.1.2 chỉ nhận snapshot thủ công và mới điền phần đầu Payment. Những khả năng phía dưới là phần cần triển khai; chưa có trên SERVER/R5 chỉ vì có tài liệu này.

## SERVER — cài một lần

Bổ sung module MetLife vào Bridge hiện có, giữ nguyên dịch vụ booking/SMS. Module đọc document + definition để nhận tài liệu PDF thuộc FINISHED CLAM/Finished Claims và liên kết DocNum -> PatNum -> ImageFolder; chỉ đưa vào hàng đợi khi file ổn định, đọc được và đúng carrier. Không lấy số ở cuối tên thư mục làm định danh bệnh nhân.

Đọc PDF bằng Node/PDF.js, tái sử dụng parser hiện có. SHA-256 nội dung, DocNum và thời điểm thay đổi dùng để phát hiện file mới/thay thế. Đợt cài đặt đầu phải đánh dấu toàn bộ tài liệu cũ là cần đối chiếu, không tự hạch toán lịch sử.

Truy vấn trực tiếp DB để lấy hợp đồng MetLife, Group Number, patient/subscriber, procedure, claim, claimproc, claimpayment, payment và paysplit. Mỗi lần chuẩn bị điền và trước khi ghi phải đối chiếu lại dữ liệu mới. Các lần đọc dùng read-only transaction; không sửa dữ liệu tài chính OD bằng SQL trong luồng này.

Lưu hàng đợi, khóa lượt chạy, kết quả parser, phiên bản quy tắc và lịch sử xử lý ở kho riêng của tool, không sửa/xóa securitylog của OD. Job đã có dấu hiệu ghi tiền nhưng chưa xác minh phải chuyển trạng thái cần kiểm tra; không retry ghi một cách mù quáng.

Endpoint dự kiến, chưa triển khai:

- GET /api/metlife/health: DB, thư mục PDF, worker, phiên bản.
- GET /api/metlife/jobs: danh sách phân trang và trạng thái.
- GET /api/metlife/jobs/:id: dữ liệu PDF, bệnh nhân và kết quả đối chiếu.
- POST /api/metlife/jobs/:id/lease: cấp quyền xử lý duy nhất có hạn.
- POST /api/metlife/jobs/:id/preflight: đọc lại DB/file và kiểm tra trùng.
- POST /api/metlife/jobs/:id/result: nhận kết quả UI; SERVER đọc lại DB để xác minh.

Dùng token riêng chỉ có quyền các endpoint MetLife. R5 không nhận mật khẩu MySQL hoặc token quản trị chung. Cấu hình địa chỉ SERVER một lần; kiểm tra địa chỉ và cách chạy Bridge thực tế khi triển khai, không mặc định IP/port lịch sử vẫn đúng. Kênh truyền phải được bảo vệ bằng TLS hoặc mạng riêng đã xác thực; không mở MySQL ra Internet.

## R5 — cài một lần

Electron cấu hình kết nối dịch vụ MetLife trên SERVER và giữ thông tin xác thực trong kho bảo vệ của Windows. Khi mở app, tự kiểm tra kết nối, tải hàng đợi và cập nhật dữ liệu. Giao diện dùng style LUK Dental hiện có. Không yêu cầu chọn từng PDF, nhập Group Number hoặc chuyển JSON.

Worker R5 chỉ chạy một job mỗi lần, kiểm tra đúng OD process, đúng PatNum và popup trước mỗi thao tác. Tự điều hướng Account, mở Payment, nhập Amount, Payment Date, EFT/check trace, Payment Type chính xác Insurance Paid và Note `group number : {group}`. Bổ sung lựa chọn loại payment bằng UIA hoặc nhận diện chữ/ảnh có kiểm tra lại cho custom control; không coi giá trị cấu hình là bằng chứng UI đã chọn.

Hoàn thiện popup Splits, gắn đúng patient/provider/procedure và kiểm tra tổng theo quy tắc đã đối chiếu. Các selector hiện có chưa đủ cho mọi popup Attach/provider/Adjustment; worker phải tự chụp và xuất chẩn đoán khi gặp màn hình chưa hỗ trợ, không bắt người dùng capture từng màn hình thủ công.

Hoàn thiện chế độ ghi có kiểm tra: preflight mới -> kiểm tra các trường/splits -> ghi bằng Open Dental -> SERVER đọc lại payment/splits hoặc claim records đúng với phương thức hạch toán đã xác minh. Chỉ sau readback đạt mới hiển thị Đã nhập. Số dư hiển thị hoặc cửa sổ tự đóng không đủ để xác nhận.

Máy cần desktop đang đăng nhập/mở khóa khi chạy UI automation. Nếu OD không mở, đang bị modal khác chặn, hoặc người dùng đổi focus thì job dừng chờ, không click tiếp.

## Quy trình hằng ngày

1. Anh Nhân tải PDF và import vào đúng FINISHED CLAM như hiện tại.
2. SERVER tự phát hiện, đọc và đối chiếu; R5 hiển thị bệnh nhân, Group Number, claim, dịch vụ và tiền thực trả.
3. Hồ sơ hợp lệ: người dùng chọn xử lý; worker tự thực hiện và xác minh. Giai đoạn kiểm thử giữ ở bản nháp; bật ghi sau khi luồng nghiệp vụ và readback đã đạt.
4. Hồ sơ trùng, PDF thiếu/scan/mẫu khác, nhiều đối tượng khớp, hoặc dữ liệu thay đổi: hiển thị lý do cụ thể, không tự ghi.

## Phần người triển khai chịu trách nhiệm

Code module SERVER, thay snapshot bằng API trong Electron, hàng đợi và khóa job, hoàn thiện driver OD, đóng gói setup riêng cho hai máy, kiểm thử read-only và môi trường thử, cung cấp chẩn đoán tự động, hướng dẫn cập nhật/rollback. Người dùng chỉ cần hỗ trợ chạy gói cài một lần trên từng máy khi chưa có quyền điều khiển từ xa và xác nhận quy tắc nghiệp vụ còn thiếu.

## Điều kiện nghiệm thu

- Đưa một PDF vào Imaging: R5 tự hiện đúng DocNum/PatNum mà không nạp JSON.
- Đọc đúng Group Number và khoản thực trả; dữ liệu OD được lấy mới tự động.
- Insurance Paid thực sự được chọn; Note đúng group number; splits khớp tổng và procedure/provider.
- Hai worker/click liên tiếp không tạo hai giao dịch; mất kết nối hoặc crash sau Save không tự ghi lại.
- PDF đã nhập bị nhận diện; PDF thiếu/khác mẫu dừng với lý do.
- Thao tác ghi trên môi trường thử có readback DB đạt, sau đó mới xác minh trên R5 thật.
