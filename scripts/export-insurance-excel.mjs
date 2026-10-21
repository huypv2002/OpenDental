// Report-only entry point. Reads OD/history; writes XLSX files. Never scans or posts EOBs.
import path from 'node:path';
import {pool,closePool} from '../src/db.js';
import {exportDailyReports,localReportDay,excelOutputDir} from '../src/metlife/dailyExcel.js';

try{
  const day=process.argv[2];
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day||''))throw new Error('Usage: node scripts/export-insurance-excel.mjs YYYY-MM-DD [--dir "D:\\SHARE\\INSURANCE CLAIM\\EXCEL"]');
  const [year,month,date]=day.split('-').map(Number),now=new Date(year,month-1,date,12);
  if(localReportDay(now)!==day)throw new Error('Ngày xuất báo cáo không hợp lệ.');
  const incoming=process.env.METLIFE_INCOMING_DIR||'D:\\SHARE\\INSURANCE CLAIM\\METLIFE';
  const i=process.argv.indexOf('--dir');
  if(i>=0&&!process.argv[i+1])throw new Error('Thiếu thư mục sau --dir.');
  const outputDir=path.resolve(i>=0?process.argv[i+1]:(process.env.INSURANCE_EXCEL_DIR||excelOutputDir(incoming)));
  console.log(`[Excel] Chỉ xuất báo cáo; không tạo hoặc chạy lại khoản thanh toán. Thư mục: ${outputDir}`);
  const result=await exportDailyReports(pool,incoming,{now,outputDir});
  if(!result.reports.length&&!result.errors.length)console.log(`[Excel] Không tìm thấy lịch sử lưu thành công trong ngày ${day}. Chưa tạo file rỗng.`);
  if(result.errors.length)process.exitCode=1;
}catch(e){console.error(`[Excel] ${e.message}`);process.exitCode=1;}
finally{await closePool();}
