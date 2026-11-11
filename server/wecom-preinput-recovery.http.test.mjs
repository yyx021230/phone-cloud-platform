// Real local HTTP / authentication / file durability. Device/process facts synthetic.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import http from 'node:http';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {recoveryFixture} from './wecom-preinput-recovery-fixture.mjs';import {WECOM_PREVIEW_DEVICES} from './wecom-preview.mjs';import {runWecomPreinputRecovery} from '../windows-agent/src/wecom-preinput-recovery.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));const capabilities='?wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1&wecomPreinputRecovery=wecom-preinput-recovery-v1';
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pc-recovery155-http-')),file=path.join(dir,'state.json'),portHolder=net.createServer().listen(0,'127.0.0.1');await once(portHolder,'listening');const port=portHolder.address().port;await new Promise(r=>portHolder.close(r));
 const upstream=`http://127.0.0.1:${port}`;let child,logs='',drop=false;
 const gateway=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const r=await fetch(upstream+req.url,{method:req.method,headers:{authorization:req.headers.authorization||'','content-type':'application/json'},...(['POST','PUT'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});const bytes=Buffer.from(await r.arrayBuffer());if(drop&&req.url.endsWith('recovery-proof')){drop=false;res.destroy();return;}res.writeHead(r.status,{'content-type':'application/json'});res.end(bytes);}catch{if(!res.destroyed){res.writeHead(502);res.end('{"error":"fixture_gateway"}');}}});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');const base=`http://127.0.0.1:${gateway.address().port}`;
 async function start(){child=spawn(process.execPath,['server/index.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{PATH:process.env.PATH,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,DATABASE_URL:'',REDIS_URL:'',STORAGE_BACKEND:'json',STRUCTURED_WRITES:'true',ADMIN_USERNAME:'fixture_admin',ADMIN_PASSWORD:'fixture-only-password',SCREEN_MEDIA_AUTH_SECRET:'fixture-only-secret',WINDOWS_AGENT_ONLINE_SECONDS:'300',MANAGED_NAME_LOOKUP_ENABLED:'false',LOOKUP_AI_VISION_ENABLED:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs=(logs+b).slice(-4000));child.stderr.on('data',b=>logs=(logs+b).slice(-4000));for(let i=0;i<200;i++){try{if((await fetch(upstream+'/readyz')).ok)return;}catch{}if(child.exitCode!==null)assert.fail('fixture exit '+logs);await pause(20);}assert.fail('fixture startup '+logs);}
 async function stop(){if(child?.exitCode===null){const exit=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),2000);child.kill('SIGTERM');await exit;clearTimeout(timer);}}
 t.after(async()=>{await stop();gateway.closeAllConnections();await new Promise(r=>gateway.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const request=async(method,route,token,body,status=200)=>{const r=await fetch(base+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();assert.equal(r.status,status,JSON.stringify({route,data}));return data;};
 await start();const admin=(await request('POST','/api/v1/auth/login','',{username:'fixture_admin',password:'fixture-only-password'})).session.token;
 const agent=(await request('POST','/api/v1/windows-agents',admin,{agentId:'fixture-agent',agentName:'synthetic'},201)).token;
 const other=(await request('POST','/api/v1/windows-agents',admin,{agentId:'other-agent',agentName:'synthetic other'},201)).token;
 const serial=WECOM_PREVIEW_DEVICES['155'].serial;await request('POST','/api/v1/windows-agents/fixture-agent/devices/sync',agent,{agent:{agentId:'fixture-agent'},devices:[{adbSerial:serial,state:'device',model:'synthetic'}]});
 await stop();const seed=JSON.parse(await fs.readFile(file,'utf8')),f=recoveryFixture();
 const replace=v=>typeof v==='string'?v==='synthetic155'?serial:v==='adb:synthetic155'?'adb:'+serial:v:Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
 seed.deviceLocks=replace(f.state.deviceLocks);seed.windowsTasks=replace(f.state.windowsTasks);seed.automationJobs=replace(f.state.automationJobs);
 await fs.writeFile(file,JSON.stringify(seed));await start();await request('PUT','/api/v1/devices/'+encodeURIComponent('adb:'+serial),admin,{listingStatus:'listed',deviceName:'155'});
 const route='/api/v1/admin/wecom-cleanup/obligation/preinput-recovery',next='/api/v1/windows-agents/fixture-agent/tasks/next',prefix='/api/v1/windows-agents/fixture-agent/wecom-cleanup/obligation/';
 return {request,admin,agent,other,route,next,prefix,base,file,serial,producer:f.request().retiredProducer,drop:()=>drop=true,restart:async()=>{await stop();await start();},snapshot:async()=>JSON.parse(await fs.readFile(file,'utf8'))};
}

test('actual admin/Agent HTTP, rollout gate, empty proof denial, lost ACK and restart preserve original 155 history',{timeout:20000},async t=>{
 const f=await fixture(t),before=await f.snapshot();
 await f.request('GET',f.route,'',undefined,401);await f.request('GET',f.route,f.agent,undefined,401);
 const proposal=await f.request('GET',f.route,f.admin),body={protocol:proposal.protocol,requestId:'maintenance-155',fingerprint:proposal.fingerprint,retiredProducer:f.producer,acknowledgeMaintenance:true};
 await f.request('POST',f.route,f.admin,body,409); // No fresh upgraded Agent poll yet.
 await f.request('GET',f.next+capabilities,f.agent);const accepted=await f.request('POST',f.route,f.admin,body);
 assert.equal((await f.request('POST',f.route,f.admin,body)).taskId,accepted.taskId);
 const oldPoll=await f.request('GET',f.next+'?wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1',f.agent);assert.equal(oldPoll.task,null);
 const task=(await f.request('GET',f.next+capabilities,f.agent)).task;assert.equal(task.taskId,accepted.taskId);
 await f.request('POST','/api/v1/windows-agent-tasks/'+task.taskId+'/status',f.agent,{status:'succeeded'},409);
 await f.request('POST',f.prefix+'recovery-proof',f.other,{},401);await f.request('POST',f.prefix+'recovery-proof',f.agent,{},409);
 const {createCleanupRequest}=await import('../windows-agent/src/wecom-cleanup-protocol.mjs');const config={agentId:'fixture-agent',serverBaseUrl:f.base,agentToken:f.agent};
 f.drop();let calls=0;
 const result=await runWecomPreinputRecovery(task,{config,agentDir:'/synthetic',cleanupRequest:createCleanupRequest(config),prove:async input=>{calls++;return {binding:input.physicalCleanup,verificationId:input.verificationId,verificationNonce:input.verificationNonce,verificationTaskId:input.verificationTaskId,
 challenge:input.challenge,retiredProducer:input.retiredProducer,observer:{...input.retiredProducer,pid:200},snapshots:[1,2].map(i=>({sequence:i,elapsedMs:i*100,observedAt:'2026-11-03T09:00:00.000Z',packagesAbsent:true,packageNames:['com.netease.open.pocoservice','com.netease.open.pocoservice.test'],serialForwardCount:0,producerRetired:true,wecomWorkersAbsent:true}))};}});
 assert.equal(result.verified,true);assert.equal(calls,1);
 const saved=await f.snapshot(),lock=saved.deviceLocks.find(l=>l.lockId==='obligation');assert.equal(lock.status,'released');assert.equal(lock.physicalCleanup.hosts,null);assert.equal(lock.physicalCleanup.hostClosedAt,'');
 assert.deepEqual(saved.automationJobs,before.automationJobs);assert.deepEqual(saved.windowsTasks.find(t=>t.taskId==='original-task'),before.windowsTasks[0]);
 await f.restart();assert.equal((await f.request('POST',f.route,f.admin,body)).reused,true);
 assert.equal((await f.request('POST',f.prefix+'recovery-proof',f.agent,lock.physicalCleanup.recovery.proof)).reused,true);
 assert.equal((await f.request('GET',f.next+capabilities,f.agent)).task,null);
});
