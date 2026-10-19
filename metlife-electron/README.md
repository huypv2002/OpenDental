## Bản hiện tại 0.6.0 — một ứng dụng thanh toán

Chạy `npm start` trong `metlife-electron`. Chỉ còn **LUK MetLife Payments**, sử dụng luồng request `direct-db` đã có trên Bridge. Ứng dụng không gọi bộ điều khiển giao diện OD, không có tự điền hay lựa chọn API OD/OpenAI. Các mô tả phiên bản cũ phía dưới chỉ là lịch sử.

Luồng khách hàng: **Tìm bệnh nhân → chọn PDF Finished Claims → đối chiếu hồ sơ và từng dịch vụ → Lưu khoản thanh toán → xem kết quả xác minh**.

- Hiển thị bệnh nhân, tổng tiền, ngày, số tham chiếu và trạng thái ở đầu hồ sơ.
- Có thể mở PDF cùng thông tin đối chiếu; cửa sổ hẹp xếp PDF phía dưới.
- Nút lưu đi cùng tổng tiền ở cuối hồ sơ. Chỉ mở khi tài liệu thuộc hồ sơ trên Bridge, dữ liệu khớp và Bridge đã bật chức năng lưu.
- Khi chưa xác minh, giữ lượt lưu và khóa gửi lại; dùng Kiểm tra kết quả để khôi phục. Dùng lại profile `api-od` của bản thanh toán cũ để giữ journal còn chờ.
- Thông báo khách hàng không hiển thị DB, hash, key hoặc nội dung chẩn đoán.

Build Windows: `npm run dist:win`, xuất `dist/payments/LUK-MetLife-Payments-0.6.0.exe`. Gói mới không chứa tài nguyên điều khiển giao diện OD. Không thay đổi cơ chế hash hoặc ghi DB trong lần thiết kế giao diện này. Kiểm tra UI dùng tài liệu tổng hợp và Bridge giả lập, không ghi hồ sơ thật.

---

## Lịch sử phiên bản 0.5.0 — hai ứng dụng độc lập

- **LUK MetLife Client**: chỉ tự điền và đóng bản nháp OD, không có nút gửi thanh toán. Chạy source: `npm run start:client` (hoặc `npm start`).
- **LUK MetLife API**: chỉ gửi thanh toán qua API OD, không có tự điền và không đóng gói bộ điều khiển OD. Chạy source: `npm run start:api`.

Mỗi bản có EXE, app ID, thư mục dữ liệu và khóa single-instance riêng. Có thể mở cả hai. Bản đóng gói khóa edition trong metadata, không cho đổi bằng tham số khởi chạy. Quyền thao tác được kiểm tra ở main process.

**Trạng thái phòng khám:** chưa có key API và OD 24.3 chưa đáp ứng phân bổ từng procedure theo endpoint Partial. Vì vậy Client dùng được chức năng tự điền; bản API chỉ xem/đối chiếu, khóa Lưu cho tới khi được cấu hình hợp lệ. Không có bước ghi SQL hay Save trên client thay thế cho API. Không triển khai bỏ key hoặc sửa CDT.

Cấu hình nội bộ SERVER tham khảo `.env.metlife-api.example` ở repo gốc. Key chỉ đặt trên SERVER. Backend yêu cầu OD >=25.1.11, API được bật và cặp key được cấp quyền Payments; mặc định tắt. Sau POST tạo payment, lưu PayNum vào journal trước PUT Partial; mất phản hồi giữ trạng thái chưa xác minh, không tự retry. Nghiệm thu clone với API thật vẫn chưa được thực hiện.

Build: `npm run dist:win` tạo hai EXE ở `dist/client` và `dist/api-od`. Các mục 0.4.x dưới đây là lịch sử, không mô tả bản hiện tại.

## Lịch sử phiên bản 0.4.2 — tách Tự điền và Lưu trực tiếp

**Tự điền trên OD · Chưa lưu** chỉ mở và điền bản nháp trên client OD, không bấm Save, không gọi endpoint post/prepare. Người dùng kiểm tra rồi tự lưu hoặc đóng trên OD.

**Lưu trực tiếp** là đường request riêng đến Bridge (`direct-db`), không điều khiển OD. Không được dùng khi đang mở bản nháp để tránh nhập hai lần. Trên bộ DLL OD 24.3 của SERVER hiện tại, đường request vẫn bị chặn ở `CDT.Class1.VerifyCallingAssembly`; bản này không khắc phục hoặc bỏ qua xác minh đó. Có thể dùng đường tự điền trong khi giải quyết backend request.

Chạy source tại `metlife-electron`: `npm start`. Giao diện phải hiện v0.4.2 và hai nút riêng. Những mô tả 0.4.1 bên dưới là lịch sử, không phải hành vi hiện tại.

## Lịch sử phiên bản 0.4.1 — lưu qua client OD

Giữ giao diện tìm bệnh nhân, PDF và đối chiếu. Nút Lưu tự điền trên client OD cùng máy, kiểm tra lại với Bridge rồi bấm Save; sau đó đọc lại DB để xác minh. Không dùng đường ghi SQL trực tiếp hoặc helper CDT cho thao tác Lưu. Các mục 0.4.0/direct DB bên dưới mô tả bản trước.

Cần cập nhật Bridge trên SERVER và dùng EXE 0.4.1 trên R5, mở OD, giữ desktop không khóa và không thao tác chuột/bàn phím trong lúc tool chạy. Lượt đã cấp quyền Save nhưng chưa xác minh sẽ giữ khóa chống ghi trùng. Phải nghiệm thu trên client OD thật.

