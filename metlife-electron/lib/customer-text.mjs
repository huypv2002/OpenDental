export function customerMessage(value){
 const text=String(value||'');
 if(/FName|LName|MiddleI/.test(text))return 'Tên bệnh nhân trong PDF không khớp hồ sơ Open Dental. Vui lòng kiểm tra lại.';
 if(/Existing payment|possible duplicate/i.test(text))return 'Khoản thanh toán này đã được ghi hoặc có thể bị trùng. Vui lòng kiểm tra lại.';
 if(/already has insurance payment/i.test(text))return 'Dịch vụ đã có khoản bảo hiểm thanh toán. Vui lòng kiểm tra trước khi lưu lại.';
 if(/allocation total mismatch/i.test(text))return 'Tổng phân bổ không khớp số tiền thanh toán. Vui lòng kiểm tra lại.';
 if(/PDF changed/i.test(text))return 'Tài liệu đã thay đổi. Mở lại tài liệu để đối chiếu trước khi lưu.';
 if(/context|metadata|Cannot read|undefined|TypeError|SyntaxError|ENOTFOUND/i.test(text))return 'Chưa cập nhật được hồ sơ. Vui lòng làm mới để đối chiếu lại hoặc liên hệ hỗ trợ.';
 if(/^Đã ghi và xác minh Payment/.test(text))return 'Đã lưu và xác minh khoản thanh toán. Làm mới Account trong Open Dental để xem.';
 if(/^Đã xác minh Payment/.test(text))return 'Đã xác minh khoản thanh toán đã lưu.';
 if(/Chưa xác minh transaction|^Chưa xác minh:/.test(text))return 'Chưa xác minh được kết quả lưu. Bấm Kiểm tra kết quả; không lưu lại.';
 if(/Chưa ghi DB|ghi DB|METLIFE_|ENABLE_OPEN_DENTAL_WRITES|InnoDB|MyISAM|schema|AUTO_INCREMENT|SQL|ER_\w+|adapter|transaction|COMMIT|rollback/i.test(text))return 'Chưa thể lưu khoản thanh toán. Vui lòng liên hệ bộ phận hỗ trợ.';
 if(/snapshot|JSON|read.only|capture-db|AtoZfolder|ImageStore|UNC|DocNum|ProcNum|PatNum|InsSubNum|PlanNum|userData|diagnostic|OCR|UI Automation|UIA|control|hash|token|bearer/i.test(text))return 'Chọn đúng bệnh nhân và tài liệu trong hồ sơ để đối chiếu. Nếu vẫn chưa được, vui lòng liên hệ hỗ trợ.';
 if(/SERVER|Bridge|localhost|https?:\/\/|cổng \d|LAN|database|MySQL|MariaDB/i.test(text))return 'Chưa kết nối được dữ liệu phòng khám. Vui lòng kết nối lại hoặc liên hệ hỗ trợ.';
 if(/Invalid |Operation |Procedure |Payment.*definition|allocation|Existing payment|PDF changed|Unknown action|fetch failed|ECONN|ENOENT|timeout/i.test(text))return 'Chưa thể hoàn tất thao tác. Làm mới hồ sơ để kiểm tra hoặc liên hệ hỗ trợ.';
 return text.replace(/\bsnapshot\b/gi,'hồ sơ').replace(/\bSplits?\b/g,'phân bổ').replace(/\bprocedure\b/gi,'dịch vụ');
}
