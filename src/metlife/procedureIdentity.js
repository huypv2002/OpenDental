const quads={UR:'UR',UL:'UL',LR:'LR',LL:'LL',Q01:'UR',Q02:'UL',Q03:'LL',Q04:'LR'};
const text=value=>String(value??'').trim().toUpperCase();
const archCodes={D5110:'U',D5120:'L',D5214:'L'};
export const normalizeTooth=value=>/^\d+$/.test(text(value))?String(Number(text(value))):text(value);
export function procedureArch(p){
 const expected=archCodes[text(p.code??p.ProcCode)];
 if(!expected)return '';
 // The carrier prints Q01/Q02 for complete dentures. Those are upper/lower
 // arches for these verified codes, not periodontal quadrants UR/UL.
 const explicit=[p.surface,p.surf,p.Surf,p.tooth,p.ToothNum].map(text).map(v=>({U:'U',UA:'U',L:'L',LA:'L'})[v]).find(Boolean);
 return explicit||expected;
}
export const procedureQuadrant=p=>procedureArch(p)?'':[p.quadrant,p.surface,p.surf,p.Surf,p.tooth,p.ToothNum].map(v=>quads[text(v)]).find(Boolean)||'';
export function procedureAreaKey(p){
 const arch=procedureArch(p),quad=procedureQuadrant(p);
 return arch?JSON.stringify(['arch',arch]):quad?JSON.stringify(['quadrant',quad]):JSON.stringify([normalizeTooth(p.tooth??p.ToothNum),text(p.surface??p.surf??p.Surf)]);
}
export function procedureAreaMatches(eob,od,{metlife=false}={}){
 const arch=procedureArch(eob);
 if(arch)return procedureArch({...od,ProcCode:od.ProcCode||eob.code})===arch;
 const quadrant=procedureQuadrant(eob);
 if(quadrant)return procedureQuadrant(od)===quadrant;
 return metlife||!/^\d+$/.test(eob.tooth||'')||normalizeTooth(od.ToothNum)===normalizeTooth(eob.tooth);
}
export function procedureCandidates(byDate,eob,procedures,{allowUniqueCodeDate=false,metlife=false}={}){
 const exact=byDate.filter(r=>procedureAreaMatches(eob,r,{metlife}));
 if(exact.length)return exact;
 const singleSource=procedures.filter(p=>p.benefitCents>0&&p.code===eob.code&&p.date===eob.date).length===1;
 if((allowUniqueCodeDate||metlife)&&byDate.length===1&&singleSource){
  // A sole completed code/date can resolve a missing OD quadrant, but never
  // override a different explicit quadrant or conflicting denture arch.
  if(procedureArch(eob))return [];
  if(procedureQuadrant(eob)&&procedureQuadrant(byDate[0]))return [];
  return byDate;
 }
 return [];
}
