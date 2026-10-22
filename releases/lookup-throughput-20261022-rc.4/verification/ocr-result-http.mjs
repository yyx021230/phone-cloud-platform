// Independent card-result integration: real parser -> Agent status -> persistence -> public HTTP.
// 21 redacted layouts/50 synthetic phones; simulated device transport, no production/ADB/Feishu.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {spawn,spawnSync} from 'node:child_process';import {once} from 'node:events';

import {MANAGED_LOOKUP_PROTOCOL} from '../server/managed-lookup-store.mjs';import {hydrateManagedLookupTask} from '../windows-agent/src/managed-lookup-delivery.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runOcrResultHttp({databaseUrl='',retryAfterMs=65000}={}){
 const root=path.resolve(import.meta.dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-ready-http-'));await fs.cp(path.join(root,'server'),path.join(temp,'server'),{recursive:true,filter:p=>!p.endsWith('.test.mjs')});await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');if(databaseUrl){assert.equal(new URL(databaseUrl).hostname,'127.0.0.1');await fs.cp(path.join(root,'deploy/sql'),path.join(temp,'deploy/sql'),{recursive:true});}

 const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));const base=`http://127.0.0.1:${port}`,admin=crypto.randomUUID(),secret=crypto.randomUUID(),probe='13800000000';let child,worker,run=true,probeCount=0,businessCount=0,starts=0,workerError;const businesses=[],stderr=[],stops=[];
 const apiKey='pclk_'+crypto.randomBytes(32).toString('base64url'), otherKey='pclk_'+crypto.randomBytes(32).toString('base64url'); const clients=[{clientId:'ready-client',secret,username:'ready_user',deviceIds:['adb:READY-51'],apiKeySha256:crypto.createHash('sha256').update(apiKey).digest('hex')},{clientId:'other-client',secret,username:'other_user',deviceIds:['adb:READY-51'],apiKeySha256:crypto.createHash('sha256').update(otherKey).digest('hex')}];
 const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:path.join(temp,'data'),STORAGE_BACKEND:databaseUrl?'postgres':'json',STRUCTURED_WRITES:'true',DATABASE_URL:databaseUrl,REDIS_URL:'',ADMIN_PASSWORD:crypto.randomUUID(),ADMIN_API_TOKEN:admin,WINDOWS_AGENT_TOKEN:crypto.randomUUID(),DEVICE_AGENT_TOKEN:crypto.randomUUID(),SCREEN_MEDIA_AUTH_SECRET:crypto.randomUUID(),OPEN_NAME_LOOKUP_API_ENABLED:'true',MANAGED_NAME_LOOKUP_ENABLED:'true',OPEN_NAME_LOOKUP_CLIENTS_JSON:JSON.stringify(clients),LOOKUP_READINESS_PROBE_PHONE:probe,LOOKUP_HUMAN_FEISHU_WEBHOOK:'',LOOKUP_HUMAN_FEISHU_WEBHOOK_FILE:''};
 const start=async()=>{child=spawn(process.execPath,[path.join(temp,'server/index.mjs')],{cwd:temp,env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>{stderr.push(String(b));if(stderr.length>15)stderr.shift();});for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('server exited:'+stderr.join('').slice(-1000));try{if((await fetch(base+'/readyz')).ok)return;}catch{}await sleep(25);}throw Error('ready timeout');};
 const api=async(method,p,token,body)=>{const res=await fetch(base+p,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),b=await res.json();assert.ok(res.status<300,`${method} ${p}: ${res.status} ${b.error||b.code}`);return b;};
 // The external side uses ordinary HTTP, with no SDK or HMAC.
 const request=async(method,p,body,key,credential=apiKey)=>{
  const res=await fetch(base+p,{method,headers:{'X-API-Key':credential,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();if(!res.ok)throw Object.assign(new Error(data.code||data.error),{status:res.status,code:data.code||data.error,retryAfter:res.headers.get("retry-after"),body:data});return data;
 };
 const a={prepareLookup:o=>request('POST','/api/v1/open/name-lookups/prepare',{},o.idempotencyKey),submitLookup:(phoneNumber,o)=>request('POST','/api/v1/open/name-lookups/tasks',{phoneNumber},o.idempotencyKey),getLookupResult:id=>request('GET','/api/v1/open/name-lookups/tasks/'+id)};
 const preparePublic=async options=>{const p=await a.prepareLookup(options);assert.equal(typeof p.acceptingRequests,'boolean');assert.equal('readyCount' in p,false);if(p.code){assert.equal(p.code,'lookup_no_available_device');assert.equal(p.retryAfterSeconds,30);}assert.equal(p.ready,p.status==='ready');return p;};let token;const account={currentAccount:'synthetic-account',accountIdentityVerified:true,savedAccounts:[{account:'synthetic-account',current:true}]};const parsedResults=new Map();
 const finish=async(t,result={})=>{
  if(t.type==='alipay_name_query'&&t.payload.phoneNumber!==probe){
   const decoded=spawnSync('python3',[path.join(root,'verification/replay-result.py'),t.payload.phoneNumber],{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
   assert.equal(decoded.status,0,'local two-frame result runner failed: '+decoded.stderr.slice(-500));
   result=JSON.parse(decoded.stdout);parsedResults.set(t.payload.phoneNumber,result);
  }
  return api('POST',`/api/v1/windows-agent-tasks/${t.taskId}/status`,token,{status:'succeeded',managedLookupGeneration:t.payload.managedLookup.generation,result:{...account,...result}});
 };
 const inventory={agent:{agentId:'offline-fake',managedLookupProtocol:MANAGED_LOOKUP_PROTOCOL,lookupPostHumanProtocol:1,lookupRuntimeId:crypto.randomUUID(),health:{airtest:{enabled:true,ok:true}}},devices:[51,52,54,55,87].map(n=>({adbSerial:'READY-'+n,state:'device',deviceName:String(n)}))};
 const sync=()=>api('POST','/api/v1/windows-agents/offline-fake/devices/sync',token,inventory);
 const wait=async fn=>{for(let i=0;i<1500;i++){if(workerError)throw workerError;const x=await fn();if(x)return x;await sleep(30);}throw Error('condition timeout');};

 const pool=async()=>(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;
 const pending=[],cleanup=[],protectedPages=new Map();let protectedCooldownAck=false;
 let initialBusiness=true,holdCleanup=true,maxExecuting=0,pauseDelivery=false;
 const rawTask=async(t,suffix,body)=>{const res=await fetch(base+`/api/v1/windows-agent-tasks/${t.taskId}/${suffix}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 function work(){worker=(async()=>{let last=0;while(run){
  if(pauseDelivery){await sleep(20);continue;}
  if(Date.now()-last>2000){await sync();last=Date.now();}
  const response=await api('GET',`/api/v1/windows-agents/offline-fake/tasks/next?managedLookupDelivery=${MANAGED_LOOKUP_PROTOCOL}&activeTaskIds=${encodeURIComponent(pending.map(t=>t.taskId).join(','))}`,token);
  if(response.task){
   const {task:t,acknowledged}=await hydrateManagedLookupTask(response.task,{request:(p,o={})=>api(o.method||'GET',p,token,o.body)});assert.ok(acknowledged);
   maxExecuting=Math.max(maxExecuting,(await pool()).counts.executing);assert.ok(maxExecuting<=5);
   if(t.type==='alipay_name_start'){starts++;await finish(t);}
   else if(t.type==='alipay_name_query'){
    if(t.payload.phoneNumber===probe){probeCount++;await finish(t,{alipayDisplayName:'测*',realNameTailCharacter:'测'});}
    else {if(t.payload.resumeAfterHumanVerification&&t.payload.restartAfterHumanVerification)assert.equal(t.payload.postHumanCheck,true);businessCount++;businesses.push(t);if(initialBusiness)pending.push(t);else if(t.payload.postHumanCheck&&protectedPages.has(t.payload.phoneNumber)){
      const state=protectedPages.get(t.payload.phoneNumber);protectedPages.delete(t.payload.phoneNumber);
      if(state==='account_limited'){
        const ack=await api('POST',`/api/v1/windows-agent-tasks/${t.taskId}/events`,token,{stepId:'lookup_account_limit_confirmed',detail:{currentAccount:account.currentAccount,reason:'frequent_or_abnormal_access',phoneQueryStarted:true,accountSwitchRequired:true,accountIdentityVerified:true}});
        assert.equal(ack.accountCooldown.account,account.currentAccount);assert.equal(Date.parse(ack.accountCooldown.cooldownUntil)-Date.parse(ack.accountCooldown.limitedAt),28800000);protectedCooldownAck=true;
      }
      await api('POST',`/api/v1/windows-agent-tasks/${t.taskId}/status`,token,{status:'failed',managedLookupGeneration:t.payload.managedLookup.generation,result:{...account,errorCode:state==='login_required'?'alipay_login_required':'alipay_prepared_account_limited',diagnostic:{...account,limitReached:state==='account_limited',phoneQueryStarted:true,limitReason:'frequent_or_abnormal_access',accountSwitchRequired:state==='account_limited'}}});
    }else await finish(t,{alipayDisplayName:'接*',realNameTailCharacter:'接'});}
   }else if(t.type==='alipay_name_stop'){stops.push(t);if(holdCleanup&&t.deviceId===pending[0]?.deviceId)cleanup.push(t);else await finish(t);}
   else throw Error('unexpected simulated task type');
  }
  await sleep(20);
 }})().catch(e=>{workerError=e;});}
 const stopPublic=(p,key)=>request('POST','/api/v1/open/name-lookups/stop',{preparationId:p.preparationId},key);
 try{
  await start();await api('POST','/api/v1/users',admin,{username:'ready_user',password:crypto.randomUUID(),role:'user'});
  const helperPassword=crypto.randomUUID();
  const helperUser=(await api('POST','/api/v1/users',admin,{username:'human_helper',password:helperPassword})).user;
  const helperToken=(await api('POST','/api/v1/auth/login','',{username:'human_helper',password:helperPassword})).session.token;
  ({token}=await api('POST','/api/v1/windows-agents',admin,{agentId:'offline-fake'}));await sync();
  for(const n of [51,52,54,55,87])await api('PUT','/api/v1/devices/'+encodeURIComponent('adb:READY-'+n),admin,{deviceName:String(n),listingStatus:'listed'});
  const preview=(await api('POST','/api/v1/admin/lookup-pool/preview',admin,{})).devices.filter(d=>d.matches===1);
  await api('PUT','/api/v1/admin/lookup-pool',admin,{enabled:true,concurrency:5,asyncQueueWaitMs:60000,asyncTaskTtlMs:300000,preparedClientInflightLimit:100,devices:preview.map(d=>({...d,enabled:true})),grants:[{clientId:'ready-client',enabled:true,consentReference:'synthetic-consent'}]});
  const preparation=await preparePublic({idempotencyKey:'worker-round'});await assert.rejects(a.submitLookup('13900000000',{idempotencyKey:'before-first-ready'}),e=>e.code==='lookup_not_ready');work();
  await wait(async()=>(await pool()).channels.filter(c=>c.phase==='idle').length===5&&(await preparePublic({idempotencyKey:'worker-round'})).ready);
  pauseDelivery=true;await sleep(100);
  const requests=await Promise.all(Array.from({length:50},(_,i)=>a.submitLookup('13900000'+String(i).padStart(3,'0'),{idempotencyKey:'worker-business-'+i})));
  for(const d of inventory.devices)d.state='offline';await sync();
  await wait(async()=>(await pool()).devices.every(d=>!d.health.ready));
  assert.equal((await preparePublic({idempotencyKey:'worker-round'})).ready,true);
  const paused=await preparePublic({idempotencyKey:'worker-round'});assert.equal(paused.acceptingRequests,false);assert.equal(paused.code,'lookup_no_available_device');
  const beforeReject=(await pool()).requests.length;
  await Promise.all(Array.from({length:30},(_,i)=>assert.rejects(a.submitLookup('13900001'+String(i).padStart(3,'0'),{idempotencyKey:'rejected-burst-'+i}),e=>e.status===503&&e.code==='lookup_no_available_device'&&e.retryAfter==='30'&&e.body.accepted===false&&!e.body.lookupId)));assert.equal((await pool()).requests.length,beforeReject);
  assert.equal(businesses.length,0);assert.ok((await Promise.all(requests.map(r=>a.getLookupResult(r.lookupId)))).every(r=>!('name' in r)&&(r.status==='processing'||r.status==='queued'&&r.code==='lookup_no_available_device'&&r.retryAfterSeconds===30)));
  assert.equal((await a.submitLookup('13900000000',{idempotencyKey:'zero-ready-retry'})).lookupId,requests[0].lookupId);
  for(const d of inventory.devices)d.state='device';await sync();pauseDelivery=false;
  await wait(()=>pending.length===5);assert.equal(maxExecuting,5);initialBusiness=false;
  const bad=pending[0],original=requests[Number(bad.payload.phoneNumber.slice(-3))];assert.ok(original,'synthetic phone maps to submitted request');
  const originalBudget=(await pool()).requests.find(r=>r.lookupId===original.lookupId);
  const failedAt=Date.now();
  await api('POST',`/api/v1/windows-agent-tasks/${bad.taskId}/status`,token,{status:'failed',managedLookupGeneration:bad.payload.managedLookup.generation,result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:'poco_query_page_recovery_failed: synthetic worker exited during verify_worker_adb_transport'}}});
  await wait(()=>cleanup.length===1);
  assert.equal((await a.getLookupResult(original.lookupId)).status,'processing');
  const human=pending[1];
  await api('POST',`/api/v1/windows-agent-tasks/${human.taskId}/status`,token,{status:'failed',managedLookupGeneration:human.payload.managedLookup.generation,result:{...account,errorCode:'alipay_human_verification_required',diagnostic:{limitReason:'jigsaw_verification'}}});
  await wait(async()=>(await pool()).channels.some(c=>c.deviceId===human.deviceId&&c.phase==='human'));
  const helperCard=async()=>(await api('GET','/api/v1/user/devices',helperToken)).devices.find(d=>d.deviceId===human.deviceId);
  assert.equal((await helperCard()).screenControlConcurrentLookupAllowed,false);
  const updated=(await api('PUT','/api/v1/users/'+helperUser.userId,admin,{lookupHumanControl:true})).user;
  assert.equal(updated.role,'user');assert.equal(updated.lookupHumanControl,true);
  assert.equal((await helperCard()).screenControlConcurrentLookupAllowed,true);
  const busyHelper=(await api('GET','/api/v1/user/devices',helperToken)).devices.find(d=>d.deviceId===pending[3].deviceId);
  assert.equal(busyHelper.screenControlConcurrentLookupAllowed,false);
  const escalation=await fetch(base+'/api/v1/users/'+helperUser.userId,{method:'PUT',headers:{Authorization:'Bearer '+helperToken,'Content-Type':'application/json'},body:JSON.stringify({lookupHumanControl:true,role:'admin'})});assert.equal(escalation.status,401);
  await api('PUT','/api/v1/users/'+helperUser.userId,admin,{lookupHumanControl:false});assert.equal((await helperCard()).screenControlConcurrentLookupAllowed,false);
  const cardPath='/api/v1/lookup-card-statuses';
  assert.equal((await api('GET',cardPath,admin)).statuses.find(x=>x.deviceId===human.deviceId).lookup.state,'human_required');
  const unauthorized=await fetch(base+cardPath);assert.equal(unauthorized.status,401);
  const observerPath='/api/v1/windows-agents/offline-fake/lookup-human-verifications';
  const observe=async(state='search_ready')=>{const p=(await api('GET',observerPath,token)).probes.find(x=>x.deviceId===human.deviceId);assert.ok(p);return api('POST',observerPath,token,{probeId:p.probeId,state,reason:state==='screen_off'?'screen_off':'search_ready',readDurationMs:125});};
  await observe('screen_off');
  assert.equal((await api('GET',cardPath,admin)).statuses.find(x=>x.deviceId===human.deviceId).lookup.state,'screen_off');
  assert.equal((await pool()).channels.find(c=>c.deviceId===human.deviceId).humanObservation.readDurationMs,125);
  assert.equal(businesses.some(t=>t.deviceId===human.deviceId&&t.payload.resumeAfterHumanVerification),false);
  inventory.agent.lookupPostHumanProtocol=0;await sync();
  await sleep(25);await observe();
  assert.equal((await api('GET',cardPath,admin)).statuses.find(x=>x.deviceId===human.deviceId).lookup.state,'checking');
  await sleep(2100);await observe();await sleep(300);assert.equal(businesses.some(t=>t.deviceId===human.deviceId&&t.payload.postHumanCheck),false,'old Agent cannot execute new guard');
  inventory.agent.lookupPostHumanProtocol=1;await sync();
  await wait(()=>businesses.some(t=>t.deviceId===human.deviceId&&t.payload.resumeAfterHumanVerification));
  const page=pending[2];
  await api('POST',`/api/v1/windows-agent-tasks/${page.taskId}/status`,token,{status:'failed',managedLookupGeneration:page.payload.managedLookup.generation,result:{...account,errorCode:'alipay_lookup_result_unconfirmed',diagnostic:{runnerReason:'local_lookup_result_unconfirmed:observation_budget_exhausted'}}});
  await wait(()=>businesses.some(t=>t.payload.phoneNumber===page.payload.phoneNumber&&t.taskId!==page.taskId));
  const pageResume=businesses.find(t=>t.payload.phoneNumber===page.payload.phoneNumber&&t.taskId!==page.taskId);
  assert.equal(pageResume.deviceId,page.deviceId);assert.equal(pageResume.payload.preparedLookup.observationOnlyResume,true);assert.equal(pageResume.payload.resumeAfterHumanVerification,true);assert.equal(pageResume.payload.restartAfterHumanVerification,false);
  for(const [i,state] of [[3,'account_limited'],[4,'login_required']]){
    const t=pending[i];protectedPages.set(t.payload.phoneNumber,state);
    await api('POST',`/api/v1/windows-agent-tasks/${t.taskId}/status`,token,{status:'failed',managedLookupGeneration:t.payload.managedLookup.generation,result:{...account,errorCode:'alipay_human_verification_required'}});
    await wait(async()=>(await pool()).channels.some(c=>c.deviceId===t.deviceId&&c.phase==='human'));
    const observed=async()=>{const p=(await api('GET',observerPath,token)).probes.find(p=>p.deviceId===t.deviceId);assert.ok(p);return api('POST',observerPath,token,{probeId:p.probeId,state,reason:state,readDurationMs:100});};
    await observed();assert.equal((await api('GET',cardPath,admin)).statuses.find(x=>x.deviceId===t.deviceId).lookup.state,state==='login_required'?'login_required':'switching');
    await sleep(2100);await observed();
    await wait(()=>businesses.filter(b=>b.payload.phoneNumber===t.payload.phoneNumber).length===3).catch(async error=>{const x=await pool();console.error(JSON.stringify({state,attempts:businesses.filter(b=>b.payload.phoneNumber===t.payload.phoneNumber).map(b=>({device:b.deviceId,guard:b.payload.postHumanCheck})),channels:x.channels.map(c=>({device:c.deviceId,phase:c.phase})),requests:x.requests.filter(r=>r.phoneNumber===t.payload.phoneNumber).map(r=>({status:r.status,code:r.code}))}));throw error;});
    const attempts=businesses.filter(b=>b.payload.phoneNumber===t.payload.phoneNumber);
    assert.equal(attempts[1].deviceId,t.deviceId);assert.equal(attempts[1].payload.postHumanCheck,true);assert.notEqual(attempts[2].deviceId,t.deviceId);
    const originalRequest=requests[Number(t.payload.phoneNumber.slice(-3))];assert.equal((await a.submitLookup(t.payload.phoneNumber,{idempotencyKey:'protected-retry-'+state})).lookupId,originalRequest.lookupId);
    await wait(async()=>(await a.getLookupResult(originalRequest.lookupId)).status==='completed');
    if(state==='login_required')assert.ok((await pool()).devices.find(d=>d.deviceId===t.deviceId).accountOffline);
   }
   assert.equal(protectedCooldownAck,true);
  await wait(async()=>(await Promise.all(requests.filter(r=>r.lookupId!==original.lookupId).map(r=>a.getLookupResult(r.lookupId)))).every(r=>r.status==='completed'));
  const remaining=retryAfterMs-(Date.now()-failedAt);if(remaining>0)await sleep(remaining);if(workerError)throw workerError;
  const retryElapsedMs=Date.now()-failedAt;
  const alias=await a.submitLookup(bad.payload.phoneNumber,{idempotencyKey:'timeout-new-key'});assert.equal(alias.lookupId,original.lookupId);
  assert.equal((await a.getLookupResult(original.lookupId)).status,'processing');
  assert.equal(businesses.filter(t=>t.payload.phoneNumber===bad.payload.phoneNumber).length,1,'no replay before real stop ACK');
  assert.ok(Date.now()>originalBudget.deadline,'the first-queue deadline must really have elapsed');
  holdCleanup=false;await finish(cleanup[0]);
  await wait(async()=>(await a.getLookupResult(original.lookupId)).status==='completed');
  const attempts=businesses.filter(t=>t.payload.phoneNumber===bad.payload.phoneNumber);assert.equal(attempts.length,2);assert.notEqual(attempts[1].deviceId,bad.deviceId);
  const finalBudget=(await pool()).requests.find(r=>r.lookupId===original.lookupId);
  assert.equal(finalBudget.deadline,originalBudget.executionDeadline);assert.equal(finalBudget.executionDeadline,originalBudget.executionDeadline);
  assert.equal(businesses.length,57);const completed=await a.getLookupResult(original.lookupId);assert.equal(completed.name,parsedResults.get(bad.payload.phoneNumber).notFound?'':parsedResults.get(bad.payload.phoneNumber).alipayDisplayName);
  assert.equal(parsedResults.size,50);
  const all=await Promise.all(requests.map(r=>a.getLookupResult(r.lookupId)));
  for(let i=0;i<50;i++){
   const expected=parsedResults.get('13900000'+String(i).padStart(3,'0'));
   assert.equal(all[i].status,'completed');
   assert.equal(all[i].name,expected.notFound?'':expected.alipayDisplayName,'parsed card must survive HTTP unchanged');
  }
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
  return {parsedCardLayouts:21,parsedBusinessResults:50,namedResults:[...parsedResults.values()].filter(r=>!r.notFound).length,emptyResults:[...parsedResults.values()].filter(r=>r.notFound).length,allParsedResultsMatchPublicHttp:true,storage:databaseUrl?'postgres':'json',loopbackOnly:true,simulatedDevices:5,realDevices:0,productionConnections:0,completed:50,zeroReadyRejects30NewRequests:true,zeroReadyRetains50AcceptedRequests:true,unavailableRetryHeader30:true,zeroReadyDispatched:0,firstReadyStillRequired:true,businessAttempts:57,oldAgentGuardBlocked:true,postHumanLimitDurableCooldown:true,postHumanLoginRoundExcluded:true,protectedOriginalQueryCrossDevice:true,helperGrantRevokeHttp:true,helperCannotEscalate:true,helperOnlyHumanCard:true,pageSamePhoneObservationPayload:true,maxExecuting,humanObserverHttpResumed:true,screenOffCardVerified:true,firstClearRequiresRecheck:true,cardEndpointAuthenticated:true,otherRequestsCompleteBeforeStopAck:49,retryElapsedMs,firstQueueDeadlineElapsed:true,originalTotalDeadlinePreserved:true,changedKeyKeepsOriginalId:true,noLocalReplay:true,handoffWaitsForStopAck:true,reassignedToDifferentPhone:true,lateReportIgnored:true,restartRetainsResultAndAlias:true,nextRoundReady:true,finalChannels:(await pool()).channels.length};
 }finally{run=false;await worker?.catch(()=>{});if(child?.exitCode===null){const ex=once(child,'exit');child.kill('SIGTERM');const t=setTimeout(()=>child.kill('SIGKILL'),2500);await ex;clearTimeout(t);}await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&await fs.realpath(process.argv[1])===import.meta.filename)console.log(JSON.stringify(await runOcrResultHttp({databaseUrl:process.env.MANAGED_LOOKUP_TEST_DATABASE_URL||'',retryAfterMs:Number(process.env.WORKER_TEST_RETRY_MS||65000)})));
