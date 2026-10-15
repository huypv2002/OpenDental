# LUK MetLife Assistant 0.3.6

Electron/JavaScript, cùng style LUK Dental SMS Electron. Luồng chính: **Tìm bệnh nhân → FINISHED CLAM → Chọn PDF → đối chiếu → Auto fill**. Không cần Python hoặc chuyển snapshot hằng ngày.

## SERVER: cập nhật chính Bridge hiện có

MetLife là `/api/metlife` trong `src/server.js` của Bridge, dùng cùng pool `src/db.js`, cùng process/cổng/tunnel. Không có backend MetLife riêng.

Trên SERVER chạy `od-bridge.bat` trong checkout Bridge hiện có để pull Git và restart cùng Bridge. Xem `../CAP-NHAT-METLIFE.md` cho lần cập nhật đầu. Electron tự kết nối trực tiếp SERVER trong LAN; không đăng nhập hay chép file kết nối.

## R5: kết nối một lần, sau đó tìm bệnh nhân

Giải nén toàn bộ gói Windows và mở LUK MetLife Assistant.exe. Giữ thư mục resources/locales/DLL cạnh EXE. Không cần Node hoặc Python trên R5.

1. Mở app trong mạng phòng khám: tự kết nối `http://SERVER:3008`, không đăng nhập hoặc chuyển file JSON. Nếu SERVER chưa sẵn sàng, bấm **Kết nối lại**. Tên SERVER cần phân giải được và cổng TCP 3008 phải cho phép trong mạng nội bộ. Khi dùng địa chỉ LAN khác, đặt `METLIFE_SERVER_URL=http://<IP-SERVER>:3008` trước khi mở app. Không tự mở truy cập ẩn danh qua tunnel Internet.
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

## Bản 0.3.3 — nhận diện cửa sổ OD

Tìm tiến trình OpenDental trong cùng phiên Windows, lấy cửa sổ bằng native handle và xác minh FormOpenDental qua UIA, kể cả form nằm dưới một root khác. Loại trùng handle và không tự chọn nếu có nhiều cửa sổ OD. Khôi phục cửa sổ chính đang thu nhỏ sau khi xác định duy nhất. Phân biệt không có tiến trình với tiến trình đang chạy nhưng UIA chưa đọc được. Lỗi discovery cũng lưu window-discovery.json trong thư mục od-diagnostics dưới userData. Đã kiểm tra cú pháp và policy bằng .NET; chưa xác minh native/UIA trên R5 thật. Cần thay toàn bộ app R5 để nhận bản vá này; cập nhật Bridge trên SERVER không thay adapter của app R5.

## Bản 0.3.4 — đăng ký WinForms UIA provider

Chẩn đoán R5 0.3.3 đã tìm thấy đúng tiến trình/cửa sổ OD nhưng AutomationId rỗng; capture R5 trước đây của cùng handle có FormOpenDental. Adapter đăng ký tường minh UIAutomationClientsideProviders trước mọi lookup UIA để đọc các ID/control WinForms bằng managed client. Vẫn xác minh FormOpenDental, không chọn chỉ bằng tiêu đề. File chẩn đoán bổ sung trạng thái đăng ký provider, assembly, bitness client, class/framework cửa sổ. Đây là bản sửa theo bằng chứng và tài liệu Microsoft, chưa xác nhận kết quả trên R5.

Đóng MetLife cũ, pull repo trên R5, vào `metlife-electron`, chạy `npm ci` rồi `npm start`. Nhấn Kiểm tra OD trước khi chạy Auto fill. Nếu chưa nhận ra, kiểm tra file window-discovery.json mới (có mục provider). Thay đổi này chỉ ở app R5; không cần cập nhật SERVER riêng cho lỗi provider.

Nguồn: https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/register-a-client-side-provider-assembly và https://source.dot.net/UIAutomationClientSideProviders/MS/Internal/AutomationProxies/ProxyHwnd.cs.html

## Bản 0.3.5 — UIA3 COM và kiểm thử Windows

Thay managed UIAutomationClient/UIAutomationClientsideProviders bằng UIAComWrapper 1.1.0.14 (native UIA3 COM). Không gọi RegisterClientSideProviderAssembly và không bỏ kiểm tra FormOpenDental để chọn theo tiêu đề. Giữ các pattern/control checks và xác minh dữ liệu. DLL được ghim phiên bản, SHA-256 và license trong windows/uia3; có sẵn khi pull source, không cần Python hoặc .NET SDK trên R5. Kiểm tra hash trước khi nạp, xác nhận assembly đúng và thực sự tạo desktop COM object trước khi báo khởi tạo thành công. Lỗi khởi tạo cũng lưu chẩn đoán.

Workflow Test MetLife Windows UI Automation chạy hai WinForms fixture x86/x64, kiểm tra native COM startup, form/control IDs, Value/Text/Selection/Invoke/Window patterns và gọi chính adapter PowerShell action inspect như Electron. Fixture là ứng dụng thử có tên/ID giống OD với dữ liệu giả; kết quả CI không thay thế nghiệm thu Open Dental thật trên R5. Test này chỉ thao tác fixture, không kết nối DB hoặc nhập tiền.

Cập nhật source trên R5: đóng MetLife, git pull ở root repo, vào metlife-electron, npm ci, npm start; nhấn Kiểm tra OD. Không cần tải ZIP hoặc sửa SERVER cho lỗi UIA.

Thư viện: https://github.com/TestStack/UIAComWrapper; package và hash cụ thể nằm trong windows/uia3/manifest.json. Các mục 0.3.3–0.3.4 phía trên là lịch sử; 0.3.4 đã gặp lỗi khởi tạo trên R5 và được thay thế.

## Bản 0.3.6 — Payment Type trong list tự vẽ OD

OD UI.ListBox xử lý Up/Down, không triển khai Home/PageDown như list chuẩn. Bộ chọn cũ có thể dừng ngay khi viewport lặp sau Home, trước khi thực sự duyệt mục phía dưới. Bộ chọn mới dùng Up/Down theo cả hai hướng, nhận diện hàng OCR và đọc lại mục được tô chọn. Fingerprint tính cả mục đang chọn, không dừng chỉ vì các dòng đang nhìn thấy chưa đổi. Không đổi sang loại tiền khác khi thiếu mục hoặc không đọc lại được.

Windows fixture bổ sung control tự vẽ không có UIA ListItem, bỏ qua Home/PageDown. Kiểm tra bằng OCR Windows thật: chọn Insurance Paid nằm ngoài viewport, tìm ngược lên Credit Card và từ chối nhãn không tồn tại. Vẫn cần nghiệm thu danh sách thực tại R5.

Nguồn control OD: https://github.com/OpenDental/opendental/blob/24_3/OpenDental/UI/ListBox.cs
