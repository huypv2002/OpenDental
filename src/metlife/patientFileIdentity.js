import {reviewError} from './insuranceSettlement.js';

// The clinic assigns non-Liberty EOBs by PatNum in the filename. A download
// timestamp and a human-readable suffix are allowed; embedded numbers are not.
export function patientFileNumber(fileName){
 const match=/^(?:\d{13}_)*(\d{1,12})(?:[ _-]+\p{L}[^/\\]*)?\.(?:pdf|txt|jpe?g|png)$/iu.exec(fileName||'');
 const number=match?.[1];
 return number&&Number.isSafeInteger(Number(number))&&Number(number)>0?number:null;
}

export async function resolveFilePatient(pool,{fileName,carrier}){
 const patNum=patientFileNumber(fileName);
 if(!patNum)throw reviewError(`${carrier}: tên file phải bắt đầu bằng mã bệnh nhân (ví dụ 1004.pdf); chưa lưu thanh toán.`);
 const [rows]=await pool.execute(`SELECT p.PatNum,p.FName,p.LName,p.Birthdate,p.ClinicNum,p.PriProv,p.ImageFolder,p.ChartNumber
 FROM patient p WHERE p.PatNum=? LIMIT 2`,[patNum]);
 if(rows.length!==1)throw reviewError(`${carrier}: không tìm thấy duy nhất mã bệnh nhân #${patNum} từ tên file; chưa lưu thanh toán.`);
 return rows[0];
}
