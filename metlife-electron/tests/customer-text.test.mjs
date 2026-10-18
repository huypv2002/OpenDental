import {test} from 'node:test';
import assert from 'node:assert/strict';
import {customerMessage} from '../lib/customer-text.mjs';
test('customer messages omit implementation details but preserve clinical duplicate guidance',()=>{
 for(const raw of ['METLIFE_DIRECT_DB_ENABLED missing','payment dùng MyISAM; cần InnoDB','SERVER trả sai schema','Snapshot thiếu bảng JSON','fetch failed','Invalid posting plan','D0120: procedure không khớp','OD context is not fresh','Provider metadata changed','Cannot read properties of undefined'])assert.doesNotMatch(customerMessage(raw),/METLIFE_|DB|MyISAM|InnoDB|SERVER|schema|JSON|snapshot|posting|fetch|procedure/i);
 assert.match(customerMessage('Đã ghi và xác minh Payment #88, 3 Splits.'),/Đã lưu và xác minh/);
 assert.doesNotMatch(customerMessage('Đã ghi và xác minh Payment #88, 3 Splits.'),/#88|Splits/);
 assert.match(customerMessage('Chưa xác minh transaction. timeout'),/không lưu lại/);
 assert.match(customerMessage('Phát hiện giao dịch đã nhập hoặc có khả năng trùng; không điền lại.'),/trùng/);
});
