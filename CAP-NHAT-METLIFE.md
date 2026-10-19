# MetLife 0.7.0 — Hệ thống tự động 100% trên SERVER & R5 Audit Dashboard

Repo: https://github.com/huypv2002/OpenDental — nhánh `main`.

## Tổng quan kiến trúc mới (100% Tự động hóa)

1. **SERVER Tự động giám sát & Xử lý (Auto-Pilot):**
   - Thư mục giám sát: `D:\SHARE\INSURANCE CLAIM\METLIFE` (tùy chỉnh qua `.env: METLIFE_INCOMING_DIR`).
   - Server Bridge tự động quét định kỳ (mỗi 30s) hoặc khi nhận lệnh quét tức thì.
   - Khi có file PDF (ví dụ `1307.pdf` hoặc theo tên bệnh nhân):
     - Đọc và bóc tách dữ liệu EOB MetLife (`feeCents`, `benefitCents`, `CheckNum`, `GroupNum`, thủ thuật...).
     - Tự động import PDF vào **Finished Claims** trong Open Dental (sao chép vào thư mục AtoZ ảnh của bệnh nhân và tạo bản ghi bảng `document`).
     - **Tự động bù phí 0.00 (`ProcFee`):** Nếu các thủ thuật hoàn thành trên OD bị để phí $0.00 (dẫn đến số dư Balance âm sau khi trừ tiền bảo hiểm), Server tự động cập nhật `procedurelog.ProcFee` và `claimproc.FeeBilled` theo mức phí gửi trong EOB, đảm bảo số dư tài khoản bệnh nhân luôn chính xác 100%.
     - Tự động ghi nhận thanh toán (`payment`, `paysplit` với `SecurityHash` in-memory chuẩn xác, `securitylog`, `securityloghash`), chuyển Claim sang trạng thái Received (`ClaimStatus = 'R'`).
     - Tự động lưu trữ file đã xử lý vào thư mục `PROCESSED/`.
     - Lưu toàn bộ vết kiểm toán vào bảng MariaDB `luk_metlife_history`.

2. **Client R5 — Audit & Activity Dashboard:**
   - Không còn phải nhập bệnh nhân, chọn file thủ công hay bấm "Lưu vào Open Dental" bằng tay.
   - Trở thành **Bảng điều khiển & Giám sát hoạt động**:
     - Hiển thị trực quan danh sách các EOB mà Server đã tự động xử lý.
     - Kiểm tra chi tiết side-by-side: Số tiền thanh toán ($439.20), mã PayNum, các thủ thuật được bù phí, tài liệu Finished Claims đã nhập.
     - Có nút **"⚡ Quét thư mục Server ngay"** để kích hoạt quét ngay lập tức khi vừa thả file PDF mới vào thư mục.

```bat
git pull --ff-only origin main
od-bridge.bat
```

Từ lần sau chỉ chạy `od-bridge.bat` (hoặc `start-bridge-and-tunnel.bat`). Có thể tạo shortcut tới file này trên Desktop. Launcher tự pull nhánh main, cài dependency theo lockfile, tạo cấu hình MetLife nếu thiếu, restart API đang nghe trên cổng Bridge và kiểm tra `/health`. Giữ tunnel `od-bridge` đang chạy; chỉ mở tunnel nếu chưa thấy process tương ứng. Không dừng những process Node/SMS khác. `.env` và journal được giữ nguyên, không dùng git reset. Nếu source tracked có sửa local hoặc pull lỗi thì dừng trước bước restart và hiện lỗi để xử lý.

Launcher dành cho Bridge đang chạy bằng Node/BAT. Nếu đang chạy bằng Windows service/scheduled supervisor, phải dùng đúng cơ chế restart của supervisor để tránh nó tự mở lại process cũ.

MetLife dùng cùng process, DB pool và URL `https://od-bridge.lukdental.us/api/metlife`. SERVER không chạy thêm app MetLife riêng. Electron 0.3.2 tự kết nối `http://SERVER:3008` trong mạng phòng khám khi mở: không đăng nhập và không chuyển JSON. Có nút Kết nối lại. SERVER phải phân giải được tên máy và cho phép R5 truy cập TCP 3008 trên mạng nội bộ. Có thể đặt biến môi trường `METLIFE_SERVER_URL=http://<IP-LAN-SERVER>:3008` khi cần địa chỉ riêng; chỉ nhận địa chỉ LAN/loopback.

