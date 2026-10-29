import {cents} from './parser.js';
import {procedureDay,reviewError} from './insuranceSettlement.js';
import {procedureCandidates} from './procedureIdentity.js';

// Clinic confirmed: preserve the unique existing D0210 when an Allowable
// replacement row omits its charge/date. Never infer a fee from the benefit.
export function resolveMetlifeAllowableProcedures(procedures,completedProcs) {
  return procedures.map(p=>{
    if(p.code!=='D0210'||!p.bundled||!(p.benefitCents>0)||(p.feeCents!=null&&p.date))return p;
    const candidates=completedProcs.filter(r=>r.ProcCode===p.code&&(!p.date||procedureDay(r.ProcDate)===p.date));
    const matches=procedureCandidates(candidates,p,procedures,{metlife:true});
    if(matches.length!==1)throw reviewError('D0210 Allowable: cần đúng một dịch vụ có sẵn phù hợp trong Open Dental; không tự thêm hoặc chọn ngày/phí.');
    const match=matches[0],date=procedureDay(match.ProcDate);
    const parsedDate=new Date(date+'T12:00:00Z');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(+parsedDate)||parsedDate.toISOString().slice(0,10)!==date||date==='0001-01-01')throw reviewError('D0210 Allowable: ngày dịch vụ Open Dental không hợp lệ.');
    let fee=p.feeCents;
    if(fee==null){
      try{fee=cents(match.ProcFee);}catch{throw reviewError('D0210 Allowable: phí dịch vụ Open Dental không hợp lệ.');}
      if(fee<0)throw reviewError('D0210 Allowable: phí dịch vụ Open Dental không hợp lệ.');
    }
    return {...p,date:p.date||date,feeCents:fee,preserveExistingFee:p.feeCents==null,
      odFallback:{procNum:match.ProcNum,sourceDate:p.date??null,sourceFeeCents:p.feeCents??null,date:p.date||date,feeCents:fee}};
  });
}
