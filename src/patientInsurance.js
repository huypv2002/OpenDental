// Bounded SELECT-only lookup for the authenticated administrative API.
export async function readPatientInsurance(pool,patNum){
 if(!/^[1-9]\d{0,14}$/.test(String(patNum??'')))throw Object.assign(new Error('Invalid PatNum'),{status:400});
 const [rows]=await pool.execute(`SELECT p.PatNum,p.FName,p.LName,DATE(p.Birthdate) AS Birthdate,
 pp.Ordinal,s.InsSubNum,s.Subscriber,s.SubscriberID,ip.GroupNum,c.CarrierName
 FROM patient p
 LEFT JOIN patplan pp ON pp.PatNum=p.PatNum
 LEFT JOIN inssub s ON s.InsSubNum=pp.InsSubNum
 LEFT JOIN insplan ip ON ip.PlanNum=s.PlanNum
 LEFT JOIN carrier c ON c.CarrierNum=ip.CarrierNum
 WHERE p.PatNum=? ORDER BY pp.Ordinal,s.InsSubNum LIMIT 51`,[String(patNum)]);
 if(!rows.length)throw Object.assign(new Error('Patient not found'),{status:404});
 if(rows.length>50)throw Object.assign(new Error('Too many insurance records; review required'),{status:409});
 const p=rows[0];
 return {patient:{PatNum:p.PatNum,FName:p.FName,LName:p.LName,Birthdate:p.Birthdate},insurance:rows.filter(r=>r.InsSubNum!=null).map(({Ordinal,InsSubNum,Subscriber,SubscriberID,GroupNum,CarrierName})=>({Ordinal,InsSubNum,Subscriber,SubscriberID,GroupNum,CarrierName}))};
}