Truy cập không cần tài khoản chỉ áp dụng với desktop đi trực tiếp trong LAN, Host là tên/IP máy SERVER và socket hai đầu là địa chỉ nội bộ. Request từ browser hoặc proxy/tunnel không được miễn xác thực. Địa chỉ Internet `od-bridge.lukdental.us` tiếp tục yêu cầu token; không nhúng khóa dùng chung vào bộ cài. Các máy trên mạng LAN phòng khám được coi là máy tin cậy cho API MetLife.

Source Electron R5 nằm trong `metlife-electron`. Chưa xác minh launcher trên Windows SERVER thật và chưa chạy driver Save trên R5 thật; kiểm thử local không thay thế các bước xác minh đó.

## Triển khai 0.4.0

Không đưa `.env`, token hay mật khẩu DB vào Git hoặc bộ cài. Người quản trị cấu hình các biến trên SERVER; launcher giữ nguyên giá trị hiện có.

SERVER, tại thư mục Bridge:

```bat
git pull --ff-only origin main
npm ci
npm run metlife:inspect -- metlife-db-diagnostics.json
od-bridge.bat
```

Lệnh inspect dùng kết nối `DB_*` hiện có, chỉ SELECT metadata schema/engine và một nhóm preference. File JSON không chứa mật khẩu/token/hồ sơ bệnh nhân. Chẩn đoán này chỉ dành cho kỹ thuật viên trên SERVER, không nằm trong giao diện khách hàng. Endpoint: `GET /api/metlife/diagnostics/database`, cùng xác thực với API MetLife hiện có. Không cần capture cửa sổ OD.

Các giá trị do quản trị viên tự cấu hình trên SERVER:

```dotenv
ENABLE_OPEN_DENTAL_WRITES=true
METLIFE_DIRECT_DB_ENABLED=true
```

Không cần cấu hình tài khoản OD cho tool. Các bản ghi mới dùng `SecUserNumEntry=0` (không gán một nhân viên cố định); biến `METLIFE_OD_USER_NUM` cũ không còn được đọc. Khi chưa cấu hình, app vẫn đọc/đối chiếu và báo rõ mục còn thiếu; không tự bật quyền ghi. Nếu báo schema hoặc thư viện OD không tương thích, giữ nguyên DB và gửi báo cáo metadata/lỗi; không tự chuyển engine hoặc bỏ kiểm tra.

R5, tại thư mục checkout cùng repo:

```bat
git pull --ff-only origin main
cd metlife-electron
npm ci
npm start
```

Đóng app cũ trước khi mở source mới. `.env` DB chỉ nằm ở SERVER, không cần chép sang R5. Nếu đã ở `metlife-electron`, bỏ dòng `cd`. Màn hình mới vẫn dùng cùng bộ style LUK của SMS tool. Giao diện hiện đầy đủ thông tin đối chiếu; lưu gọi SERVER, không cần OCR/chuột trên OD. Refresh Account trên OD để kiểm tra khoản mới.

Workflow **Validate MetLife deployment** chạy trên thay đổi MetLife ở `main`: kiểm thử SQL bằng MariaDB 10.5 với dữ liệu tổng hợp, kiểm thử Electron trên Windows và tạo portable EXE trong artifact `LUK-MetLife-0.4.0-Windows`. Các workflow SMS không được kích hoạt bởi bản cập nhật này. Không gắn tag `v*` vì tag đó thuộc luồng build SMS.

Giới hạn vẫn giữ nguyên: adapter ghi Payment/Splits theo quy trình Insurance Paid hiện có, không thay thế nghiệp vụ nhận insurance claim, OD Audit Trail hoặc aging/balance. Nghiệm thu Account, báo cáo và số dư trên clone trước khi bật cho dữ liệu thật. CI và artifact thành công không đồng nghĩa SERVER/R5 đã pull/restart hoặc dữ liệu phòng khám đã được xác minh.

Giao diện khách hàng 0.4.0 chỉ có tìm bệnh nhân, tài liệu, đối chiếu, lưu/xác minh, hướng dẫn và lịch sử thao tác. Không hiển thị URL/DB/schema, snapshot/JSON, ID nội bộ procedure/plan, OCR/driver hoặc nhật ký kỹ thuật. Dùng CLI `npm run metlife:inspect` trên SERVER cho chẩn đoán kỹ thuật.

## Kết quả phát hành source 0.4.0 — 18/10/2026

Code phát hành: `0e073aa`, đã có trên `origin/main`.