# LUK MetLife Assistant 0.4.0

Electron/JavaScript, cùng style LUK Dental SMS Electron. Luồng chính: **Tìm bệnh nhân → FINISHED CLAM → Chọn PDF → đối chiếu đầy đủ → Lưu qua SERVER → xác minh Payment/Splits**. Không cần Python hoặc chuyển snapshot hằng ngày.


## Trạng thái đường ghi DB mới (0.4.0)

Đã triển khai source và kiểm thử giả lập; **chưa triển khai/ghi thử DB clone hoặc DB thật của phòng khám**. Đây là adapter SQL thử nghiệm, không tuyên bố tương đương toàn bộ nghiệp vụ/audit/aging của OD. Khuyến nghị chính thức của Open Dental là ghi qua API: https://www.opendental.com/site/integrationtypes.html . Không dùng API Payments POST để thay tùy tiện cho insurance claim payment: https://www.opendental.com/site/apipayments.html .

Phạm vi giữ nguyên quy trình của tool trước: tạo `payment` có definition “Insurance Paid” và `paysplit` gắn vào procedure. Không tạo `claimpayment`, không đổi `claimproc` hay trạng thái claim. Nhật ký `luk_metlife_postings` là nhật ký tích hợp; **không phải Audit Trail/securitylog của OD**. Adapter không sinh hash hoặc giả mạo log OD, chưa xử lý aging/account balance cache và các hook/plugin khi Save bằng OD. Cần đối chiếu Account, báo cáo thu, số dư/aging và audit trên clone trước khi xem là sẵn sàng production. Nếu cần đủ các side effect này, phải dùng API hoặc lớp nghiệp vụ OD phù hợp phiên bản.

SERVER mặc định chỉ đọc. Chỉ bật thử trên clone sau khi xác minh schema:

```dotenv
ENABLE_OPEN_DENTAL_WRITES=true
METLIFE_DIRECT_DB_ENABLED=true
```

Writer dùng transaction cho InnoDB, khóa bảng/nhật ký ý định cho MyISAM OD 24.3; cần khóa AUTO_INCREMENT và schema tương thích; hỗ trợ MyISAM OD 24.3 bằng khóa bảng/nhật ký ý định, từ chối random keys, khóa ngày và các cấu hình kế toán được phát hiện mà adapter chưa hỗ trợ. Không đổi engine/schema bảng OD. Không bỏ khóa ngày hay vô hiệu hóa cấu hình OD để vượt qua lỗi. Hai cờ trên chỉ cho phép chạy adapter; không chứng minh nó tương thích mọi cấu hình OD.

`POST /api/metlife/operations` với `transport:"direct-db"` chuẩn bị kế hoạch. `POST /api/metlife/operations/:id/post` kiểm tra PDF, khóa/đọc lại dữ liệu trong transaction SERIALIZABLE, ghi Payment + từng Split + biên nhận idempotency, đọc lại xác minh trước commit. `.../verify` yêu cầu biên nhận transaction khớp đúng PayNum rồi đọc lại Payment/Splits. Lỗi trước commit rollback; lỗi/mất kết nối lúc commit giữ pending và chỉ xác minh. Không tự gửi lại lệnh ghi. Bản ghi đã xác minh gọi lại sẽ không tạo Payment mới.

Kiểm chứng local: `npm run test:metlife`, `npm --prefix metlife-electron test`, và `npm --prefix metlife-electron run test:save` (PDF tổng hợp, SERVER giả lập, xác nhận không gọi Windows automation). Test giả lập không thay thế kiểm thử MySQL/MariaDB và OD thật. Electron UI local chạy bằng runtime 44.7.0 đã có trên máy; package vẫn pin 44.7.2, chưa đóng gói/kiểm chứng binary 44.7.2.

Các mục phiên bản 0.3.x bên dưới mô tả driver UI cũ. Driver còn giữ để chẩn đoán/đóng draft cũ; không nằm trong luồng lưu chính 0.4.0.

## SERVER: cập nhật chính Bridge hiện có

MetLife là `/api/metlife` trong `src/server.js` của Bridge, dùng cùng pool `src/db.js`, cùng process/cổng/tunnel. Không có backend MetLife riêng.

Trên SERVER chạy `od-bridge.bat` trong checkout Bridge hiện có để pull Git và restart cùng Bridge. Xem `../CAP-NHAT-METLIFE.md` cho lần cập nhật đầu. Electron tự kết nối trực tiếp SERVER trong LAN; không đăng nhập hay chép file kết nối.

## R5: kết nối một lần, sau đó tìm bệnh nhân

Chạy Electron source từ checkout Git trên R5 (đã cài Node.js):

```bat
git pull --ff-only origin main
cd metlife-electron
npm ci
npm start
```

Nếu đã ở trong thư mục `metlife-electron`, bỏ dòng `cd`. Đóng app đang chạy trước khi mở lại để nhận source mới.

