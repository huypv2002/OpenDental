# Bàn giao kiểm thử bảo hiểm

Phạm vi: Bridge tự quét MetLife / Liberty / CIGNA / Delta Dental và màn hình Electron giám sát EOB hiện tại. Không bao gồm SMS. Test dùng bản sao tài liệu riêng và cơ sở dữ liệu mô phỏng; không chạy nhập vào cơ sở dữ liệu phòng khám.

## Chạy lại và xuất đầy đủ case

Từ folder Bridge, sau `npm ci` và `npm ci --prefix metlife-electron`:

```bat
npm run test:insurance:handover -- --fixtures "D:\EOB-TEST-FIXTURES" --output "D:\EOB-TEST-RESULTS" --ui
```

Folder fixtures là bản sao mẫu kiểm thử, không phải folder tool đang theo dõi. Giữ nguyên tên file mẫu khi chạy regression. Nếu không có fixtures thì bỏ `--fixtures`; báo cáo ghi rõ các test không chạy. `--ui` dùng Electron/Playwright đã cài trong project. Không cần `.env` chứa thông tin kết nối DB để chạy mô phỏng.

Kết quả: `run-manifest.json` (commit, nền tảng, fixture đã bật, mã kết thúc), `test-cases.json`, `full-test-cases.md` (mỗi test một dòng, cả PASS/FAIL/SKIP), `bridge-tests.xml/log`, `electron-unit.xml/log`, `electron-ui.log/png`. Các tài liệu gốc, ảnh tạo từ tài liệu và log có thể chứa thông tin bệnh nhân; giữ bằng chứng ở máy nội bộ, không đưa lên Git.

PASS là đúng kỳ vọng: một case chặn tài liệu lỗi trước khi ghi tiền cũng là PASS, không có nghĩa tài liệu đó đã nhập thành công. Hai integration test MariaDB bỏ qua cục bộ khi không có DB thử nghiệm; CI chạy chúng trên MariaDB tách biệt. Windows CI và SERVER phòng khám là hai môi trường khác nhau.

## Ma trận nghiệm thu theo hãng

| Hãng | File đầu vào | Ngày thanh toán | Số tiền | Điểm phải kiểm tra |
|---|---|---|---|---|
| MetLife | PDF có chữ / PDF chuyển TXT; TXT giữ cột | PROCESSED on | Tổng Plan Benefit hợp lệ | Không lấy Date Received/Payment Detail; vùng UR/UL/LR/LL; dịch vụ Allowable; không nhân đôi D4342 |
| Liberty | PDF, JPG/JPEG, PNG; TXT | Check Date | Plan Paid của từng claim | Nhiều bệnh nhân một file; Q01/Q02 của D5110/D5120 là hàm trên/dưới; không tạo lại dịch vụ có sẵn |
| CIGNA | PDF chuyển TXT; TXT giữ cột | Date Processed | Quyền lợi theo từng dòng và alternate benefit đã xác nhận | Ví dụ header $0 nhưng hai khoản $56.80 thành $113.60; răng 03/3; không hỗ trợ ảnh rời CIGNA |
| Delta Dental | PDF, JPG/JPEG, PNG; TXT | Date payment sent | Delta Dental pays của Claim total | Amount có thể gộp nhiều claim; đủ sáu tổng cột; quyền lợi giảm; X-quang FLB; tên ghép Van Anh/VANANH |

Quy tắc đã chốt ngày 28/10/2026: MetLife, CIGNA và Delta lấy PatNum từ đầu tên file, không kiểm tra trùng tên EOB và không tự tìm hồ sơ khác theo tên. Hỗ trợ tiền tố timestamp tải xuống/lưu trữ và ghi chú sau mã. Cập nhật 30/10: CIGNA nhiều claim tìm từng bệnh nhân bằng Subscriber ID / mã người phụ thuộc trong từng khối EOB; không lấy mã file áp cho cả nhóm. CIGNA một claim, MetLife và Delta vẫn theo mã file.

