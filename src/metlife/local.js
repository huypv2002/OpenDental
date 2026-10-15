import os from 'node:os';
import net from 'node:net';
function address(value=''){return value.toLowerCase().replace(/^::ffff:/,'');}
export function privateAddress(value){
 const ip=address(value);
 if(net.isIP(ip)===4){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===192&&p[1]===168||p[0]===172&&p[1]>=16&&p[1]<=31;}
 return ip==='::1';
}
// Direct clinic LAN only. Public tunnel/reverse-proxy and browser requests need auth.
export function isLocalDesktop(req,hostname=os.hostname()){
 const headers=req.headers||{};
 if(headers['x-luk-desktop']!=='metlife'||headers.origin||headers['sec-fetch-site'])return false;
 if(Object.keys(headers).some(k=>k==='forwarded'||k.startsWith('x-forwarded-')||k.startsWith('cf-')))return false;
 if(!privateAddress(req.socket?.remoteAddress)||!privateAddress(req.socket?.localAddress))return false;
 let host;try{host=new URL('http://'+(headers.host||'')).hostname.toLowerCase().replace(/^\[|\]$/g,'');}catch{return false;}
 return ['localhost',hostname.toLowerCase(),hostname.toLowerCase().split('.')[0],address(req.socket.localAddress)].includes(host);
}
