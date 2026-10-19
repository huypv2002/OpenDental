# Bàn giao nghiên cứu Open Dental API khi chưa có API key

Cập nhật: 19/10/2026. Tài liệu nội bộ để đưa cho AI/kỹ sư khác tiếp tục công việc, không đưa vào giao diện khách hàng.

## 1. Mục tiêu của chủ dự án

Phòng khám đã mua và sử dụng client Open Dental, có quyền quản trị máy Windows và tài khoản root MariaDB của chính phòng khám. Chủ dự án muốn gửi request để **OD tự chạy nghiệp vụ và ghi dữ liệu**, không tự động bấm chuột/nhập bàn phím trên client và không tự dựng toàn bộ nghiệp vụ bằng SQL.

**Phòng khám chưa bật API và không có Developer API Key/Customer API Key. Không muốn mua gói API có phí hằng tháng.** Yêu cầu người dùng nêu rõ là cần nghiên cứu **“bypass key / đục”** vì đã mua bản client. Đây là **mục tiêu nghiên cứu do người dùng yêu cầu, chưa phải khả năng đã được chứng minh**. Không diễn đạt thành “đã có API không cần key”, “mua client mặc nhiên có quyền API”, hoặc “đã bypass thành công”.

Đầu ra mong muốn của nghiên cứu: xác định có cách tích hợp request cục bộ hợp lệ và khả thi trong phạm vi hệ thống phòng khám hay không; mô tả chính xác ràng buộc key/phiên bản; cung cấp bằng chứng và PoC trên lab nếu có. Nếu không tìm được thì báo rõ giới hạn, không đổi sang UI automation rồi gọi đó là API.

## 2. Ba đường cần phân biệt

| Đường | Thành phần thực hiện ghi | Tình trạng |
|---|---|---|
| Auto client | Client OD qua thao tác cửa sổ | Đã có tự điền; dừng trước Save |
| Request trực tiếp MariaDB | Bridge Node.js tự chạy SQL | Có quyền DB nhưng chưa tạo được hash hợp lệ qua helper ngoài |
| Request API OD | Dịch vụ/client OD nhận API và chạy nghiệp vụ | Mong muốn ưu tiên; chưa có key; chưa nghiệm thu trên phòng khám |

Giao diện yêu cầu tách sản phẩm: **Client** và **API OD**. Không gộp tự điền với Save; không để bản API tự fallback sang SQL hay bấm Save trên OD.

## 3. Môi trường thực tế

- Repo: `https://github.com/huypv2002/OpenDental.git`, nhánh `main`.
- Workspace: `open-dental-bridge`, desktop app: `metlife-electron`.
- SERVER chạy Bridge và MariaDB; R5 chạy client OD/tool.
- Đường dẫn SERVER: `C:\open-dental-bridge`.
- OD cài tại `C:\Program Files (x86)\Open Dental`.
- ProgramVersion: `24.3.61.0`; DataBaseVersion: `24.3.53.0`.
- OpenDentBusiness.dll, CodeBase.dll, CDT.dll báo version `24.3.61.0`.
- Các bảng OD đã kiểm tra dùng MyISAM; không được coi transaction/rollback là cơ chế hoàn tác cho chúng.
- Quyền root DB đã có. Chưa có API key hay quyền Payments của API.

Không cần đưa thông tin bệnh nhân, key, mật khẩu hoặc toàn bộ `.env` vào prompt bàn giao.

## 4. Key và phí: thông tin đã xác minh từ OD

Theo tài liệu chính thức tại thời điểm nghiên cứu:

- Header API dùng cặp DeveloperKey/CustomerKey: `Authorization: ODFHIR {DeveloperKey}/{CustomerKey}`.
- Developer xin quyền Developer Portal; key khách được tạo/gán cho cặp khách hàng/developer và được bật trong OD. Cài client và có root MariaDB là hai việc khác với cơ chế cấp key này.
- Local API: `http://127.0.0.1:30222/api/v1/`, chạy cùng client OD sau khi đăng nhập.
- API Service: `http://127.0.0.1:30223/api/v1/`, dịch vụ trên máy chủ.
- Endpoint cục bộ **không được coi là không cần xác thực chỉ vì dùng localhost**.
- Gói Read All miễn phí; nhóm Payments thuộc mức 35 USD/tháng/location. OD ghi phí do developer trả. Không tự kích hoạt dịch vụ hoặc tạo cam kết thanh toán thay người dùng.