1. Mở app trong mạng phòng khám: tự kết nối `http://SERVER:3008`, không đăng nhập hoặc chuyển file JSON. Nếu SERVER chưa sẵn sàng, bấm **Kết nối lại**. Tên SERVER cần phân giải được và cổng TCP 3008 phải cho phép trong mạng nội bộ. Khi dùng địa chỉ LAN khác, đặt `METLIFE_SERVER_URL=http://<IP-SERVER>:3008` trước khi mở app. Không tự mở truy cập ẩn danh qua tunnel Internet.
2. Nhập tên, Patient ID/PatNum, Chart Number, Subscriber ID hoặc Group Number; có thể chọn loại tìm hoặc tìm tất cả. Group/Subscriber ID có thể trả nhiều bệnh nhân: xem Patient ID, ngày sinh và bảo hiểm rồi chọn đúng người.
3. Nhấn **Xem hồ sơ**: app lấy danh sách PDF trong FINISHED CLAM/FINISHED CLAIMS của chính PatNum đó. Chọn PDF để xem và đối chiếu. File và dữ liệu OD được lấy từ SERVER; không cần chọn thư mục UNC hay nạp JSON.
4. Bảng đối chiếu hiển thị Patient ID, tên/ngày sinh OD, PlanNum/InsSubNum, claim/group/trace/ngày, Payment Type, Note, từng ProcNum/code/ngày/răng/provider/clinic và số tiền phân bổ. **Đã đối chiếu · Lưu vào OD** gửi request đến SERVER; không mở Payment, không OCR, không click OD. App hoạt động trên macOS/Windows qua cùng Bridge. Trên OD refresh Account để xem kết quả; chưa kiểm chứng tự refresh trên R5.

5. Khi mất kết nối hoặc readback không khớp, giữ lượt ghi trên SERVER và local, không tự nhập lại. Dùng **Kiểm tra kết quả trên SERVER** để xác minh. Khi mở hồ sơ, app tự lấy lại lượt ghi còn chờ ngay cả khi mất local journal.
6. Draft tạo bằng phiên bản cũ phải hoàn tất/hủy trên OD trước khi lưu bằng đường mới. Driver giao diện OD cũ chỉ giữ trong source cho kỹ thuật viên; không có nút chẩn đoán trong bản khách hàng.

Tab PDF & đối chiếu hỗ trợ xem thêm PDF local; để lưu cần chọn tài liệu từ hồ sơ bệnh nhân. Snapshot/JSON và công cụ chẩn đoán không hiển thị trong bản khách hàng.

## Phạm vi dữ liệu và kiểm tra

SERVER xác định tài liệu qua DocNum + PatNum + category, không suy bệnh nhân chỉ từ tên file hoặc Group Number. Đọc filesystem theo AtoZfolder/ImageFolder, xác minh file nằm trong root và là PDF tối đa 30 MB đã ổn định. Chưa hỗ trợ ImageStore database/cloud.

Context đọc patient/subscriber/plan/procedure/claim/claimproc/payment/paysplit trong READ ONLY transaction, giữ nguyên ngày dạng string và ID lớn. Đường đọc vẫn không thay đổi dữ liệu; đường ghi SQL thử nghiệm tách riêng và tắt mặc định như mô tả ở trên. Endpoint MetLife dùng bearer token riêng, không dùng token quản trị Bridge chung; R5 không nhận mật khẩu MySQL.

PDF.js hỗ trợ mẫu MetLife Claim Summary có text layer đã kiểm tra. PDF scan/mẫu khác/nhiều claim/thiếu Payment Detail hoặc tổng tiền lệch bị chặn. Tổng tiền dùng integer cents; claim number giữ cả hậu tố trong metadata. App giữ PDF/context trong RAM và lưu cấu hình, kết nối mã hóa, audit hash/loại thao tác. SERVER lưu journal chứa context trước ghi và kế hoạch đối chiếu trong thư mục riêng `METLIFE_JOB_DIR`; thư mục này chứa thông tin hồ sơ, cần quyền truy cập chỉ dành cho dịch vụ/quản trị phòng khám, không đặt trong thư mục web công khai. Xuất đối chiếu chứa dữ liệu hồ sơ do người dùng chọn nơi lưu.

## Đã kiểm tra và chưa xác minh

- Kiểm thử app/core với PDF mẫu local: parser, tiền/ngày, trùng giao dịch, định danh tài liệu, kết nối và cách ly tài liệu cùng tên.
- Kiểm thử API: mọi loại tìm kiếm, nhiều bệnh nhân chung group, token riêng, category + PatNum + DocNum, đường dẫn ngoài root, read-only transaction và cleanup lỗi.
- Electron UI trên macOS với SERVER giả lập: kết nối một lần, tìm group có 2 bệnh nhân, chọn đúng FINISHED CLAM, chọn PDF, tự lấy context, chặn khoản trùng và render 2 trang. Không dùng test này để khẳng định SERVER thực đã cài.
- Bộ cài thử trên thư mục Bridge giả lập: backup, token, file kết nối và chạy lại không nhân đôi route.
- Kiểm thử posting coordinator: khóa bền qua restart, duplicate, đúng/sai type/provider/procedure/amount, readback mới, drift trước Save, hash thay đổi và phục hồi lượt pending.
- Kiểm thử Electron Save mới với SERVER giả lập: prepare/post/verify, không gọi Windows adapter, readback chưa xác minh giữ journal/chặn retry. Không ghi tiền hay chạy OD thật trong test này.
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

OD UI.ListBox xử lý Up/Down, không triển khai Home/PageDown như list chuẩn. Bộ chọn cũ có thể dừng ngay khi viewport lặp sau Home, trước khi thực sự duyệt mục phía dưới. Bộ chọn mới dùng Up/Down theo cả hai hướng, nhận diện hàng OCR và đọc lại mục được tô chọn. Fingerprint ảnh tính cả vùng tô chọn, không dừng chỉ vì các dòng đang nhìn thấy chưa đổi. OCR làm rõ nền và phóng chữ, ánh xạ kết quả về đúng tọa độ màn hình. Khi xác minh mục được chọn, chỉ OCR dải tô sáng để tránh OCR toàn danh sách bỏ sót dòng đó. Không đổi sang loại tiền khác khi thiếu mục hoặc không đọc lại được.

