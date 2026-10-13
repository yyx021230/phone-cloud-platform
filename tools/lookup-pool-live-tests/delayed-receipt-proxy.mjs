// Local test fault injection only: preserve the Agent's actual terminal report
// in its existing outbox while other phones keep reporting normally.
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
export function delayedTask(control,pathname,body,now=Date.now()){
  if(!control||!Number.isFinite(control.armedAtMs)||!Number.isFinite(control.releaseAtMs)
    ||control.releaseAtMs-control.armedAtMs>180000||now<control.armedAtMs||now>=control.releaseAtMs)return false;
  return typeof control.taskId==='string'&&control.taskId.length>0
    &&pathname===`/api/v1/windows-agent-tasks/${encodeURIComponent(control.taskId)}/status`
    &&['succeeded','failed','cancelled'].includes(body?.status);
}
export async function startDelayedReceiptProxy({target,port,controlFile,onEvent=()=>{}}){
  const upstream=new URL(target);assert.equal(upstream.hostname,'127.0.0.1');assert.equal(upstream.protocol,'http:');
  const server=http.createServer(async(req,res)=>{
    const parts=[];let size=0;
    for await(const part of req){size+=part.length;if(size>32*1024*1024){res.writeHead(413);res.end();return;}parts.push(part);}
    const body=Buffer.concat(parts);let control,input;
    try{control=JSON.parse(fs.readFileSync(controlFile));input=JSON.parse(body.toString());}catch{}
    if(delayedTask(control,req.url.split('?')[0],input)){
      onEvent({atUtc:new Date().toISOString(),kind:'terminal_receipt_delayed',taskId:control.taskId,status:input.status});
      res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"local_test_receipt_delay"}');return;
    }
    const forward=http.request({hostname:'127.0.0.1',port:upstream.port,method:req.method,path:req.url,headers:{...req.headers,host:upstream.host}},reply=>{
      res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
    });
    forward.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});forward.end(body);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server;
}