CI: https://github.com/huypv2002/OpenDental/actions/runs/39139304638 — cả hai job MariaDB và Windows thành công. MariaDB 10.5 chạy SQL thật trên database tổng hợp dùng riêng, gồm commit/readback, ghi lặp, rollback giữa các splits, mất phản hồi commit và chặn engine không hỗ trợ. Windows chạy Electron 44.7.2, kiểm thử app, lưu/xác minh giả lập, tự kết nối, kiểm tra UI khách hàng không có nội dung kỹ thuật/menu debug; portable EXE đã build và upload.

Artifact: `LUK-MetLife-0.4.0-Windows` (portable EXE). Icon răng hiện có được giữ nguyên và chuyển đổi kích thước khi đóng gói. Không nhúng `.env` hay thông tin kết nối DB vào EXE.

Chưa xác minh chạy EXE trên R5, chưa restart SERVER/R5 và chưa ghi DB thật của phòng khám. Quản trị viên cấu hình `.env` trên SERVER, kiểm tra metadata bằng CLI rồi cập nhật theo các bước phía trên.

## Bổ sung tương thích OD 24.3 / MyISAM

Dựa trên metadata SERVER: ProgramVersion 24.3.61.0, DataBaseVersion 24.3.53.0; các bảng OD dùng MyISAM. Không đổi engine bảng OD. Schema bổ sung `payment.ExternalId` (rỗng), `payment.PaymentStatus` (`None` = 0), `paysplit.SecurityHash` (tạo bằng hàm `OpenDentBusiness.PaySplits.HashFields` của bản OD đã cài trên SERVER).

Nguồn đối chiếu là nhánh chính thức `OpenDental/opendental` `24_3`, commit `d804c19546233593d8a66af0591ed118a9e2c794` (24.3.63, không có commit công khai đúng 24.3.61). Không dùng thuật toán hash của phiên bản gần đó để giả định tương thích: helper gọi chính DLL cài trên SERVER. Chưa kiểm chứng DLL/CDT thật của phòng khám; CI chỉ kiểm tra binding với DLL tổng hợp. Không tự xây hash thay thế hoặc chấp nhận chuỗi exception/rỗng; không sửa hash của dữ liệu cũ.

Helper tự tìm `OpenDentBusiness.dll` trong các thư mục cài Open Dental chuẩn. Nếu OD cài riêng, kỹ thuật viên có thể đặt `METLIFE_OD_INSTALL_DIR` trỏ đúng thư mục cài OD trên SERVER. Không chuyển DLL/mật khẩu DB sang R5. Helper chỉ nhận giá trị Split mới qua stdin, tạo hash, trả kết quả; không kết nối DB hoặc thao tác UI. Nếu thiếu DLL/CDT hoặc helper lỗi, dừng trước ghi lâm sàng.

MyISAM không có rollback. Writer khóa bảng OD liên quan trong khoảng ghi/đọc lại, ghi trước toàn bộ kế hoạch và ID mới vào `luk_metlife_myisam_jobs` (InnoDB), rồi mới INSERT Payment/Splits. Tạo hash trước khi khóa bảng để không giữ khóa trong lúc khởi động helper. Mọi cột bắt buộc được kiểm tra trước INSERT đầu tiên. Khi ghi đủ và đọc lại khớp (kể cả ID và hash), nhật ký chuyển complete. Mất phản hồi sau khi ghi đủ có thể xác minh từ ý định và dữ liệu thật. Nếu ngắt giữa các INSERT, có thể còn Payment/Splits chưa đủ: giữ khóa bệnh nhân, không rollback giả, không tự xóa hoặc tự ghi tiếp; kỹ thuật viên phải kiểm tra và xử lý trường hợp cụ thể. Khóa bảng có thể chặn thao tác OD khác trong khoảng ngắn khi ghi.

Trên SERVER cập nhật rồi chạy `npm run metlife:inspect`. Báo cáo kiểm tra thêm việc thư viện OD có tạo được hash cho giá trị tổng hợp hay không, không xuất hash này ra báo cáo và không tạo hồ sơ. Bản khách hàng không hiện thông tin kỹ thuật. R5/EXE hiện có dùng cùng request; thay đổi này nằm ở backend SERVER.

## Bản 0.4.1: lưu qua client Open Dental

Nút **Đã đối chiếu · Lưu vào OD** hiện dùng client OD trên chính máy chạy tool: điền Payment/Splits, kiểm tra lại dữ liệu trên Bridge, ghi nhận quyền Save rồi bấm Save trong OD. Bridge đọc lại Payment/Splits để xác minh. Luồng này không gọi helper CDT và không gọi endpoint ghi SQL trực tiếp; không cần bật `METLIFE_DIRECT_DB_ENABLED` để dùng luồng client. Không đổi bảng, engine hoặc cấu hình DB.