Windows fixture bổ sung control tự vẽ không có UIA ListItem, bỏ qua Home/PageDown. Kiểm tra bằng OCR Windows thật: chọn Insurance Paid nằm ngoài viewport, tìm ngược lên Credit Card và từ chối nhãn không tồn tại. Vẫn cần nghiệm thu danh sách thực tại R5.

Nguồn control OD: https://github.com/OpenDental/opendental/blob/24_3/OpenDental/UI/ListBox.cs

## Bản 0.3.7 — chọn dịch vụ trước Payment

Luồng được sửa theo demo: chọn đúng bệnh nhân → Account → chọn các procedure đã đối chiếu PDF (Ctrl để chọn nhiều dòng không liền nhau) → Payment → nhập Amount từ PDF → điền ngày/trace/Note/Insurance Paid → kiểm tra Splits OD tự tạo → dừng bản nháp hoặc Save có recheck/readback. Không còn Delete All/Add Split/Attach Procedure để dựng lại phân bổ. Bộ kiểm tra Split chỉ mở xem và đóng chi tiết, không sửa Split.

Chỉ chọn khi mọi procedure mục tiêu đang hiện trong Account và khớp duy nhất theo patient/ngày/mã/răng/provider; không tự cuộn chọn các dòng chưa thấy hoặc chọn cả dải bằng Shift. Một click đầu bỏ lựa chọn cũ; Ctrl-click các dòng còn lại, thả Ctrl trong finally. Đọc lại OCR và vùng highlight để kiểm tra tập dòng trước Payment. Thiếu/nhầm/không đọc được thì dừng và chụp chẩn đoán. Các procedure benefit > 0 trong kế hoạch đối chiếu là mục tiêu; không tự chọn dòng denied/0 USD hoặc tạo procedure gộp mới.

OD có thể tự phân bổ khác số tiền từng dòng trên EOB, hoặc tạo Prepayment nếu Amount lớn hơn phần còn lại. Tool dừng khi kết quả đó không khớp kế hoạch PDF, không sửa để ép khớp. Việc mở bản nháp có thể tác động DB theo phiên bản OD; khóa/recheck/readback hiện có vẫn áp dụng. Chưa nghiệm thu luồng mới trên R5 thật.

Kiểm thử Windows bổ sung Account grid tự vẽ, có dòng cùng code khác răng và bệnh nhân khác, cùng lựa chọn thừa từ trước. Kiểm tra OCR + Ctrl-click thực giữ đúng hai dòng không liền nhau và bỏ lựa chọn cũ.

Kiểm chứng bản 0.3.7: Windows CI run 38755961349 đã pass cả fixture WinForms x86/x64, gồm OCR và Ctrl-click thật trên grid tự vẽ để chọn các dòng liền/không liền nhau và bỏ lựa chọn cũ. 20 test app và policy .NET bổ sung các ca thiếu/trùng dòng, khác răng/bệnh nhân, Prepayment và phân bổ sai đã pass. Đây chưa phải nghiệm thu trên OD thật. Nhận diện tiền tố OCR 0xxxx → Dxxxx chỉ áp dụng ở cột CDT Code đã xác định; giữ rawCode để chẩn đoán và vẫn yêu cầu khớp duy nhất các trường còn lại.

## Bản 0.3.8 — giữ màn hình draft khi dừng

Bỏ toàn bộ tự đóng popup/Payment trong error handler. Fill draft thành công giữ Payment mở trước Save như trước; nếu lỗi thì giữ nguyên popup và các giá trị tại bước bị lỗi để người dùng kiểm tra. Thông báo nói rõ tool dừng, chưa tự đóng/Save. Người dùng chủ động đóng popup trong OD nếu lỗi xảy ra giữa luồng; nút Đóng bản nháp của app vẫn đóng Payment đã quản lý và xác minh đúng identity khi được bấm. Luồng kiểm tra chi tiết Split vẫn mở rồi quay lại Payment để hoàn tất xác minh, không đóng Payment cuối luồng.

## Bản 0.3.9 — phân bổ trong Outstanding Charges theo demo mới

Thay thế luồng 0.3.7: không bôi chọn các dòng trong Account trước Payment. Sau khi nhập thông tin Payment, dùng combo `comboPatientOutstandingFilter` để chọn đúng FName của bệnh nhân PDF. Combo tự vẽ OD mở `FormComboPicker` riêng; tool đọc danh sách lựa chọn, yêu cầu tên khớp duy nhất rồi đọc lại caption sau khi chọn. Tên dùng preferred hoặc bị cắt không khớp thì dừng, không chọn gần đúng. Các dòng Outstanding vẫn phải khớp tên đầy đủ, ngày, code, răng và provider trong kế hoạch đã đối chiếu SERVER.

Đưa patient/provider filter của Splits về All để không giữ sót dòng ẩn; Group By None để mỗi prompt ứng với một procedure; Nếu thiếu dịch vụ, thử đổi Show All Charges một lần rồi yêu cầu khớp đầy đủ các dòng; checkbox OD tự vẽ không bắt buộc có TogglePattern. Không đoán trạng thái checkbox hoặc chọn dòng chưa nhận diện được. Delete All chỉ áp dụng Payment mới do tool vừa mở, không đụng Payment cũ. Đọc lại Split Total bằng 0, chọn chính xác các dòng benefit dương (Ctrl-click các dòng không liền nhau), xác minh highlight không thừa/thiếu rồi bấm Add Partials. OD hỏi số tiền theo thứ tự hiển thị: tool kiểm tra mã trên từng FormAmountEdit, nhập đúng benefit của procedure đó; không lấy AmtOrig/AmtEnd làm số tiền PDF. Cuối cùng kiểm tra tổng bằng Amount và giữ bộ kiểm tra chi tiết Splits hiện có.

