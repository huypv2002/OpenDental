# LUK MetLife Assistant 0.3.12

Electron/JavaScript, cùng style LUK Dental SMS Electron. Luồng chính: **Tìm bệnh nhân → FINISHED CLAM → Chọn PDF → đối chiếu → Auto fill**. Không cần Python hoặc chuyển snapshot hằng ngày.

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
4. **Auto fill · bản nháp OD** tự chọn bệnh nhân bằng PatNum, mở Account rồi Payment, nhập Amount từ PDF, ngày/trace/Note và **Insurance Paid**. Trong Payment: chọn đúng patient ở Filtering bên phải; đưa bộ lọc Splits bên trái về All; Group By None; **Delete All** Splits của bản nháp vừa mở; đổi Show All Charges nếu cần để hiện đủ dịch vụ; chọn các dịch vụ khớp PDF trong **Outstanding Charges**; **Add Partials** và nhập tiền benefit từng dòng. Kiểm tra tổng Splits và từng dịch vụ trước khi dừng ở Payment để người dùng kiểm tra. Gặp cảnh báo số dư âm thì giữ nguyên popup, không tự bấm OK hay đóng.
5. **Auto fill & Save vào OD**: SERVER đọc dữ liệu/file mới, khóa lượt ghi cho bệnh nhân; app tạo bản nháp hoàn chỉnh; SERVER kiểm tra lại ngay trước Save; app mở kiểm tra từng Split, bấm Save trong OD; SERVER đọc lại Payment và Splits để đối chiếu tất cả trường. Chỉ báo thành công khi readback đạt. Không gọi nút thu tiền thẻ/merchant.
6. Nếu timeout, crash hoặc readback không khớp: giữ lượt ghi trên SERVER và local, không tự nhập lại. Dùng **Kiểm tra kết quả trên SERVER** để xác minh; nếu vẫn không khớp phải kiểm tra giao dịch cụ thể. Lỗi trước Save chỉ giải phóng khóa khi dữ liệu tài chính không thay đổi. Khi mở hồ sơ, app tự lấy lại lượt ghi còn chờ từ SERVER ngay cả khi local journal mất.
7. Bản nháp có thể đóng bằng nút tool. OD/R5 cần đang đăng nhập, desktop mở khóa và cùng mức quyền với tool. Owner-drawn controls dùng Windows OCR tiếng Anh và nhận diện vùng chọn; thiếu OCR/control lạ sẽ dừng và tự chụp ảnh/control OD trong `od-diagnostics` dưới userData của app. Ảnh có thể chứa dữ liệu bệnh nhân, chỉ lưu trên máy và không được đóng gói vào bản phát hành.

**Luồng mới 0.3.9 đã qua fixture Windows x86/x64; chưa được nghiệm thu trên OD thật tại R5.** Nên chạy luồng ghi trên bản sao database/môi trường thử trước khi sử dụng cho dữ liệu thật. Nếu OD tạo draft DB records ngay khi mở Payment, kiểm tra dữ liệu trước Save sẽ phát hiện và dừng thay vì tự bỏ qua; cần bằng chứng thực tế của phiên bản đó để xử lý tiếp.

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
