# LUK MetLife Assistant 0.3.1

Electron/JavaScript, cùng style LUK Dental SMS Electron. Luồng chính: **Tìm bệnh nhân → FINISHED CLAM → Chọn PDF → đối chiếu → Auto fill**. Không cần Python hoặc chuyển snapshot hằng ngày.

## SERVER: cập nhật chính Bridge hiện có

MetLife là `/api/metlife` trong `src/server.js` của Bridge, dùng cùng pool `src/db.js`, cùng process/cổng/tunnel. Không có backend MetLife riêng.

Trên SERVER chạy `od-bridge.bat` trong checkout Bridge hiện có để pull Git và restart cùng Bridge. Xem `../CAP-NHAT-METLIFE.md` cho lần cập nhật đầu. Electron đã có sẵn địa chỉ SERVER; không cần chép file kết nối.

## R5: kết nối một lần, sau đó tìm bệnh nhân

Giải nén toàn bộ gói Windows và mở LUK MetLife Assistant.exe. Giữ thư mục resources/locales/DLL cạnh EXE. Không cần Node hoặc Python trên R5.

1. Tại **Tìm bệnh nhân**, nhấn **Đăng nhập SERVER**, nhập tài khoản quản trị LUK Dental (owner/admin). Địa chỉ SERVER có sẵn; phiên được mã hóa trên máy, app tự kết nối lại khi mở. Phiên hết hạn sau 30 ngày; tài khoản bị khóa/đổi quyền mất truy cập ngay. Không lưu mật khẩu. Nhập JSON cũ còn nằm trong phần cấu hình nâng cao.
2. Nhập tên, Patient ID/PatNum, Chart Number, Subscriber ID hoặc Group Number; có thể chọn loại tìm hoặc tìm tất cả. Group/Subscriber ID có thể trả nhiều bệnh nhân: xem Patient ID, ngày sinh và bảo hiểm rồi chọn đúng người.
3. Nhấn **Xem hồ sơ**: app lấy danh sách PDF trong FINISHED CLAM/FINISHED CLAIMS của chính PatNum đó. Chọn PDF để xem và đối chiếu. File và dữ liệu OD được lấy từ SERVER; không cần chọn thư mục UNC hay nạp JSON.
4. **Auto fill · bản nháp OD** tự tìm bệnh nhân trong OD bằng PatNum, kiểm tra lại tiêu đề, mở Account/Payment, nhập ngày/số tiền/trace/Note và chọn **Insurance Paid**. Nó xóa các Split do OD tự đề xuất trong Payment mới rồi tạo từng Split, gắn procedure hoàn tất theo ngày/mã/răng/provider. Không nhận diện hoặc đọc lại được thì dừng.
5. **Auto fill & Save vào OD**: SERVER đọc dữ liệu/file mới, khóa lượt ghi cho bệnh nhân; app tạo bản nháp hoàn chỉnh; SERVER kiểm tra lại ngay trước Save; app mở kiểm tra từng Split, bấm Save trong OD; SERVER đọc lại Payment và Splits để đối chiếu tất cả trường. Chỉ báo thành công khi readback đạt. Không gọi nút thu tiền thẻ/merchant.
6. Nếu timeout, crash hoặc readback không khớp: giữ lượt ghi trên SERVER và local, không tự nhập lại. Dùng **Kiểm tra kết quả trên SERVER** để xác minh; nếu vẫn không khớp phải kiểm tra giao dịch cụ thể. Lỗi trước Save chỉ giải phóng khóa khi dữ liệu tài chính không thay đổi. Khi mở hồ sơ, app tự lấy lại lượt ghi còn chờ từ SERVER ngay cả khi local journal mất.
7. Bản nháp có thể đóng bằng nút tool. OD/R5 cần đang đăng nhập, desktop mở khóa và cùng mức quyền với tool. Owner-drawn controls dùng Windows OCR tiếng Anh và nhận diện vùng chọn; thiếu OCR/control lạ sẽ dừng và tự chụp ảnh/control OD trong `od-diagnostics` dưới userData của app. Ảnh có thể chứa dữ liệu bệnh nhân, chỉ lưu trên máy và không được đóng gói vào bản phát hành.

**Driver 0.3.0 đã được viết và kiểm tra cú pháp; chưa được chạy xác minh trên R5.** Nên chạy luồng ghi trên bản sao database/môi trường thử trước khi sử dụng cho dữ liệu thật. Nếu OD tạo draft DB records ngay khi mở Payment, kiểm tra dữ liệu trước Save sẽ phát hiện và dừng thay vì tự bỏ qua; cần bằng chứng thực tế của phiên bản đó để xử lý tiếp.

