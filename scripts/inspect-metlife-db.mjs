import fs from 'node:fs/promises';
import {pool,closePool} from '../src/db.js';
import {databaseDiagnostics} from '../src/metlife/databaseDiagnostics.js';
// Uses the existing SERVER .env; never writes or exports credentials/patient data.
try{
 const report=await databaseDiagnostics(pool);
 const json=JSON.stringify(report,null,2)+'\n';
 if(process.argv[2]){await fs.writeFile(process.argv[2],json,{mode:0o600});console.log('Đã lưu kiểm tra metadata DB MetLife. Không thay đổi dữ liệu OD.');}
 else console.log(json);
}catch{console.error('Chưa đọc được metadata OD. Kiểm tra kết nối/quyền DB trong .env trên SERVER.');process.exitCode=1;}
finally{await closePool();}
