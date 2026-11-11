import http from 'node:http';
import {once} from 'node:events';
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let size=0;const chunks=[];
    const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};
    const data=part=>{size+=part.length;if(size>16384){cleanup();req.resume();reject(Object.assign(Error(),{tooLarge:true}));}else chunks.push(part);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks).toString('utf8'));};
    const error=()=>{cleanup();reject(Error('request_incomplete'));};const aborted=error;
    req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
  });
}
export function createHttpServer(service) {
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
    let result;
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(req.method==='GET'&&url.pathname==='/healthz')result={status:200,body:{ok:true}};
      else if(url.search)result={status:400,body:{success:false,code:2003,message:'业务参数须位于JSON Body'}};
      else {
        if(req.method!=='POST'){req.resume();result=await service.handle(req.method,url.pathname,'');}
        else if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')){req.resume();result={status:415,body:{success:false,code:2003,message:'Content-Type必须为application/json'}};}
        else result=await service.handle(req.method,url.pathname,await readBody(req));
      }
    }catch(error){result=error.tooLarge?{status:413,body:{success:false,code:2003,message:'请求体超过限制'}}:{status:503,body:{success:false,code:500,message:'服务暂不可用，请保留原lead_id'}};}
    if(!res.destroyed){res.statusCode=result.status;if(result.status===413)res.setHeader('Connection','close');res.end(JSON.stringify({result:null,timestamp:Date.now(),...result.body}));}
  });
}
export async function listen(server,port=0,host='127.0.0.1') {server.requestTimeout=10000;server.headersTimeout=12000;server.listen(port,host);await once(server,'listening');return server.address();}