Theo lựa chọn của người dùng, **Overpaid Charge Warning dừng ngay để người dùng tự kiểm tra và bấm**; tool không xác nhận popup này. Khi đã dừng, các bước còn lại của Add Partials cần xử lý thủ công trong OD; không bấm Auto fill lại trên Payment đang mở. Fill draft không Save và không tự đóng Payment. Luồng Auto fill & Save hiện có vẫn chỉ Save sau khi tất cả kiểm tra thành công.

Kiểm thử bổ sung Windows WinForms x86/x64: combo family tự vẽ mở cửa sổ riêng; khôi phục các bộ lọc; xóa Splits cũ; OCR và Ctrl-click Outstanding có mã trùng khác răng/bệnh nhân; prompt Add Partials theo thứ tự grid khác thứ tự PDF; nhập từng amount và kiểm tra tổng; không gọi Save; dừng và giữ nguyên Overpaid Charge Warning. Đây là fixture, chưa phải nghiệm thu trên Open Dental thật tại R5.

Kiểm chứng 0.3.9: [Windows CI 38762303435](https://github.com/huypv2002/OpenDental/actions/runs/38762303435) pass cả x86/x64, gồm Add Partials, tổng tiền và dừng trước cảnh báo số dư âm; 20 app tests pass trên mỗi job. Bộ policy PowerShell và kiểm tra cú pháp cũng pass tại máy phát triển. CI dùng dữ liệu tổng hợp, không tạo thanh toán trên database phòng khám.

## Bản 0.3.10 — đọc lại dòng Insurance Paid trên R5

Sửa lỗi `Selection highlight has multiple bands` dừng ngay sau chọn Payment Type. Bộ đọc cũ yêu cầu mọi hàng pixel nhận diện nền tô chọn phải liền nhau tuyệt đối: chữ đen làm gián đoạn nền, còn viền xám mỏng cũng bị nhận nhầm. Bộ đọc mới dùng chung bộ nhóm vùng highlight: gộp khoảng trống nhỏ trong cùng một dòng, bỏ các dải viền quá mỏng, yêu cầu chỉ một vùng đủ dày rồi OCR đúng một dòng. Vẫn từ chối hai vùng chọn thực sự tách biệt hoặc OCR cho nhiều dòng.

Bài regression dùng crop danh sách Payment Type từ ảnh R5 người dùng gửi, chỉ có nhãn các loại tiền, không có thông tin bệnh nhân. Kiểm tra cả vị trí vùng chọn và OCR Insurance Paid qua control hiển thị ảnh trên Windows; thêm ca hai vùng chọn tách biệt. Khi dừng, lỗi có tên bước để phân biệt Payment Type, chọn combo, Delete All, Outstanding và Add Partials. Cập nhật mô tả luồng trên giao diện và thông báo thành công để phản ánh đúng việc phân bổ Splits. Không thay đổi lựa chọn dừng tại cảnh báo số dư âm hoặc giữ Payment mở.

Kiểm chứng 0.3.10: [Windows CI 38772797451](https://github.com/huypv2002/OpenDental/actions/runs/38772797451) pass x86/x64. Cả hai job đọc đúng `Insurance paid` từ crop R5, từ chối hai vùng chọn tách biệt, rồi pass lại luồng family filter → Delete All → Outstanding → Add Partials và giữ cảnh báo số dư âm. 20 app tests mỗi job và kiểm tra cú pháp/policy tại máy phát triển đều pass. Đây là regression ảnh thật và fixture Windows; chưa chạy lại luồng mới trên OD thật tại R5.

## Bản 0.3.11 — nhận diện cột răng Outstanding Charges

Sửa lỗi dừng `Cannot identify Account tooth column` sau khi lọc đúng patient và xóa Splits. Outstanding Charges dùng bộ đọc riêng: nhận diện các đường chia cột trên ảnh header, xác minh thứ tự Date/Patient/Prov/Code/Type và chỉ chấp nhận đúng một ô răng nằm giữa Code và Type. Không yêu cầu Windows OCR đọc được nhãn Th/Tth nhỏ; không suy số răng từ mô tả Type. Các giá trị răng vẫn được đọc trong đúng ô và so sánh chính xác với kế hoạch PDF/SERVER. Không thấy các đường chia hoặc bố cục khác thì dừng, không click theo tọa độ cố định.

Regression dùng ảnh header R5 chỉ có tên cột chung, không có dòng bệnh nhân: kiểm tra OCR các cột dùng làm mốc và các đường chia thật. Fixture Outstanding cố ý bỏ hẳn chữ ở tiêu đề cột răng, vẫn phải đọc đúng các dòng cùng code khác răng và chạy Add Partials theo đúng tiền từng procedure; bộ policy từ chối khi thiếu đường chia cột răng. Giữ nguyên hành vi dừng để người dùng kiểm tra cảnh báo số dư âm, không tự đóng hoặc Save Payment.

Kiểm chứng 0.3.11: [Windows CI 38783432967](https://github.com/huypv2002/OpenDental/actions/runs/38783432967) pass x86/x64, gồm ảnh header R5, grid cố ý thiếu nhãn răng, chọn đúng procedure/răng và Add Partials. 20 app tests mỗi job và policy/cú pháp tại máy phát triển đều pass. Chưa nghiệm thu lại trên Open Dental thật tại R5.

## Bản 0.3.12 — cột tương đối và chẩn đoán geometry

Bỏ giả định Date phải là ô số 0 của các đường chia được phát hiện. Viền ngoài nằm trong bounding rectangle UIA có thể được nhận thành một ô hẹp phía trước Date. Bộ đọc dùng các cột mốc liên tiếp Date → Patient → Prov → Code, rồi yêu cầu chính xác một ô răng giữa Code và Type; vị trí click Code cũng dùng chỉ số đã xác minh. Không bỏ điều kiện kiểm tra răng hoặc chấp nhận một cột răng thiếu đường chia.

Fixture thêm viền ngoài tại x=3 để làm lệch chỉ số, vẫn phải chọn đúng hai răng khác nhau và chạy Add Partials; policy có cả trường hợp viền ngoài và thiếu đường chia bên trong. Khi geometry vẫn không khớp, lỗi ghi header/edges/cells và lưu riêng `outstanding-columns.json` trong thư mục chẩn đoán hiện có. File chỉ chứa tiêu đề và tọa độ cột, không chứa các dòng bệnh nhân. Điều này giúp phân biệt thêm viền ngoài, mất đường chia hoặc OCR khác thay vì tiếp tục suy từ thông báo chung. Ảnh thông báo R5 trước đó chưa đủ chứng minh nguyên nhân thực tế là viền ngoài; cần chạy lại hoặc xem dữ liệu chẩn đoán để xác nhận.

Kiểm chứng 0.3.12: [Windows CI 38788379422](https://github.com/huypv2002/OpenDental/actions/runs/38788379422) pass x86/x64, gồm viền ngoài trong grid và Add Partials; 20 app tests mỗi job và policy tại máy phát triển pass. Chưa xác nhận lỗi geometry thực tế trên R5 đã hết.

## Bản 0.3.13 — luôn bật Show All Charges; xử lý log R5 thiếu đường chia

Show All Charges là điều kiện bắt buộc sau Delete All, trước mọi lần đọc/chọn Outstanding Charges. Dùng TogglePattern nếu có; với checkbox OD tự vẽ, xác định ô vuông và trạng thái dấu tích qua ảnh control. Chưa tích thì click đúng một lần và đọc lại On; đã tích thì không click; không nhận diện chắc chắn thì dừng, không toggle mù. Bỏ cách bật/tắt khi dò thấy thiếu procedure. Regression có ảnh ô vuông tích/chưa tích từ R5 (không chứa dữ liệu bệnh nhân), kiểm tra gọi lặp không bỏ tích và trạng thái ảnh lạ phải bị từ chối.

Log thực tế R5 cho biết chỉ phát hiện edges [905,1503] trong khi OCR đã đọc đầy đủ Date/Patient/Prov/Code/Tth/Type. Nếu không có đủ đường chia, bộ đọc mới chỉ dùng cách dựa trên OCR khi đủ các tiêu đề duy nhất, đúng thứ tự và không chồng lấn; đọc răng trong vùng cột đã xác minh, rồi vẫn kiểm tra toàn bộ danh tính từng procedure. Không suy đoán hoặc tự bổ sung chữ Tth nếu thiếu. Khi cả hai cách không đạt, lưu dữ liệu chẩn đoán và dừng. Policy tái hiện đúng tọa độ header từ log với các dòng giả lập cùng code khác răng để kiểm tra chọn đúng.

Kiểm chứng 0.3.13: [Windows CI 38798757742](https://github.com/huypv2002/OpenDental/actions/runs/38798757742) pass x86/x64, 20 app tests mỗi job. Runtime kiểm tra ảnh checkbox R5 tích/chưa tích, idempotence (không bấm lại khi On), trạng thái lạ bị từ chối, luồng grid thiếu đường chia dùng OCR anchors và Add Partials, giữ nguyên cảnh báo số dư âm. Policy với chính tọa độ header từ log R5 đã pass tại máy phát triển. Chưa chạy lại bản này trên OD thật tại R5.

## Bản 0.3.14 — tiêu đề Tth bị OCR ghép với vạch kẻ

Log R5 mới đọc `ITthl` thay vì `Tth`: vạch dọc ở hai mép ô bị ghép vào cùng token. Bộ đọc chỉ chuẩn hóa nhãn header khi token chứa nguyên nhãn Tth/Th/Tooth với tối đa hai ký tự vạch I/l/| mỗi bên, nằm hoàn toàn trong khoảng giữa các nhãn Code và Type đã xác minh, và chỉ có một ứng viên. Giữ nguyên tọa độ token và raw caption trong chẩn đoán. Không chuẩn hóa số răng, tên bệnh nhân hoặc dữ liệu procedure.

Policy tái hiện đúng tọa độ/chiều rộng `ITthl` trong log và edges chỉ có hai mép ngoài; vẫn phải chọn đúng răng trong hai dòng cùng code. Ca tiêu đề sai, trùng hoặc nằm ngoài vị trí bị từ chối. Fixture Windows bỏ đường chia và vẽ nhãn ITthl để kiểm tra tiếp luồng chọn các dòng rồi Add Partials. Show All Charges vẫn bắt buộc On; cảnh báo số dư âm vẫn dừng và Payment không tự đóng/Save.

Kiểm chứng 0.3.14: [Windows CI 38897129212](https://github.com/huypv2002/OpenDental/actions/runs/38897129212) pass cả x86/x64, 20 app tests mỗi job, fixture ITthl thiếu đường chia chạy qua chọn dòng và Add Partials, giữ nguyên cảnh báo số dư âm. Policy dùng đúng header/tọa độ mới từ log R5 và các ca từ chối đã pass. Chưa chạy lại trên OD thật tại R5.

## Bản 0.3.15 — lấy dữ liệu dòng thực tế, chưa khẳng định sửa lỗi D0120

Thông báo missing/ambiguous trước đây không ghi ô nào lệch. Driver mới lưu `outstanding-read.json` khi lỗi, gồm OCR thô, từng word và tọa độ, các dòng đã tách, danh tính kỳ vọng và kết quả so sánh từng trường code/date/patient/provider/tooth. Đây là dữ liệu hồ sơ cục bộ; không tự gửi lên mạng.

Để lấy dữ liệu ngay tại Payment đang dừng, giữ cửa sổ Payment mở, không Save và không chạy Fill lại. Từ thư mục repo:

```bat
npm --prefix metlife-electron run diagnose:outstanding
```

Lệnh đưa Payment lên trước để đọc rồi xuất JSON vào thư mục LUK-MetLife-diagnostics dưới TEMP, in đường dẫn đầy đủ ra console. Nó không bấm checkbox, không đổi filter, không chọn dòng, không xóa Splits, không Add Partials, không Save/Close. File gồm version/time, trạng thái checkbox, Amount/Split Total, raw/parsed rows và lỗi parse nếu có. Cần dữ liệu thật này để xác định D0120 đang sai ở trường nào; bản này không thay đổi điều kiện khớp hoặc sửa parser theo phỏng đoán.

Kiểm chứng chẩn đoán: [Windows CI 38899484849](https://github.com/huypv2002/OpenDental/actions/runs/38899484849) pass x86/x64. Gọi chính CLI Node → PowerShell trên Payment fixture đang mở, kiểm tra raw/parsed rows được xuất và Amount/Splits/checkbox/số lần Save không thay đổi. 20 app tests mỗi job và policy/cú pháp tại máy phát triển pass. Chưa có OCR dòng D0120 thực tế từ R5 để chốt nguyên nhân hoặc khẳng định đã sửa lỗi khớp procedure.

## Bản 0.3.16 — đọc bảng nhỏ theo capture R5 và kiểm tra tới cuối draft

Capture `gridCharges` trên R5 rộng 598 px, chữ khoảng 10 px; bài kiểm tra cũ dùng bảng 970 px/chữ lớn nên chưa đủ đại diện. Vùng lấy đường kẻ nay nằm trong hàng tiêu đề, tránh phần đệm làm mất đường kẻ. Khi OCR cả bảng ghép chữ tiêu đề, adapter đọc lại riêng header bằng ảnh màu trước; khi định danh dòng chưa khớp, đọc riêng Date/Patient/Prov/Code/Tooth theo đường kẻ vật lý đã xác minh. Vẫn yêu cầu đúng và duy nhất code/ngày/bệnh nhân/provider/răng, không tự bỏ điều kiện để chọn dòng.

Đọc lại Current Payment Splits xử lý trường hợp Windows OCR nhận `D0120` thành `00120` chỉ trong cột Code được xác định, rồi mở từng split để kiểm tra chi tiết. Bộ kiểm tra Windows bao gồm bảng 598 px với header thật đã có trong capture, dữ liệu bệnh nhân giả, cùng luồng chọn patient → Delete All → Show All Charges → chọn dòng → Add Partials → tổng tiền → chi tiết splits → Payment vẫn mở, không Save. Cảnh báo Outstanding âm vẫn dừng để người dùng tự kiểm tra. Đây là kiểm thử Windows với fixture dựa trên capture, chưa phải xác minh chạy trên R5 của phòng khám.

## Bản 0.3.17 — sửa theo outstanding-read.json thực tế trên R5

Trong log R5, OCR cả bảng đọc đúng cả 8 code/ngày/provider/răng nhưng đọc dấu phẩy ngăn họ/tên thành dấu chấm. Cho phép dấu chấm thay cho đúng dấu phẩy phân cách họ/tên; mọi chữ, tên đệm và răng/provider/ngày/code vẫn phải khớp, không chấp nhận mất họ hoặc khác tên.

Lượt OCR tách cột còn làm hỏng 6 ngày và không đọc được đầy đủ tên, khiến fallback bỏ mất dòng D0120. Fallback nay giữ vị trí/dữ liệu các ô đã đọc đúng trong lượt cả bảng, đối chiếu thêm từng ô ở đúng dòng vật lý. Fixture replay đã đổi tên bệnh nhân, giữ hình dạng lỗi/vị trí OCR của capture thực, kiểm tra 8 dòng/4 splits $439.20, fallback khi ngày tách cột hỏng, và từ chối bệnh nhân khác. Capture/ảnh hồ sơ gốc không được đưa vào Git. Draft vẫn mở và cảnh báo âm vẫn để người dùng kiểm tra.

## Bản 0.3.18 — xác nhận Overpaid Charge Warning rồi tiếp tục Add Partials

Sau mỗi lần nhập amount, tool nhận diện đúng popup `Overpaid Charge Warning` trong cùng tiến trình OD, kiểm tra nguyên nội dung `One or more Outstanding Charges will be negative. Continue?` và hai nút OK/Cancel, bấm OK một lần rồi đợi đúng Amount của dòng tiếp theo hoặc Payment sau dòng cuối. Cảnh báo này có thể xuất hiện ở từng dòng; tool tiếp tục nhập toàn bộ số tiền theo PDF và kiểm tra tổng/chi tiết splits. Popup khác hoặc cùng tiêu đề nhưng khác nội dung vẫn được giữ để kiểm tra.

Fill draft vẫn không Save hoặc đóng Payment. Khi cập nhật từ bản cũ đã dừng ở popup, lượt chạy cũ đã kết thúc; việc pull/restart source không nối tiếp lượt cũ. Hoàn tất hoặc hủy draft đang mở trước khi bắt đầu lại từ app.

## Bản 0.3.19 — tự chọn bệnh nhân và mở Account trước Payment

Fill draft mở Account trước khi tìm bệnh nhân. Khi cần đổi bệnh nhân, tool xóa bộ lọc cũ, tìm theo PatNum đã đối chiếu, bấm Search, chọn đúng dòng PatNum rồi tự bấm OK và xác minh PatNum trên tiêu đề OD. Bảng tìm kiếm tự vẽ không có UIA Text vẫn được đọc bằng OCR đúng cột PatNum; không chọn ID xuất hiện ở cột tên/điện thoại hoặc một phần của ID khác.

Sau khi chọn bệnh nhân, tool luôn bấm Account lần nữa và chờ đúng ControlAccount/gridAccount/thanh Payment hiển thị trước khi mở Payment. Không chỉ dựa vào IsOffscreen của ControlAccount, vì module có thể còn nằm trong cây UIA khi đang ở Chart/Family. Kiểm thử Windows dựng ca bắt đầu ở Chart, chọn bệnh nhân qua bảng tự vẽ rồi lại ở Chart, và ca đã đúng bệnh nhân nhưng ở Chart; cả hai phải hoàn tất bước chuẩn bị bằng một lần gọi, không cần bấm Account hoặc Fill draft lần hai.

Giao diện khách hàng 0.4.0 chỉ có tìm bệnh nhân, tài liệu, đối chiếu, lưu/xác minh, hướng dẫn và lịch sử thao tác. Không hiển thị URL/DB/schema, snapshot/JSON, ID nội bộ procedure/plan, OCR/driver hoặc nhật ký kỹ thuật. Dùng CLI `npm run metlife:inspect` trên SERVER cho chẩn đoán kỹ thuật.

## Bổ sung tương thích OD 24.3 / MyISAM

Dựa trên metadata SERVER: ProgramVersion 24.3.61.0, DataBaseVersion 24.3.53.0; các bảng OD dùng MyISAM. Không đổi engine bảng OD. Schema bổ sung `payment.ExternalId` (rỗng), `payment.PaymentStatus` (`None` = 0), `paysplit.SecurityHash` (tạo bằng hàm `OpenDentBusiness.PaySplits.HashFields` của bản OD đã cài trên SERVER).

Nguồn đối chiếu là nhánh chính thức `OpenDental/opendental` `24_3`, commit `d804c19546233593d8a66af0591ed118a9e2c794` (24.3.63, không có commit công khai đúng 24.3.61). Không dùng thuật toán hash của phiên bản gần đó để giả định tương thích: helper gọi chính DLL cài trên SERVER. Chưa kiểm chứng DLL/CDT thật của phòng khám; CI chỉ kiểm tra binding với DLL tổng hợp. Không tự xây hash thay thế hoặc chấp nhận chuỗi exception/rỗng; không sửa hash của dữ liệu cũ.

Helper tự tìm `OpenDentBusiness.dll` trong các thư mục cài Open Dental chuẩn. Nếu OD cài riêng, kỹ thuật viên có thể đặt `METLIFE_OD_INSTALL_DIR` trỏ đúng thư mục cài OD trên SERVER. Không chuyển DLL/mật khẩu DB sang R5. Helper chỉ nhận giá trị Split mới qua stdin, tạo hash, trả kết quả; không kết nối DB hoặc thao tác UI. Nếu thiếu DLL/CDT hoặc helper lỗi, dừng trước ghi lâm sàng.

MyISAM không có rollback. Writer khóa bảng OD liên quan trong khoảng ghi/đọc lại, ghi trước toàn bộ kế hoạch và ID mới vào `luk_metlife_myisam_jobs` (InnoDB), rồi mới INSERT Payment/Splits. Tạo hash trước khi khóa bảng để không giữ khóa trong lúc khởi động helper. Mọi cột bắt buộc được kiểm tra trước INSERT đầu tiên. Khi ghi đủ và đọc lại khớp (kể cả ID và hash), nhật ký chuyển complete. Mất phản hồi sau khi ghi đủ có thể xác minh từ ý định và dữ liệu thật. Nếu ngắt giữa các INSERT, có thể còn Payment/Splits chưa đủ: giữ khóa bệnh nhân, không rollback giả, không tự xóa hoặc tự ghi tiếp; kỹ thuật viên phải kiểm tra và xử lý trường hợp cụ thể. Khóa bảng có thể chặn thao tác OD khác trong khoảng ngắn khi ghi.

Trên SERVER cập nhật rồi chạy `npm run metlife:inspect`. Báo cáo kiểm tra thêm việc thư viện OD có tạo được hash cho giá trị tổng hợp hay không, không xuất hash này ra báo cáo và không tạo hồ sơ. Bản khách hàng không hiện thông tin kỹ thuật. R5/EXE hiện có dùng cùng request; thay đổi này nằm ở backend SERVER.
