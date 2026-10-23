const quads={UR:'UR',UL:'UL',LR:'LR',LL:'LL',Q01:'UR',Q02:'UL',Q03:'LL',Q04:'LR'};
export const normalizeTooth=value=>/^\d+$/.test(String(value||''))?String(Number(value)):String(value||'').trim().toUpperCase();
export const procedureQuadrant=p=>[p.quadrant,p.surface,p.surf,p.Surf,p.tooth,p.ToothNum].map(v=>quads[String(v||'').trim().toUpperCase()]).find(Boolean)||'';
export const procedureAreaKey=p=>JSON.stringify([normalizeTooth(p.tooth??p.ToothNum),procedureQuadrant(p)||String(p.surface??p.surf??p.Surf??'').trim().toUpperCase()]);
export function procedureAreaMatches(eob,od,{metlife=false}={}){
 const quadrant=procedureQuadrant(eob);
 if(quadrant)return procedureQuadrant(od)===quadrant;
 return metlife||!/^\d+$/.test(eob.tooth||'')||normalizeTooth(od.ToothNum)===normalizeTooth(eob.tooth);
}
