// Local-only real platform + batch API harness. No production credentials or Agent.
import fs from 'node:fs/promises';import path from 'node:path';import http from 'node:http';
import {once} from 'node:events';import {spawn} from 'node:child_process';import crypto from 'node:crypto';import readline from 'node:readline';
import pg from 'pg';import {signRequest} from '../../server/xhs-batch/http.mjs';
const root=path.resolve(import.meta.dirname,'../..'),cfg=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const folder=path.dirname(process.argv[2]);
const freePort=async()=>{const s=http.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const platformPort=await freePort(),batchPort=await freePort(),base=`http://127.0.0.1:${platformPort}`,batchBase=`http://127.0.0.1:${batchPort}`;
const password=crypto.randomBytes(24).toString('hex'),secret=crypto.randomBytes(32).toString('hex'),clientId='candidate-'+crypto.randomUUID();
const env={PATH:process.env.PATH,HOST:'127.0.0.1',PORT:String(platformPort),DATA_DIR:path.join(folder,'platform'),DATABASE_URL:'',STORAGE_BACKEND:'json',REDIS_URL:'',ADMIN_USERNAME:'qa_admin',ADMIN_PASSWORD:password,SCREEN_MEDIA_AUTH_SECRET:secret,PUBLIC_BASE_URL:base,WINDOWS_AGENT_ONLINE_SECONDS:'120'};
await fs.mkdir(env.DATA_DIR,{recursive:true});
const log=await fs.open(path.join(folder,'local-services.log'),'a',0o600);
const platform=spawn(process.execPath,[path.join(root,'server/index.mjs')],{cwd:root,env,stdio:['ignore',log.fd,log.fd]});
const wait=async url=>{for(let n=0;n<100;n++){try{if((await fetch(url+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('local_service_start_failed');};
const req=async(method,route,token,body)=>{const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error('local_api_'+r.status+'_'+j.error);return j;};
await wait(base);
const admin=(await req('POST','/api/v1/auth/login','',{username:'qa_admin',password})).session.token;
await req('POST','/api/v1/users',admin,{username:'qa_xhs',password,role:'user',enabled:true});
const agentId='isolated-xhs-qa';
const agent=(await req('POST','/api/v1/windows-agents',admin,{agentId,agentName:'Isolated candidate adapter'})).token;
const sync=()=>req('POST',`/api/v1/windows-agents/${agentId}/devices/sync`,agent,{agent:{agentId,health:{xhsDataCollect:{protocol:'xhs_data_collect_v1',ready:true}}},devices:cfg.targets.map(t=>({adbSerial:t.serial,state:'device',model:t.model,automation:{ok:false,xhsInstalled:true}}))});
await sync();const devices=(await req('GET','/api/v1/devices',admin)).devices;
const targets=[];
for(const t of cfg.targets){const d=devices.find(d=>d.adb?.serial===t.serial);if(!d)throw Error('local_target_missing');await req('PUT',`/api/v1/devices/${d.deviceId}`,admin,{listingStatus:'listed',deviceName:t.deviceName});await req('PUT',`/api/v1/devices/${d.deviceId}/xhs-accounts`,admin,{accounts:[{appSlot:t.appSlot,label:'QA',xhsId:t.xhsId,accountName:t.accountName,enabled:true}]});targets.push({deviceId:d.deviceId,appSlot:t.appSlot,xhsId:t.xhsId,accountName:t.accountName});}
const db=new URL(cfg.databaseUrl);if(db.hostname!=='127.0.0.1'||!db.pathname.startsWith('/xhs_batch_test_'))throw Error('isolated_database_required');
const pool=new pg.Pool({connectionString:cfg.databaseUrl});await pool.query(await fs.readFile(path.join(root,'deploy/xhs-batch/schema.sql'),'utf8'));await pool.end();
const configFile=path.join(folder,'batch-private.json');await fs.writeFile(configFile,JSON.stringify({platformBaseUrl:base,clients:[{clientId,secret,username:'qa_xhs',password,targets}]}),{mode:0o600});
let batch;
async function bootBatch(){batch=spawn(process.execPath,[path.join(root,'server/xhs-batch/main.mjs')],{cwd:root,env:{PATH:process.env.PATH,XHS_BATCH_CONFIG_FILE:configFile,XHS_BATCH_DATABASE_URL:cfg.databaseUrl,XHS_BATCH_PORT:String(batchPort)},stdio:['ignore',log.fd,log.fd]});await wait(batchBase);}
await bootBatch();
const tick=setInterval(()=>sync().catch(()=>{}),5000);
const signed=async(method,target,body)=>{const text=body===undefined?'':JSON.stringify(body),stamp=String(Date.now()),nonce=crypto.randomUUID();const r=await fetch(batchBase+target,{method,headers:{'content-type':'application/json','x-client-id':clientId,'x-timestamp':stamp,'x-nonce':nonce,'x-signature':signRequest(secret,method,target,stamp,nonce,text)},body:text||undefined});const j=await r.json();if(!r.ok)throw Error('batch_api_'+r.status+'_'+j.error);return j;};
const stop=async p=>{if(p&&p.exitCode===null){const done=once(p,'exit');p.kill();await done;}};
console.log(JSON.stringify({ready:true,targets:targets.length}));
try{for await(const line of readline.createInterface({input:process.stdin})){
  const q=JSON.parse(line);let result;
  try{
    if(q.op==='create')result=await signed('POST','/api/v1/open/xhs-data/batches',{requestId:q.requestId});
    else if(q.op==='next')result=await req('GET',`/api/v1/windows-agents/${agentId}/tasks/next`,agent);
    else if(q.op==='complete')result=await req('POST',`/api/v1/windows-agent-tasks/${q.taskId}/status`,agent,q.payload);
    else if(q.op==='result')result=await signed('GET',`/api/v1/open/xhs-data/batches/${q.runId}?limit=1&offset=${q.offset||0}`);
    else if(q.op==='restart'){await stop(batch);await bootBatch();result={restarted:true};}
    else if(q.op==='stop')result=await signed('POST',`/api/v1/open/xhs-data/batches/${q.runId}/stop`,{});
    else if(q.op==='close'){console.log(JSON.stringify({closed:true}));break;}
    else throw Error('unknown_harness_command');
    console.log(JSON.stringify({result}));
  }catch(e){console.log(JSON.stringify({error:e.message}));}
}}finally{clearInterval(tick);await stop(batch);await stop(platform);await log.close();}