Riêng Liberty tìm từng bệnh nhân bằng Subscriber ID trong từng claim, không dùng PatNum của tên file hoặc tên in trên EOB. Ưu tiên ID đầy đủ, sau đó thử ID bỏ hậu tố số nếu OD lưu thiếu hậu tố. Không khớp hoặc khớp nhiều hồ sơ thì dừng trước khi ghi claim đầu tiên. Xem [quy tắc và kiểm thử 28/10](insurance-patient-identity-2026-10-28.md). MetLife vẫn yêu cầu đúng một Claim Number mỗi file.

Mỗi hãng có case riêng cho: thanh toán TXT đầy đủ, note/check/date, ước tính/write-off = 0 đúng phạm vi, Excel một lần, chạy lại đổi tên, ExternalId rỗng nhưng claim note khớp, khoản cũ khác tiền/ngày/phân bổ, nhiều khoản cùng claim, dịch vụ trùng mơ hồ, native hash lỗi, lịch sử lỗi sau khi đã ghi tiền, lỗi ghi split và việc bỏ qua các folder con. Các test nguồn và fixture thực bổ sung kiểm tra parser/scan/PDF/ảnh/nhiều bệnh nhân theo từng hãng.

## Kịch bản demo 15–20 phút

1. Mở console Bridge và Electron; chứng minh kết nối bằng trạng thái thực, không chỉ việc cửa sổ đã mở. Kiểm tra folder `D:\SHARE\INSURANCE CLAIM\EXCEL`.
2. Trên môi trường thử nghiệm, thả một mẫu mới của từng hãng. Đối chiếu patient, claim, ngày trả, tổng tiền, từng dòng phân bổ. Kiểm tra Finished Claims có tài liệu gốc, note `Claim number: ...`, Check để trống.
3. Liberty dùng mẫu hai bệnh nhân: kiểm tra hai khoản riêng và đúng dịch vụ D5110/D5120 sẵn có. Kiểm tra không có thủ thuật mới trùng mã/ngày/hàm.
4. Delta 1279: mã file chọn #1279, không chặn vì tên hoặc Subscriber ID trong OD khác. Dịch vụ D2393 răng 4/19, tổng $232.00. Không sửa thông tin hợp đồng bảo hiểm.
5. Chạy lại đúng file và bản đổi tên: Payment/DocNum/procedure count giữ nguyên; Excel không thêm nhóm trùng. Mở Excel kiểm tra tab PAYMENTS, TONG HOP và CAN DOI CHIEU nếu có.
6. Mở Excel khi xuất báo cáo: thanh toán thành công không chạy lại; đóng Excel rồi xem báo cáo được ghi bù. Case sai tổng/thiếu trang phải vào REVIEW, không tự lặp lại.

Không dùng demo này để nhập lại tùy ý vào OD thật: các khoản đã trùng từ bản cũ cần đối chiếu riêng. Bộ kiểm thử không tự xóa hoặc sửa lịch sử thanh toán thật.

## Giới hạn cần nói rõ

- File Delta 1012 scan hiện có thể xuất TXT nhưng còn mã/số nhận dạng chưa đủ chắc chắn: chặn tự động và cần TXT được chuyển đúng từ nguồn hoặc đối chiếu. Test chặn là test bảo vệ, không phải bằng chứng nhập PDF thành công.
- Ảnh PNG nguyên gốc Delta 280 đã có case đọc tổng và nhập/chạy lại bằng DB mô phỏng. Bản JPG tạo từ cùng tài liệu vẫn chưa đọc chắc mã D1110; case yêu cầu tự nhập JPG đó chưa đạt. Báo cáo riêng phải giữ case FAIL này; không đổi thành PASS để tuyên bố hỗ trợ mọi ảnh Delta. Các cột ngày/mã/tổng trong ảnh được đọc theo khung ảnh riêng, giữ nguyên đường đọc PDF cũ.
- Mất kết nối sau khi Payment đã ghi nhưng trước khi các split ghi đủ có thể để lại khoản chưa hoàn tất trên MyISAM. Tool chặn lần chạy lại để không thêm Payment thứ hai; cần đối chiếu thủ công, không tự xóa hoặc tự bù số tiền.
- Test mô phỏng lỗi file Excel không chứng minh quyền NTFS/SMB và khóa Excel trên SERVER/R5. Cần bước nghiệm thu thực tế tại máy đích.
- Không cam kết mọi định dạng tài liệu tương lai. File ngoài mẫu hoặc mâu thuẫn số liệu phải dừng để kiểm tra.
