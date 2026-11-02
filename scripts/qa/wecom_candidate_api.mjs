// Explicit loopback-only platform fixture. No production credentials or shared Agent.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {once} from 'node:events';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'../..');
const input=readline.createInterface({input:process.stdin})[Symbol.asyncIterator]();
const init=JSON.parse((await input.next()).value);
if (!path.isAbsolute(init.folder) || !/^[1-9]\d{0,2}$/.test(init.deviceNumber)
    || !/^[A-Za-z0-9_.:-]+$/.test(init.serial)) throw Error('qa_init_invalid');
if (await fs.stat(path.join(root,'.env')).then(()=>true,()=>false)) throw Error('qa_checkout_has_env');
const listener=http.createServer().listen(0,'127.0.0.1');await once(listener,'listening');
const port=listener.address().port;await new Promise(r=>listener.close(r));
const base=`http://127.0.0.1:${port}`,password=crypto.randomBytes(24).toString('hex');
await fs.mkdir(init.folder,{recursive:true,mode:0o700});
const log=await fs.open(path.join(init.folder,'local-service.log'),'a',0o600);
const child=spawn(process.execPath,[path.join(root,'server/index.mjs')],{cwd:root,stdio:['ignore',log.fd,log.fd],env:{
  PATH:process.env.PATH,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:path.join(init.folder,'data'),
  DATABASE_URL:'',REDIS_URL:'',STORAGE_BACKEND:'json',STRUCTURED_WRITES:'true',
  ADMIN_USERNAME:'qa_wecom',ADMIN_PASSWORD:password,SCREEN_MEDIA_AUTH_SECRET:crypto.randomBytes(32).toString('hex'),
  PUBLIC_BASE_URL:base,WINDOWS_AGENT_ONLINE_SECONDS:'120',LOOKUP_AI_VISION_ENABLED:'false'
}});
async function request(method,route,token,body) {
  if (!route.startsWith('/api/v1/')) throw Error('qa_route_invalid');
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(5000)});
  const value=await response.json();
  if (!response.ok) throw Error('qa_local_api_'+response.status+'_'+(/^[a-z0-9_]+$/.test(value.error||'')?value.error:'rejected'));
  return value;
}
let syncTimer;
try {
  let ready=false;
  for(let i=0;i<100;i++) {try{if((await fetch(base+'/readyz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  if(!ready)throw Error('qa_local_platform_not_ready');
  const admin=(await request('POST','/api/v1/auth/login','',{username:'qa_wecom',password})).session.token;
  const agentId='wecom-qa-'+crypto.randomUUID();
  const agent=(await request('POST','/api/v1/windows-agents',admin,{agentId,agentName:'Isolated WeCom fixture'})).token;
  const sync=()=>request('POST',`/api/v1/windows-agents/${agentId}/devices/sync`,agent,
    {agent:{agentId},devices:[{adbSerial:init.serial,state:'device',model:'QA only'}]});
  await sync();await request('PUT','/api/v1/devices/'+encodeURIComponent('adb:'+init.serial),admin,
    {deviceName:init.deviceNumber,listingStatus:'listed'});
  syncTimer=setInterval(()=>sync().catch(()=>{}),5000);
  console.log(JSON.stringify({ready:true,agentId,backend:'isolated_JSON',productionAgent:false}));
  const allowedTasks=new Map();
  for (;;) {
    const line=await input.next();if(line.done)break;
    const q=JSON.parse(line.value);
    try {
      let value;
      if(q.op==='create')value=await request('POST','/api/v1/user/automation/wecom-preview-tasks',admin,
        {deviceId:'adb:'+init.serial,appSlot:q.appSlot,phoneNumber:q.phoneNumber,requestId:q.requestId,
          remarkName:q.remarkName||'QA',description:q.description||'QA',mode:'preview'});
      else if(q.op==='next') {
        value=await request('GET',`/api/v1/windows-agents/${agentId}/tasks/next?wecomPreview=wecom-invitation-v4`,agent);
        if(value.task)allowedTasks.set(value.task.taskId,value.task.payload.automationJobId);
      } else if(q.op==='lease') {
        if(!allowedTasks.has(q.taskId))throw Error('qa_task_not_owned');
        value=await request('GET',`/api/v1/windows-agents/${agentId}/wecom-preview-tasks/${q.taskId}/lease`,agent);
      } else if(q.op==='report') {
        if(!allowedTasks.has(q.taskId)||!['status','events'].includes(q.kind))throw Error('qa_report_scope_invalid');
        value=await request('POST',`/api/v1/windows-agent-tasks/${q.taskId}/${q.kind}`,agent,q.body);
      } else if(q.op==='result')value=await request('GET','/api/v1/user/automation/wecom-preview-tasks/'+encodeURIComponent(q.jobId),admin);
      else if(q.op==='close'){console.log(JSON.stringify({closed:true}));break;}
      else throw Error('qa_op_invalid');
      console.log(JSON.stringify({result:value}));
    } catch(error) {
      console.log(JSON.stringify({error:/^[a-z0-9_]+$/.test(error.message)?error.message:'qa_local_request_failed'}));
    }
  }
} finally {
  clearInterval(syncTimer);
  if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}
  await log.close();
  process.stdin.destroy();
}