Triển khai: pull/restart Bridge trên SERVER để có endpoint `/operations/:id/begin-ui-save`, sau đó dùng EXE tool 0.4.1 trên R5. Mở OD trên cùng máy, giữ phiên Windows không khóa và chạy OD/tool cùng mức quyền. Trong khi tool thao tác, không dùng chuột/bàn phím. Phải nghiệm thu trên OD thật; fixture/CI không xác nhận giao diện thực của phòng khám.

Sau khi đã cấp quyền Save, mất kết nối hoặc readback chưa khớp sẽ giữ lượt đang chờ; chỉ **Kiểm tra kết quả**, không tự Save lại. Lượt lỗi trước khi cấp quyền Save chỉ giải phóng khi không còn popup OD và DB tài chính chưa thay đổi. Những lượt direct-db cũ chưa xác minh vẫn được kiểm tra bằng luồng khôi phục cũ.

## Bản 0.4.2: hai cách độc lập

Tự điền chỉ mở và điền bản nháp trên OD, chưa Save. Lưu trực tiếp gọi request direct-db, không dùng UI. Không gộp hai thao tác hoặc tự thay đường request bằng Save trên client. Đường request vẫn bị CDT của SERVER từ chối xác minh assembly; dùng tự điền và kiểm tra/lưu thủ công trên OD trong thời gian xử lý backend.

Để chạy source trên R5: đóng tool đang chạy, `git pull origin main` từ repo, `cd metlife-electron`, `npm start`; kiểm tra phiên bản 0.4.2 và hai nút riêng.

## Bản 0.5.0: Client và API OD riêng

Theo lựa chọn cuối của người dùng, không phát hành thêm bản DB Request. Hai EXE: LUK MetLife Client (tự điền, chưa lưu) và LUK MetLife API (chỉ request API OD). App ID và dữ liệu cục bộ tách biệt; giao diện khách không có công cụ chẩn đoán hoặc trường key.

Từ `metlife-electron`, dùng `npm run start:client` hoặc `npm run start:api`. SERVER cần pull/restart để có `/api/metlife/diagnostics/api` và transport `od-api`. Cấu hình mẫu trong `.env.metlife-api.example`, mặc định tắt; không đưa key vào app. OD 24.3 hiện tại và trạng thái chưa có key khiến bản API khóa nút Lưu. Bản này chưa được nghiệm thu API thật; không phải giải pháp bỏ kiểm tra key hoặc CDT.

Tài liệu OD tại thời điểm 2026-10-19: quyền Payments thuộc mức 35 USD/tháng/location, phí do developer trả; Read All miễn phí không bao gồm ghi payment. Nguồn: https://www.opendental.com/site/apipermissions.html .


## 0.6.0 — giao diện một luồng thanh toán

- Bỏ hai lựa chọn Client/API cũ, chỉ giữ ứng dụng LUK MetLife Payments và request direct-db hiện có.
- Bố cục đối chiếu mới: tóm tắt bệnh nhân/tổng tiền/trạng thái, PDF cùng bảng đối chiếu, nút Lưu đi cùng tổng thanh toán.
- Thông báo kết quả rõ trên đầu ứng dụng. Lượt chưa xác minh vẫn được giữ và chặn gửi lại.
- Chạy source: `cd metlife-electron` rồi `npm start`; tiêu đề hiển thị v0.6.0.
- EXE Windows mới: `LUK-MetLife-Payments-0.6.0.exe`. Không đóng gói bộ tự điền client; không thay đổi backend hash/ghi DB.
- Kiểm thử giao diện dùng dữ liệu tổng hợp và Bridge giả lập; cần kiểm tra trên máy triển khai để xác nhận kết nối và backend thực tế.

Kiểm tra CI với DB tổng hợp phát hiện hai lỗi có sẵn: danh sách khóa MyISAM thiếu bảng clinic mà context đã đọc, và chẩn đoán nhận nhầm các cột nhật ký đã hỗ trợ thành cột lạ. Đã đồng bộ danh sách khóa theo toàn bộ bảng context đọc và sửa nhận diện trường nhật ký; không đổi thuật toán hash hay giá trị thanh toán.

Sửa khôi phục kết nối: đọc lại cấu hình được mã hóa khi mở app (kể cả profile Client cũ), ghi nhớ địa chỉ kết nối thành công; ưu tiên địa chỉ của lượt đang chờ hoặc METLIFE_SERVER_URL nếu đặt rõ. Không tự chuyển sang máy chủ khác khi đang xác minh thanh toán. Kiểm tra khởi động lại không còn biến môi trường đã qua với dịch vụ giả lập.