Tab PDF & đối chiếu vẫn hỗ trợ mở PDF local và snapshot để chẩn đoán các trường hợp ngoại lệ. Đó không phải luồng dùng hằng ngày.

## Phạm vi dữ liệu và kiểm tra

SERVER xác định tài liệu qua DocNum + PatNum + category, không suy bệnh nhân chỉ từ tên file hoặc Group Number. Đọc filesystem theo AtoZfolder/ImageFolder, xác minh file nằm trong root và là PDF tối đa 30 MB đã ổn định. Chưa hỗ trợ ImageStore database/cloud.

Context đọc patient/subscriber/plan/procedure/claim/claimproc/payment/paysplit trong READ ONLY transaction, giữ nguyên ngày dạng string và ID lớn. Không thay đổi dữ liệu tài chính OD bằng SQL. Endpoint MetLife dùng bearer token riêng, không dùng token quản trị Bridge chung; R5 không nhận mật khẩu MySQL.

PDF.js hỗ trợ mẫu MetLife Claim Summary có text layer đã kiểm tra. PDF scan/mẫu khác/nhiều claim/thiếu Payment Detail hoặc tổng tiền lệch bị chặn. Tổng tiền dùng integer cents; claim number giữ cả hậu tố trong metadata. App giữ PDF/context trong RAM và lưu cấu hình, kết nối mã hóa, audit hash/loại thao tác. SERVER lưu journal chứa context trước ghi và kế hoạch đối chiếu trong thư mục riêng `METLIFE_JOB_DIR`; thư mục này chứa thông tin hồ sơ, cần quyền truy cập chỉ dành cho dịch vụ/quản trị phòng khám, không đặt trong thư mục web công khai. Xuất đối chiếu chứa dữ liệu hồ sơ do người dùng chọn nơi lưu.

## Đã kiểm tra và chưa xác minh

- Kiểm thử app/core với PDF mẫu local: parser, tiền/ngày, trùng giao dịch, định danh tài liệu, kết nối và cách ly tài liệu cùng tên.
- Kiểm thử API: mọi loại tìm kiếm, nhiều bệnh nhân chung group, token riêng, category + PatNum + DocNum, đường dẫn ngoài root, read-only transaction và cleanup lỗi.
- Electron UI trên macOS với SERVER giả lập: kết nối một lần, tìm group có 2 bệnh nhân, chọn đúng FINISHED CLAM, chọn PDF, tự lấy context, chặn khoản trùng và render 2 trang. Không dùng test này để khẳng định SERVER thực đã cài.
- Bộ cài thử trên thư mục Bridge giả lập: backup, token, file kết nối và chạy lại không nhân đôi route.
- Kiểm thử posting coordinator: khóa bền qua restart, duplicate, đúng/sai type/provider/procedure/amount, readback mới, drift trước Save, hash thay đổi và phục hồi lượt pending.
- Kiểm thử Electron Save với adapter/SERVER giả lập: hai pha preview/recheck/save, readback đạt, readback chưa xác minh giữ journal/chặn retry. Không ghi tiền hay chạy OD thật trong test này.
- PowerShell workflow policy chạy bằng .NET: gộp OCR tách cột, chọn đúng răng khi trùng code/ngày, không lấy số răng từ ngày hoặc mô tả; chuẩn hóa dấu phẩy tên và so ngày.
- PowerShell parser kiểm tra cả adapter/workflow/OCR. Đây không phải bằng chứng Windows OCR hoặc các popup thật đã chạy.
- Chưa cập nhật/chạy API trên SERVER phòng khám; chưa chạy app/adapter mới end-to-end trên R5; chưa xác minh luồng ghi tài chính/Splits trên database thực.

## Phát triển

Node 22.13+ (khuyến nghị 24) cho app dev. `npm ci`, `npm start`, `npm test`. Đặt METLIFE_SAMPLE_PDF tới PDF local để chạy integration; không commit PHI làm fixture. `npm run test:patients`, `npm run test:ui`, `npm run test:save`; có thể đặt METLIFE_ELECTRON_PATH để dùng runtime Electron đã cài cho test. `npm run pack:win` đóng gói Windows x64. Source API nằm tại `../src/metlife`.

UI integration fixtures are supplied locally through `METLIFE_SAMPLE_PDF`; configure `METLIFE_TEST_FIRST`, `METLIFE_TEST_LAST`, `METLIFE_TEST_GROUP`, and `METLIFE_TEST_CLAIM` to match the fixture. No patient PDF is included in Git.
