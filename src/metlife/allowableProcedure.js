import {reviewError} from './insuranceSettlement.js';

const groupedXrayCodes=new Set(['D0220','D0230','D0274','D0330']);
const validDay=value=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value||'')||value==='0001-01-01')return false;
  const date=new Date(value+'T12:00:00Z');
  return Number.isFinite(+date)&&date.toISOString().slice(0,10)===value;
};

// Clinic confirmed 30/10: the replacement D0210 follows the grouped X-rays'
// date. Missing Fee Charged uses Covered Expense, then the clinic's $150 fee.
// This policy is specific to MetLife D0210 Allowable, not other service rows.
export function resolveMetlifeAllowableProcedures(procedures) {
  return procedures.map(p=>{
    if(p.code!=='D0210'||!p.bundled||!(p.benefitCents>0))return p;
    let date=p.date,dateSource='eob';
    const grouped=procedures.filter(r=>groupedXrayCodes.has(r.code)&&r.status==='Denied'&&/\b(?:65|J)\b/.test(r.evidence||''));
    if(!date){
      const dates=[...new Set(grouped.map(r=>r.date))];
      if(!grouped.length||dates.length!==1||!validDay(dates[0]))throw reviewError('D0210 Allowable: chưa xác định duy nhất ngày của các code X-ray bị gộp trên EOB; không tự chọn ngày.');
      date=dates[0];dateSource='grouped-eob-services';
    }
    if(!validDay(date))throw reviewError('D0210 Allowable: ngày dịch vụ trên EOB không hợp lệ.');
    const feeSource=p.feeCents!=null?'fee-charged':p.coveredCents!=null?'covered-expense':'clinic-default';
    const feeCents=p.feeCents??p.coveredCents??15000;
    if(!Number.isSafeInteger(feeCents)||feeCents<0)throw reviewError('D0210 Allowable: phí dịch vụ trên EOB không hợp lệ.');
    return {...p,date,feeCents,bundleResolution:{
      sourceDate:p.date??null,sourceFeeCents:p.feeCents??null,
      date,dateSource,feeCents,feeSource,
      groupedServices:grouped.map(r=>({code:r.code,date:r.date}))
    }};
  });
}
