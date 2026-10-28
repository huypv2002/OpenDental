import {reviewError} from './insuranceSettlement.js';

// Procedure charges and insurance payment allocations are separate amounts.
export function procedureFeeCents(procedure,carrier='MetLife'){
 const allowed=['LIBERTY Dental Plan','DELTA DENTAL'].includes(carrier);
 const value=allowed?procedure.allowedCents:procedure.feeCents;
 if(!Number.isSafeInteger(value)||value<0)throw reviewError(`${procedure.code}: thiếu phí ${allowed?'Allowed Amount / Accepted Fee':'Fee Charged / Amount Charged'} hợp lệ; chưa cập nhật dịch vụ.`);
 return value;
}