Nguồn để AI nhận việc đọc lại:

- https://www.opendental.com/site/apisetup.html
- https://www.opendental.com/site/apilocal.html
- https://www.opendental.com/site/apipermissions.html

Chú ý: `/site/apifees.html` nói về bảng giá điều trị (`fee`), **không phải** trang phí thuê API.

## 5. Kết quả SecurityHash: không lặp lại các thử nghiệm đã thất bại

### Chạy thật với bộ DLL của phòng khám

1. Helper PowerShell x64 lỗi kiến trúc do dependency x86.
2. Đã sửa nạp DLL cùng thư mục, chọn helper x86 và tránh chặn nhầm framework System.Net.Http.
3. Helper PowerShell x86 gọi được `PaySplits.HashFields`, nhưng CDT trả lỗi:

```text
NullReferenceException at CDT.Class1.VerifyCallingAssembly()
Unable to find assembly to verify.
```

4. PowerShell có entryAssembly rỗng. Đã tạo EXE riêng tên `MetlifeOdContextHost` để thử lại; entryAssembly tồn tại nhưng vẫn lỗi:

```text
Method can only be called from an assembly built by Open Dental.
at CDT.Class1.VerifyCallingAssembly()
```

Kết luận đã xác minh: chỉ thay PowerShell bằng EXE, chạy Administrator, có root DB hay cùng version DLL **chưa giải quyết được** hạn chế này. Chuỗi `Exception` có 9 ký tự từng bị hiểu nhầm là hash ngắn; thực tế đó là tên exception, không được ghi vào SecurityHash.

### Source công khai và giới hạn phiên bản

Đã đối chiếu commit công khai `d804c19546233593d8a66af0591ed118a9e2c794` thuộc nhánh 24.3, business assembly version **24.3.63.0**, không phải binary chính xác 24.3.61 của phòng khám.

- `OpenDentBusiness/Data Interface/PaySplits.cs`: HashFields dùng PatNum, SplitAmt và **DatePay**, sau đó gọi CDT. Chú thích model có chỗ ghi DateEntry nhưng implementation dùng DatePay.
- `OpenDentBusiness/Misc/SecurityHash.cs`: có worker bảo trì/rehash; không phải API tích hợp theo từng khoản thanh toán.
- `OpenDental/Forms/FormPayment.cs`: Save còn đồng bộ splits, security log và các bước nghiệp vụ liên quan.
- Static inspection routine VerifyCallingAssembly trong public `Required dlls/CDT.dll`: lấy entry assembly hoặc tìm qua stack, hash file chương trình rồi so với danh sách chấp nhận. Chưa đối chiếu static routine này với binary 24.3.61 thực tế.

Báo cáo đầy đủ: [metlife-securityhash-investigation.md](metlife-securityhash-investigation.md).

## 6. Đề bài nghiên cứu cho AI tiếp theo

Chủ dự án muốn một đường request không cần thuê thêm API; có nêu mong muốn bypass API key. **Trước khi đề xuất bất kỳ cách làm nào, phải chứng minh ranh giới kỹ thuật dưới đây bằng source/binary và thử nghiệm lab của phòng khám.**

1. Vẽ luồng Local API/API Service từ listener đến kiểm tra key, quyền tài nguyên và hàm nghiệp vụ. Chỉ rõ thành phần nào chạy local, thành phần nào phụ thuộc dịch vụ của OD. Không suy đoán “local là không xác thực”.
2. Xác định entitlement/cấp key áp dụng cho từng mode. Kiểm tra có phương thức tích hợp được cấp cùng bản client, ngoại lệ dành cho nội bộ, chương trình developer/test, hoặc hook/plugin được hỗ trợ nào phù hợp hay không. Phân biệt tài liệu chính thức với suy luận từ source.
3. Với yêu cầu “bypass”, ghi rõ đây là phần **chưa có PoC và chưa có xác nhận khả thi**. Phạm vi bàn giao không bao gồm chỉ dẫn giả key, sửa verifier, khai thác máy chủ của OD hoặc vô hiệu cơ chế xác thực. Nếu đề xuất một hướng thay thế không cần API trả phí, phải giải thích nó thực chất là gì, có dùng UI hay ghi SQL không, và có thật sự giữ được nghiệp vụ OD không.
4. Kiểm tra read-only trên lab với dữ liệu giả: listener đang chạy hay không, phản hồi khi thiếu key, trạng thái kích hoạt và phiên bản. Không thử credentials của khách/developer khác. Demo credentials công khai chỉ dành cho môi trường demo được OD mô tả, không phải key cho dữ liệu phòng khám.
5. Đừng đồng nhất vấn đề key API với VerifyCallingAssembly của CDT. Giải quyết một lớp chưa chứng minh đã giải quyết lớp còn lại.
6. Khi có một đường được cấp quyền thực sự, chứng minh nó tạo đúng Payment/Splits, audit và phân bổ, rồi kiểm tra crash/timeout/chống ghi trùng trước khi dùng clinic data.

