// Actual loopback HTTP/API Key and five simulated devices. No production, Agent, ADB or Feishu.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';

import {MANAGED_LOOKUP_PROTOCOL} from '../server/managed-lookup-store.mjs';import {hydrateManagedLookupTask} from '../windows-agent/src/managed-lookup-delivery.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runSchedulingHttp({databaseUrl='',retryAfterMs=0}={}){
 const root=path.resolve(import.meta.dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-ready-http-'));await fs.cp(path.join(root,'server'),path.join(temp,'server'),{recursive:true,filter:p=>!p.endsWith('.test.mjs')});await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');if(databaseUrl){assert.equal(new URL(databaseUrl).hostname,'127.0.0.1');await fs.cp(path.join(root,'deploy/sql'),path.join(temp,'deploy/sql'),{recursive:true});}

 const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));const base=`http://127.0.0.1:${port}`,admin=crypto.randomUUID(),secret=crypto.randomUUID(),probe='13800000000';let child,worker,run=true,probeCount=0,businessCount=0,starts=0,workerError;const businesses=[],stderr=[],stops=[];
 const apiKey='pclk_'+crypto.randomBytes(32).toString('base64url'), otherKey='pclk_'+crypto.randomBytes(32).toString('base64url'); const clients=[{clientId:'ready-client',secret,username:'ready_user',deviceIds:['adb:READY-51'],apiKeySha256:crypto.createHash('sha256').update(apiKey).digest('hex')},{clientId:'other-client',secret,username:'other_user',deviceIds:['adb:READY-51'],apiKeySha256:crypto.createHash('sha256').update(otherKey).digest('hex')}];
 const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:path.join(temp,'data'),STORAGE_BACKEND:databaseUrl?'postgres':'json',STRUCTURED_WRITES:'true',DATABASE_URL:databaseUrl,REDIS_URL:'',ADMIN_PASSWORD:crypto.randomUUID(),ADMIN_API_TOKEN:admin,WINDOWS_AGENT_TOKEN:crypto.randomUUID(),DEVICE_AGENT_TOKEN:crypto.randomUUID(),SCREEN_MEDIA_AUTH_SECRET:crypto.randomUUID(),OPEN_NAME_LOOKUP_API_ENABLED:'true',MANAGED_NAME_LOOKUP_ENABLED:'true',OPEN_NAME_LOOKUP_CLIENTS_JSON:JSON.stringify(clients),LOOKUP_READINESS_PROBE_PHONE:probe,LOOKUP_HUMAN_FEISHU_WEBHOOK:'',LOOKUP_HUMAN_FEISHU_WEBHOOK_FILE:''};
 const start=async()=>{child=spawn(process.execPath,[path.join(temp,'server/index.mjs')],{cwd:temp,env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>{stderr.push(String(b));if(stderr.length>15)stderr.shift();});for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('server exited:'+stderr.join('').slice(-1000));try{if((await fetch(base+'/readyz')).ok)return;}catch{}await sleep(25);}throw Error('ready timeout');};
 const api=async(method,p,token,body)=>{const res=await fetch(base+p,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),b=await res.json();assert.ok(res.status<300,`${method} ${p}: ${res.status} ${b.error||b.code}`);return b;};
 // The external side uses ordinary HTTP, with no SDK or HMAC.
 const request=async(method,p,body,key,credential=apiKey)=>{
  const res=await fetch(base+p,{method,headers:{'X-API-Key':credential,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();if(!res.ok)throw Object.assign(new Error(data.code||data.error),{status:res.status,code:data.code||data.error});return data;
 };
 const a={prepareLookup:o=>request('POST','/api/v1/open/name-lookups/prepare',{},o.idempotencyKey),submitLookup:(phoneNumber,o)=>request('POST','/api/v1/open/name-lookups/tasks',{phoneNumber},o.idempotencyKey),getLookupResult:id=>request('GET','/api/v1/open/name-lookups/tasks/'+id)};
 const preparePublic=async options=>{const p=await a.prepareLookup(options);assert.deepEqual(Object.keys(p).sort(),['expiresAt','ok','preparationId','ready','status']);assert.equal(p.ready,p.status==='ready');return p;};let token;const account={currentAccount:'synthetic-account',accountIdentityVerified:true,savedAccounts:[{account:'synthetic-account',current:true}]};const finish=(t,result={})=>api('POST',`/api/v1/windows-agent-tasks/${t.taskId}/status`,token,{status:'succeeded',managedLookupGeneration:t.payload.managedLookup.generation,result:{...account,...result}});
 const inventory={agent:{agentId:'offline-fake',managedLookupProtocol:MANAGED_LOOKUP_PROTOCOL,lookupRuntimeId:crypto.randomUUID(),health:{airtest:{enabled:true,ok:true}}},devices:[51,52,54,55,87].map(n=>({adbSerial:'READY-'+n,state:'device',deviceName:String(n)}))};
 const sync=()=>api('POST','/api/v1/windows-agents/offline-fake/devices/sync',token,inventory);
 const wait=async fn=>{for(let i=0;i<1500;i++){if(workerError)throw workerError;const x=await fn();if(x)return x;await sleep(30);}throw Error('condition timeout');};

 const pool=async()=>(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;
 const pending=[],cleanup=[];
 let initialBusiness=true,holdCleanup=true,maxExecuting=0;
 const rawTask=async(t,suffix,body)=>{const res=await fetch(base+`/api/v1/windows-agent-tasks/${t.taskId}/${suffix}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 function work(){worker=(async()=>{let last=0;while(run){
  if(Date.now()-last>2000){await sync();last=Date.now();}
  const response=await api('GET',`/api/v1/windows-agents/offline-fake/tasks/next?managedLookupDelivery=${MANAGED_LOOKUP_PROTOCOL}&activeTaskIds=${encodeURIComponent(pending.map(t=>t.taskId).join(','))}`,token);
  if(response.task){
   const {task:t,acknowledged}=await hydrateManagedLookupTask(response.task,{request:(p,o={})=>api(o.method||'GET',p,token,o.body)});assert.ok(acknowledged);
   maxExecuting=Math.max(maxExecuting,(await pool()).counts.executing);assert.ok(maxExecuting<=5);
   if(t.type==='alipay_name_start'){starts++;await finish(t);}
   else if(t.type==='alipay_name_query'){
    if(t.payload.phoneNumber===probe){probeCount++;await finish(t,{alipayDisplayName:'测*',realNameTailCharacter:'测'});}
    else {businessCount++;businesses.push(t);if(initialBusiness)pending.push(t);else await finish(t,{alipayDisplayName:'接*',realNameTailCharacter:'接'});}
   }else if(t.type==='alipay_name_stop'){stops.push(t);if(holdCleanup&&t.deviceId===pending[0]?.deviceId)cleanup.push(t);else await finish(t);}
   else throw Error('unexpected simulated task type');
  }
  await sleep(20);
 }})().catch(e=>{workerError=e;});}
 const stopPublic=(p,key)=>request('POST','/api/v1/open/name-lookups/stop',{preparationId:p.preparationId},key);
 try{
  await start();await api('POST','/api/v1/users',admin,{username:'ready_user',password:crypto.randomUUID(),role:'user'});
  ({token}=await api('POST','/api/v1/windows-agents',admin,{agentId:'offline-fake'}));await sync();
  for(const n of [51,52,54,55,87])await api('PUT','/api/v1/devices/'+encodeURIComponent('adb:READY-'+n),admin,{deviceName:String(n),listingStatus:'listed'});
  const preview=(await api('POST','/api/v1/admin/lookup-pool/preview',admin,{})).devices.filter(d=>d.matches===1);
  await api('PUT','/api/v1/admin/lookup-pool',admin,{enabled:true,concurrency:5,preparedClientInflightLimit:100,devices:preview.map(d=>({...d,enabled:true})),grants:[{clientId:'ready-client',enabled:true,consentReference:'synthetic-consent'}]});
  const preparation=await preparePublic({idempotencyKey:'worker-round'});work();
  await wait(async()=>(await pool()).channels.filter(c=>c.phase==='idle').length===5&&(await preparePublic({idempotencyKey:'worker-round'})).ready);
  const requests=await Promise.all(Array.from({length:50},(_,i)=>a.submitLookup('13900000'+String(i).padStart(3,'0'),{idempotencyKey:'worker-business-'+i})));
  await wait(()=>pending.length===5);assert.equal(maxExecuting,5);initialBusiness=false;
  const bad=pending[0],original=requests[Number(bad.payload.phoneNumber.slice(-3))];assert.ok(original,'synthetic phone maps to submitted request');
  const failedAt=Date.now();
  await api('POST',`/api/v1/windows-agent-tasks/${bad.taskId}/status`,token,{status:'failed',managedLookupGeneration:bad.payload.managedLookup.generation,result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:'poco_query_page_recovery_failed: synthetic worker exited during verify_worker_adb_transport'}}});
  await wait(()=>cleanup.length===1);
  assert.equal((await a.getLookupResult(original.lookupId)).status,'processing');
  const human=pending[1];
  await api('POST',`/api/v1/windows-agent-tasks/${human.taskId}/status`,token,{status:'failed',managedLookupGeneration:human.payload.managedLookup.generation,result:{...account,errorCode:'alipay_human_verification_required',diagnostic:{limitReason:'jigsaw_verification'}}});
  await wait(async()=>(await pool()).channels.some(c=>c.deviceId===human.deviceId&&c.phase==='human'));
  const cardPath='/api/v1/lookup-card-statuses';
  assert.equal((await api('GET',cardPath,admin)).statuses.find(x=>x.deviceId===human.deviceId).lookup.state,'human_required');
  const unauthorized=await fetch(base+cardPath);assert.equal(unauthorized.status,401);
  const observerPath='/api/v1/windows-agents/offline-fake/lookup-human-verifications';
  const observe=async(state='search_ready')=>{const p=(await api('GET',observerPath,token)).probes.find(x=>x.deviceId===human.deviceId);assert.ok(p);return api('POST',observerPath,token,{probeId:p.probeId,state,reason:state==='screen_off'?'screen_off':'search_ready',readDurationMs:125});};
  await observe('screen_off');
  assert.equal((await api('GET',cardPath,admin)).statuses.find(x=>x.deviceId===human.deviceId).lookup.state,'screen_off');
  assert.equal((await pool()).channels.find(c=>c.deviceId===human.deviceId).humanObservation.readDurationMs,125);
  assert.equal(businesses.some(t=>t.deviceId===human.deviceId&&t.payload.resumeAfterHumanVerification),false);
  await sleep(25);await observe();
  assert.equal((await api('GET',cardPath,admin)).statuses.find(x=>x.deviceId===human.deviceId).lookup.state,'checking');
  await sleep(2100);await observe();
  await wait(()=>businesses.some(t=>t.deviceId===human.deviceId&&t.payload.resumeAfterHumanVerification));
  for(const t of pending.slice(2))await finish(t,{alipayDisplayName:'另*',realNameTailCharacter:'另'});
  await wait(async()=>(await Promise.all(requests.filter(r=>r.lookupId!==original.lookupId).map(r=>a.getLookupResult(r.lookupId)))).every(r=>r.status==='completed'));
  const remaining=retryAfterMs-(Date.now()-failedAt);if(remaining>0)await sleep(remaining);if(workerError)throw workerError;
  const retryElapsedMs=Date.now()-failedAt;
  const alias=await a.submitLookup(bad.payload.phoneNumber,{idempotencyKey:'timeout-new-key'});assert.equal(alias.lookupId,original.lookupId);
  assert.equal((await a.getLookupResult(original.lookupId)).status,'processing');
  assert.equal(businesses.filter(t=>t.payload.phoneNumber===bad.payload.phoneNumber).length,1,'no replay before real stop ACK');
  holdCleanup=false;await finish(cleanup[0]);
  await wait(async()=>(await a.getLookupResult(original.lookupId)).status==='completed');
  const attempts=businesses.filter(t=>t.payload.phoneNumber===bad.payload.phoneNumber);assert.equal(attempts.length,2);assert.notEqual(attempts[1].deviceId,bad.deviceId);
  assert.equal(businesses.length,52);const completed=await a.getLookupResult(original.lookupId);assert.equal(completed.name,'接*');
  const late=await rawTask(bad,'status',{status:'succeeded',managedLookupGeneration:bad.payload.managedLookup.generation,result:{...account,alipayDisplayName:'迟*'}});assert.equal(late.body.ignored,true);
  assert.deepEqual(await a.getLookupResult(original.lookupId),completed);
  await stopPublic(preparation,'worker-stop');await wait(async()=>(await stopPublic(preparation,'worker-stop')).stopped);assert.equal((await pool()).channels.length,0);
  run=false;await worker;if(workerError)throw workerError;const ex=once(child,'exit');child.kill('SIGTERM');await ex;
  await start();await sync();assert.deepEqual(await a.getLookupResult(original.lookupId),completed);
  assert.equal((await a.submitLookup(bad.payload.phoneNumber,{idempotencyKey:'timeout-new-key'})).lookupId,original.lookupId);
  const next=await preparePublic({idempotencyKey:'worker-next-round'});assert.notEqual(next.preparationId,preparation.preparationId);run=true;work();
  await wait(async()=>(await preparePublic({idempotencyKey:'worker-next-round'})).ready);
  await stopPublic(next,'worker-next-stop');await wait(async()=>(await stopPublic(next,'worker-next-stop')).stopped);
  assert.doesNotMatch(stderr.join(''),/fatal|SyntaxError|unhandled/i);
  return {storage:databaseUrl?'postgres':'json',loopbackOnly:true,simulatedDevices:5,realDevices:0,productionConnections:0,completed:50,businessAttempts:52,maxExecuting,humanObserverHttpResumed:true,screenOffCardVerified:true,firstClearRequiresRecheck:true,cardEndpointAuthenticated:true,otherRequestsCompleteBeforeStopAck:49,retryElapsedMs,changedKeyKeepsOriginalId:true,noLocalReplay:true,handoffWaitsForStopAck:true,reassignedToDifferentPhone:true,lateReportIgnored:true,restartRetainsResultAndAlias:true,nextRoundReady:true,finalChannels:(await pool()).channels.length};
 }finally{run=false;await worker?.catch(()=>{});if(child?.exitCode===null){const ex=once(child,'exit');child.kill('SIGTERM');const t=setTimeout(()=>child.kill('SIGKILL'),2500);await ex;clearTimeout(t);}await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&await fs.realpath(process.argv[1])===import.meta.filename)console.log(JSON.stringify(await runSchedulingHttp({databaseUrl:process.env.MANAGED_LOOKUP_TEST_DATABASE_URL||'',retryAfterMs:Number(process.env.WORKER_TEST_RETRY_MS||0)})));
