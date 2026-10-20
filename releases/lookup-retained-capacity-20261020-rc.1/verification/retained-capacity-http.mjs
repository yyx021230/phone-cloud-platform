// Actual loopback HTTP/API Key and five simulated devices. No production, Agent, ADB or Feishu.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';

import {MANAGED_LOOKUP_PROTOCOL} from '../server/managed-lookup-store.mjs';import {hydrateManagedLookupTask} from '../windows-agent/src/managed-lookup-delivery.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runRetainedCapacityHttp({databaseUrl=''}={}){
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
 const inventory={agent:{agentId:'readiness-fake',managedLookupProtocol:MANAGED_LOOKUP_PROTOCOL,lookupRuntimeId:crypto.randomUUID(),health:{airtest:{enabled:true,ok:true}}},devices:[51,52,54,55,87,138,152,164].map(n=>({adbSerial:'READY-'+n,state:'device',deviceName:String(n)}))};
 const sync=()=>api('POST','/api/v1/windows-agents/readiness-fake/devices/sync',token,inventory);
 const wait=async fn=>{for(let i=0;i<1500;i++){if(workerError)throw workerError;const x=await fn();if(x)return x;await sleep(30);}throw Error('condition timeout');};

 const humanDevices=new Set(['adb:READY-51','adb:READY-52','adb:READY-54']),puzzled=new Set();let finishBusiness=false;
 function work(){worker=(async()=>{let last=0;while(run){
  if(Date.now()-last>4000){await sync();last=Date.now();}
  const {task}=await api('GET',`/api/v1/windows-agents/readiness-fake/tasks/next?managedLookupDelivery=${MANAGED_LOOKUP_PROTOCOL}`,token);
  if(task){const {task:t,acknowledged}=await hydrateManagedLookupTask(task,{request:(p,o={})=>api(o.method||'GET',p,token,o.body)});assert.ok(acknowledged);
   if(t.type==='alipay_name_start'){starts++;await finish(t);}
   else if(t.type==='alipay_name_query'){
    if(t.payload.phoneNumber===probe){probeCount++;
     if(humanDevices.has(t.deviceId)&&!puzzled.has(t.deviceId)){
      puzzled.add(t.deviceId);await api('POST',`/api/v1/windows-agent-tasks/${t.taskId}/status`,token,{status:'failed',managedLookupGeneration:t.payload.managedLookup.generation,result:{...account,errorCode:'alipay_human_verification_required',diagnostic:{limitReason:'jigsaw_verification'}}});
     }else await finish(t,{alipayDisplayName:'测*',realNameTailCharacter:'测'});
    }else{businessCount++;businesses.push(t);if(finishBusiness)await finish(t,{alipayDisplayName:'测*',realNameTailCharacter:'测'});}
   }else if(t.type==='alipay_name_stop'){stops.push(t);if(!holdStops)await finish(t);}
   else await finish(t);
  }await sleep(20);
 }})().catch(e=>{workerError=e;});}
 const pool=async()=>(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;
 try{
  await start();await api('POST','/api/v1/users',admin,{username:'ready_user',password:crypto.randomUUID(),role:'user'});
  ({token}=await api('POST','/api/v1/windows-agents',admin,{agentId:'readiness-fake'}));await sync();
  for(const n of [51,52,54,55,87,138,152,164])await api('PUT','/api/v1/devices/'+encodeURIComponent('adb:READY-'+n),admin,{deviceName:String(n),listingStatus:'listed'});
  const preview=(await api('POST','/api/v1/admin/lookup-pool/preview',admin,{})).devices.filter(d=>d.matches===1);
  await api('PUT','/api/v1/admin/lookup-pool',admin,{enabled:true,concurrency:5,preparedClientInflightLimit:20,devices:preview.map(d=>({...d,enabled:true})),grants:[{clientId:'ready-client',enabled:true,consentReference:'synthetic-consent'}]});
  const prep=await preparePublic({idempotencyKey:'surplus-start'});work();
  await wait(async()=>{const p=await pool();return p.channels.length===8&&p.channels.filter(c=>c.phase==='idle').length===5&&p.counts.waitingHuman===3;});
  assert.equal(stops.length,0);
  // Simulated Agent reports successful manual completion through its real protocol.
  const probePath='/api/v1/windows-agents/readiness-fake/lookup-human-verifications';
  const probes=(await api('GET',probePath,token)).probes;assert.equal(probes.length,3);
  for(const p of probes)assert.equal((await api('POST',probePath,token,{probeId:p.probeId,state:'search_ready'})).resumed,false);
  await sleep(2100);
  for(const p of (await api('GET',probePath,token)).probes)assert.equal((await api('POST',probePath,token,{probeId:p.probeId,state:'search_ready'})).resumed,true);
  await wait(()=>stops.length===3);let p=await pool();assert.equal(p.channels.length,8);assert.equal(p.channels.filter(c=>c.phase==='idle').length,5);assert.equal(p.channels.filter(c=>c.phase==='stopping').length,3);
  // Persisted stop reservations survive a cloud-process restart; no premature release.
  run=false;await worker;if(workerError)throw workerError;let ex=once(child,'exit');child.kill('SIGTERM');await ex;await start();await sync();
  p=await pool();assert.equal(p.channels.length,8);assert.equal(p.channels.filter(c=>c.phase==='stopping').length,3);
  for(const t of stops)await finish(t);
  run=true;work();await wait(async()=>{const p=await pool();return p.channels.length===5&&p.channels.every(c=>c.phase==='idle')&&(await preparePublic({idempotencyKey:'surplus-start'})).ready;});
  const startsAfter=starts;assert.equal(startsAfter,8);
  const jobs=await Promise.all(Array.from({length:20},(_,i)=>a.submitLookup('1390000'+String(i).padStart(4,'0'),{idempotencyKey:'surplus-business-'+i})));
  await wait(()=>businessCount===5);p=await pool();assert.equal(p.counts.executing,5);assert.equal(p.requests.filter(r=>r.purpose!=='readiness_probe'&&r.status==='queued').length,15);
  const retry=await a.submitLookup('13900000000',{idempotencyKey:'changed-surplus-key'});assert.equal(retry.lookupId,jobs[0].lookupId);
  finishBusiness=true;for(const t of businesses.slice())await finish(t,{alipayDisplayName:'测*',realNameTailCharacter:'测'});
  await wait(async()=>(await Promise.all(jobs.map(j=>a.getLookupResult(j.lookupId)))).every(r=>r.status==='completed'&&r.name==='测*'));
  assert.equal(businessCount,20);assert.equal(starts,8);assert.equal((await pool()).channels.length,5);
  holdStops=false;const stop=()=>request('POST','/api/v1/open/name-lookups/stop',{preparationId:prep.preparationId},'surplus-final-stop');await stop();await wait(async()=>(await stop()).stopped);
  assert.equal((await pool()).channels.length,0);
  return {loopbackOnly:true,storage:databaseUrl?'postgres':'json',simulatedDevices:8,realDevices:0,productionConnections:0,humanStandbys:3,retainedReady:5,surplusStopAckRequired:true,restartDuringStop:true,businessSubmitted:20,businessExecutions:20,maxConcurrentBusinessObserved:5,changedKeyReused:true,newDeviceStarts:8,explicitStopDrained:true};
 }finally{run=false;await worker?.catch(()=>{});if(child?.exitCode===null){const ex=once(child,'exit');child.kill('SIGTERM');const t=setTimeout(()=>child.kill('SIGKILL'),2500);await ex;clearTimeout(t);}await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&await fs.realpath(process.argv[1])===import.meta.filename)console.log(JSON.stringify(await runRetainedCapacityHttp()));
