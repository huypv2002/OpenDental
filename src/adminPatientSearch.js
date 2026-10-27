// Exact #PatNum search is applied before SQL LIMIT, not after pagination.
export function adminPatientSearchFilter(query){
 const q=String(query??'').trim();
 const exact=/^#(\d+)$/.exec(q);
 if(exact){
  const id=Number(exact[1]);
  if(!Number.isSafeInteger(id)||id<=0)return {where:'WHERE 1=0',values:[],exact:true};
  return {where:'WHERE p.PatNum = ?',values:[id],exact:true};
 }
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const where = q
    ? `WHERE p.FName LIKE ? ESCAPE '\\\\'
        OR p.LName LIKE ? ESCAPE '\\\\'
        OR CONCAT_WS(' ', p.FName, p.LName) LIKE ? ESCAPE '\\\\'
        OR CAST(p.PatNum AS CHAR) LIKE ? ESCAPE '\\\\'
        OR p.WirelessPhone LIKE ? ESCAPE '\\\\'
        OR p.HmPhone LIKE ? ESCAPE '\\\\'
        OR p.WkPhone LIKE ? ESCAPE '\\\\'
        OR p.Email LIKE ? ESCAPE '\\\\'
        OR pa.Username LIKE ? ESCAPE '\\\\'`
    : '';
  return {where,values:q?Array(9).fill(like):[],exact:false};
}