## 7. Vấn đề nghiệp vụ tồn tại kể cả khi giải quyết được key

Tool hiện làm `payment` + `paysplit` gắn procedure, dùng payment definition Category 10 tên “Insurance Paid”. **Không** tạo claimpayment hay đổi claimproc. Tên loại tiền chưa chứng minh đây là nghiệp vụ receive insurance claim. Không tự đổi sang ClaimPayments API.

Tài liệu API hiện hành:

- Payments POST có từ trước 24.3, cho gửi danh sách ProcNums nhưng phân bổ theo FIFO.
- Payments PUT Partial có từ **25.1.11**, cho gửi từng cặp ProcNum/Amount.
- PaySplits PUT có từ **25.2.9**, chỉ tài liệu hóa thay provider/clinic, không phải endpoint sửa SplitAmt tùy ý trên 24.3.

Do PDF có số tiền cụ thể cho từng procedure, nghiên cứu phải giải quyết **cả quyền API lẫn khả năng phân bổ đúng trên phiên bản đang cài**. Không nâng cấp production hoặc sửa phân bổ âm thầm để đạt kết quả “lưu được”.

Nguồn:

- https://www.opendental.com/site/apipayments.html
- https://www.opendental.com/site/apipaysplits.html
- https://www.opendental.com/site/integrationtypes.html

## 8. Source hiện có để tiếp tục

- `src/metlife/posting.js`: prepare, chống trùng, trạng thái bền vững và readback.
- `src/metlife/directPayment.js`, `myisamPayment.js`: đường SQL cũ, không phải API OD.
- `scripts/inspect-metlife-od-context.ps1`, `inspect-metlife-od-host.ps1`: chẩn đoán chỉ dùng input giả, không kết nối DB.
- `metlife-electron/windows`: tự điền trên client, không phải request API.
- Bản tách 0.5.0 đang được hoàn thiện: Client và API; main process chặn thao tác chéo và hai app dùng profile riêng.
- Adapter `src/metlife/odApiPayment.js`: đường chính thức POST payment, PUT Partial, lưu PayNum trước bước tiếp theo; mặc định tắt, cần key và version >=25.1.11. Nó **không** triển khai bypass key, không fallback SQL/UI, chưa được chạy API thật tại phòng khám.
- `.env.metlife-api.example`: chỉ tên biến cấu hình, không có key.

Kiểm tra `git status` và commit hiện tại trước khi làm vì phần 0.5.0 có thể còn là working tree hoặc đã được commit sau khi tài liệu này được tạo. Giữ các sửa đổi/untracked có sẵn của người dùng.

## 9. Báo cáo kết quả mong đợi

AI nhận việc trả lại:

- Bản đồ kỹ thuật và bằng chứng theo đúng phiên bản.
- Kết luận có/không có đường request đáp ứng điều kiện không trả phí, còn phần nào chưa biết.
- Kiểm tra khóa chống nhập trùng giữa Client preview và API. Client preview hiện không giữ server posting lock; profile riêng không thay thế khóa tài chính dùng chung. Không coi hai app đã an toàn để xử lý đồng thời cùng khoản thanh toán chỉ vì từng luồng riêng lẻ đã qua test.
- Nếu có PoC: cách chạy trên lab dữ liệu giả, bằng chứng đầu vào/đầu ra và giới hạn; không gọi đó là clinic-ready nếu chưa nghiệm thu.
- Nếu hướng duy nhất được hỗ trợ vẫn cần key/quyền Payments, nói thẳng. Không báo “đã xong bản API” khi nút lưu thực chất bị khóa hoặc thao tác vẫn là UI/SQL.

Tuyệt đối không đưa thông tin kỹ thuật, key, stack trace hoặc trạng thái nghiên cứu vào giao diện khách hàng; để trong tài liệu/log nội bộ.
