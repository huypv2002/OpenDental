import {test} from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import express from 'express';import {isLocalDesktop} from './local.js';import {createMetlifeRouter} from './router.js';
function request(){return {headers:{host:'SERVER:3008','x-luk-desktop':'metlife'},socket:{remoteAddress:'::ffff:192.168.1.5',localAddress:'::ffff:192.168.1.254'}};}
test('direct desktop LAN accepts only private sockets and the actual server host',()=>{
 const req=request();assert.equal(isLocalDesktop(req,'SERVER'),true);
 for(const headers of [{host:'od-bridge.lukdental.us'},{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'},{'cf-connecting-ip':'192.168.1.5'},{'x-forwarded-for':'192.168.1.5'},{forwarded:'for=192.168.1.5'},{'x-luk-desktop':''}])assert.equal(isLocalDesktop({...req,headers:{...req.headers,...headers}},'SERVER'),false);
 for(const ip of ['8.8.8.8','::ffff:8.8.8.8','fe80::1'])assert.equal(isLocalDesktop({...req,socket:{...req.socket,remoteAddress:ip}},'SERVER'),false);
 assert.equal(isLocalDesktop({...req,headers:{...req.headers,host:'192.168.1.254:3008'}},'SERVER'),true);
});
test('direct LAN API needs no credentials while tunnel/website access still requires authentication',async()=>{
 const app=express();app.use(createMetlifeRouter({getToken:()=>'x'.repeat(64),repository:{health:async()=>({db:true})}}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/health`;
 try{
  assert.equal((await fetch(url,{headers:{'X-LUK-Desktop':'metlife'}})).status,200);
  for(const extra of [{Host:'od-bridge.lukdental.us'},{Origin:'https://evil.test'},{'CF-Connecting-IP':'192.168.1.5'}])assert.equal(await new Promise((resolve,reject)=>{http.get(url,{headers:{'X-LUK-Desktop':'metlife',...extra}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);}),401,JSON.stringify(extra));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
