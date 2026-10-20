// Actual loopback HTTP/API Key and five simulated devices. No production, Agent, ADB or Feishu.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';

import {MANAGED_LOOKUP_PROTOCOL} from '../server/managed-lookup-store.mjs';import {hydrateManagedLookupTask} from '../windows-agent/src/managed-lookup-delivery.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runOfflineRoundHttp({databaseUrl=''}={}){
 const root=path.resolve(import.meta.dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-ready-http-'));await fs.cp(path.join(root,'server'),path.join(temp,'server'),{recursive:true,filter:p=>!p.endsWith('.test.mjs')});await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');if(databaseUrl){assert.equal(new URL(databaseUrl).hostname,'127.0.0.1');await fs.cp(path.join(root,'deploy/sql'),path.join(temp,'deploy/sql'),{recursive:true});}

 const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));const base=`http://127.0.0.1:${port}`,admin=crypto.randomUUID(),secret=crypto.randomUUID(),probe='13800000000';let child,worker,run=true,releaseProbes=false,probeCount=0,businessCount=0,starts=0,workerError;const held=[],businesses=[],stderr=[],stops=[];let holdStops=true;
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
 const pending=[],cleanup=[],cancelSeen=new Set(),startedByDevice=new Map(),queriedByDevice=new Map();
 let initialBusiness=true,holdCleanup=true,maxExecuting=0;
 const rawTask=async(t,suffix,body)=>{const res=await fetch(base+`/api/v1/windows-agent-tasks/${t.taskId}/${suffix}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 function work(){worker=(async()=>{let last=0;while(run){
  if(Date.now()-last>2000){await sync();last=Date.now();}
  const active=pending.filter(t=>t.acked).map(t=>t.taskId).join(',');
  const response=await api('GET',`/api/v1/windows-agents/offline-fake/tasks/next?managedLookupDelivery=${MANAGED_LOOKUP_PROTOCOL}&activeTaskIds=${encodeURIComponent(active)}`,token);
  for(const id of response.cancelledTaskIds||[])cancelSeen.add(id);
  const task=response.task;
  if(task){
   const payload=await api('POST',`/api/v1/windows-agent-tasks/${task.taskId}/payload`,token,{deliveryToken:task.deliveryToken});
   const business=task.type==='alipay_name_query'&&payload.payload.phoneNumber!==probe;
   if(initialBusiness&&business&&pending.length===1){
    pending.push({...task,payload:{...task.payload,...payload.payload},acked:false});businessCount++;
   }else{
    const {task:t,acknowledged}=await hydrateManagedLookupTask(task,{request:(p,o={})=>api(o.method||'GET',p,token,o.body)});assert.ok(acknowledged);
    if(t.type==='alipay_name_start'){
     starts++;startedByDevice.set(t.deviceId,(startedByDevice.get(t.deviceId)||0)+1);await finish(t);
    }else if(t.type==='alipay_name_query'){
     queriedByDevice.set(t.deviceId,(queriedByDevice.get(t.deviceId)||0)+1);
     if(!business){probeCount++;await finish(t,{alipayDisplayName:'测*',realNameTailCharacter:'测'});}
     else{businessCount++;businesses.push(t);if(initialBusiness&&pending.length===0)pending.push({...t,acked:true});else await finish(t,{alipayDisplayName:'保*',realNameTailCharacter:'保'});}
    }else if(t.type==='alipay_name_stop'){
     stops.push(t);if(holdCleanup&&pending.some(p=>p.deviceId===t.deviceId))cleanup.push(t);else await finish(t);
    }else throw Error('unexpected simulated task type');
   }
   maxExecuting=Math.max(maxExecuting,(await pool()).counts.executing);assert.ok(maxExecuting<=5);
  }
  await sleep(20);
 }})().catch(e=>{workerError=e;});}
 const stopPublic=(p,key)=>request('POST','/api/v1/open/name-lookups/stop',{preparationId:p.preparationId},key);
 try{
  await start();await api('POST','/api/v1/users',admin,{username:'ready_user',password:crypto.randomUUID(),role:'user'});
  ({token}=await api('POST','/api/v1/windows-agents',admin,{agentId:'offline-fake'}));await sync();
  for(const n of [51,52,54,55,87])await api('PUT','/api/v1/devices/'+encodeURIComponent('adb:READY-'+n),admin,{deviceName:String(n),listingStatus:'listed'});
  const preview=(await api('POST','/api/v1/admin/lookup-pool/preview',admin,{})).devices.filter(d=>d.matches===1);
  await api('PUT','/api/v1/admin/lookup-pool',admin,{enabled:true,concurrency:5,preparedClientInflightLimit:20,devices:preview.map(d=>({...d,enabled:true})),grants:[{clientId:'ready-client',enabled:true,consentReference:'synthetic-consent'}]});
  const old=await preparePublic({idempotencyKey:'offline-round-old'});work();
  await wait(async()=>(await pool()).channels.filter(c=>c.phase==='idle').length===5&&(await preparePublic({idempotencyKey:'offline-round-old'})).ready);
  const first=await Promise.all(Array.from({length:5},(_,i)=>a.submitLookup('1390000000'+i,{idempotencyKey:'old-business-'+i})));
  await wait(()=>businessCount===5&&pending.length===2);
  await wait(async()=>(await Promise.all(first.map(r=>a.getLookupResult(r.lookupId)))).filter(r=>r.status==='completed').length===3);
  const offlineIds=new Set(pending.map(t=>t.deviceId));
  for(const d of inventory.devices)if(offlineIds.has('adb:'+d.adbSerial))d.state='physically_absent';
  await sync();initialBusiness=false;
  const stopAt=Date.now();assert.equal((await stopPublic(old,'stop-old-round')).status,'stopping');
  await assert.rejects(preparePublic({idempotencyKey:'blocked-before-fence'}),{code:'lookup_round_stopping'});
  await wait(async()=>(await stopPublic(old,'stop-old-round')).stopped);
  const stopElapsedMs=Date.now()-stopAt;assert.ok(stopElapsedMs>=30000);
  let p=await pool();assert.equal(p.channels.length,2);assert.ok(p.channels.every(c=>c.phase==='quarantined'));assert.equal(p.counts.executing,0);
  const oldResults=await Promise.all(first.map(r=>a.getLookupResult(r.lookupId)));
  assert.equal(oldResults.filter(r=>r.status==='completed').length,3);
  assert.equal(oldResults.filter(r=>r.status==='failed'&&r.code==='lookup_round_stopped').length,2);
  assert.ok(cancelSeen.has(pending[0].taskId),'running Agent receives cancellation');
  for(const t of pending){
   assert.equal((await rawTask(t,'payload',{deliveryToken:t.deliveryToken})).status,409);
   assert.equal((await rawTask(t,'ack',{deliveryToken:t.deliveryToken})).status,409);
   const late=await rawTask(t,'status',{status:'succeeded',managedLookupGeneration:t.payload.managedLookup.generation,result:{...account,alipayDisplayName:'迟*'}});
   assert.equal(late.body.ignored,true);
  }
  // Restart with both detached reservations still present; retain old results.
  run=false;await worker;if(workerError)throw workerError;let ex=once(child,'exit');child.kill('SIGTERM');await ex;
  await start();await sync();p=await pool();assert.equal(p.channels.length,2);assert.ok(p.channels.every(c=>c.phase==='quarantined'));
  assert.equal((await stopPublic(old,'stop-old-round')).stopped,true);
  const next=await preparePublic({idempotencyKey:'offline-round-new'});assert.notEqual(next.preparationId,old.preparationId);run=true;work();
  await wait(async()=>(await preparePublic({idempotencyKey:'offline-round-new'})).ready);
  for(const id of offlineIds)assert.equal(startedByDevice.get(id),1,'new round must not reuse quarantined phone');
  const second=await Promise.all(Array.from({length:6},(_,i)=>a.submitLookup('1370000000'+i,{idempotencyKey:'new-business-'+i})));
  await wait(async()=>(await Promise.all(second.map(r=>a.getLookupResult(r.lookupId)))).every(r=>r.status==='completed'));
  assert.deepEqual(await Promise.all(first.map(r=>a.getLookupResult(r.lookupId))),oldResults,'late reports cannot replace cancelled results');
  // Reconnection first delivers cleanup to old generation, never new lookup.
  for(const d of inventory.devices)d.state='device';await sync();
  await wait(()=>cleanup.length===2);
  for(const id of offlineIds)assert.equal(startedByDevice.get(id),1);
  p=await pool();assert.ok(p.channels.filter(c=>offlineIds.has(c.deviceId)).every(c=>c.phase==='stopping'));
  assert.equal((await stopPublic(old,'old-stop-late-key')).stopped,true);
  assert.equal((await preparePublic({idempotencyKey:'offline-round-new'})).ready,true);
  holdCleanup=false;for(const t of cleanup)await finish(t);
  await wait(async()=>(await pool()).channels.length===5&&(await pool()).channels.every(c=>c.phase==='idle'));
  for(const id of offlineIds)assert.equal(startedByDevice.get(id),2,'phone is reprobed only after cleanup ACK');
  await stopPublic(next,'stop-new-round');await wait(async()=>(await stopPublic(next,'stop-new-round')).stopped);
  assert.equal((await pool()).channels.length,0);
  assert.doesNotMatch(stderr.join(''),/fatal|SyntaxError|unhandled/i);
  return {storage:databaseUrl?'postgres':'json',loopbackOnly:true,simulatedDevices:5,realDevices:0,productionConnections:0,realOfflineGraceMs:stopElapsedMs,oldBusinessCompleted:3,oldBusinessCancelled:2,newBusinessCompleted:6,maxExecuting,leasedPayloadAndAckRejected:true,lateReportsIgnored:true,restartRetainsQuarantine:true,newRoundReadyWithoutOfflinePhones:true,reconnectionCleanupAckBeforeReuse:true,finalChannels:0};
 }finally{run=false;await worker?.catch(()=>{});if(child?.exitCode===null){const ex=once(child,'exit');child.kill('SIGTERM');const t=setTimeout(()=>child.kill('SIGKILL'),2500);await ex;clearTimeout(t);}await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&await fs.realpath(process.argv[1])===import.meta.filename)console.log(JSON.stringify(await runOfflineRoundHttp()));
