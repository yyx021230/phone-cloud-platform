import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {MANAGED_LOOKUP_PROTOCOL} from './managed-lookup-store.mjs';
import {hydrateManagedLookupTask} from '../windows-agent/src/managed-lookup-delivery.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('external HTTP runtime loss and exhausted cleanup preserve ID, recover and accept next business',{timeout:270000},async()=>{
 const root=path.resolve(import.meta.dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-runtime-recovery-http-'));
 await fs.cp(path.join(root,'server'),path.join(temp,'server'),{recursive:true,filter:p=>!p.endsWith('.test.mjs')});await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');
 const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`,admin=crypto.randomUUID(),key='pclk_'+crypto.randomBytes(32).toString('base64url'),probe='13800000000';
 const env={PATH:process.env.PATH,HOME:process.env.HOME,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'test',DATA_DIR:temp,STORAGE_BACKEND:'json',STRUCTURED_WRITES:'true',DATABASE_URL:'',REDIS_URL:'',ADMIN_PASSWORD:crypto.randomUUID(),ADMIN_API_TOKEN:admin,WINDOWS_AGENT_TOKEN:crypto.randomUUID(),DEVICE_AGENT_TOKEN:crypto.randomUUID(),SCREEN_MEDIA_AUTH_SECRET:crypto.randomUUID(),OPEN_NAME_LOOKUP_API_ENABLED:'true',MANAGED_NAME_LOOKUP_ENABLED:'true',LOOKUP_AI_VISION_ENABLED:'false',LOOKUP_HUMAN_FEISHU_WEBHOOK:'',LOOKUP_HUMAN_FEISHU_WEBHOOK_FILE:'',LOOKUP_READINESS_PROBE_PHONE:probe,OPEN_NAME_LOOKUP_CLIENTS_JSON:JSON.stringify([{clientId:'capacity',secret:crypto.randomUUID(),username:'capacity_user',deviceIds:['adb:CAP-51'],apiKeySha256:crypto.createHash('sha256').update(key).digest('hex')}])};
 // Synthetic inventory only; no production credentials, DB, model, ADB or Agent.
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:temp,env,stdio:['ignore','ignore','pipe']});let childError='';child.stderr.on('data',b=>childError=(childError+String(b)).slice(-1500));let run=true,worker,error,token,firstProbeFailureAt,secondStartAt,probeFailed=true,businessFailed=false;
 const queries=[],starts=[],heldStops=[],heldBusiness=[];let holdStops=false,holdBusiness=true;
 const api=async(method,p,body,auth=admin)=>{const r=await fetch(base+p,{signal:AbortSignal.timeout(5000),method,headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();assert.ok(r.ok,`${method} ${p}: ${r.status} ${j.error||j.code}`);return j;};
 const external=async(method,p,body,id)=>{const r=await fetch(base+'/api/v1/open/name-lookups'+p,{signal:AbortSignal.timeout(5000),method,headers:{'X-API-Key':key,'Content-Type':'application/json',...(id?{'Idempotency-Key':id}:{})},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();assert.ok(r.ok,`${p}: ${r.status} ${j.error||j.code}`);return j;};
 const account={currentAccount:'fixture-account',accountIdentityVerified:true,savedAccounts:[{account:'fixture-account',current:true}]};
 const finish=(t,result={},status='succeeded')=>api('POST',`/api/v1/windows-agent-tasks/${t.taskId}/status`,{status,managedLookupGeneration:t.payload.managedLookup.generation,result:{...account,...(t.type==='alipay_name_stop'&&status==='succeeded'?{diagnostic:{lookupStopProof:{version:1,readerCleanupConfirmed:true,taskId:t.taskId,sessionId:t.payload.automationSessionId,generation:t.payload.managedLookup.generation}}}:{}),...result}},token);
 const fail=t=>finish(t,{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:'lookup_worker_capacity_reached'},message:'synthetic shared reader full'},'failed');
 const pool=async()=>(await api('GET','/api/v1/admin/lookup-pool')).pool;
 const wait=async fn=>{for(let i=0;i<3800;i++){if(error)throw error;if(child.exitCode!==null)throw Error('isolated server exited: '+childError);const r=await fn();if(r)return r;await sleep(25);}const s=await pool();console.log('capacity HTTP state',JSON.stringify({channels:s.channels.map(c=>({phase:c.phase,device:c.deviceNumber,query:!!c.queryId})),requests:s.requests.map(r=>({purpose:r.purpose,status:r.status,code:r.code})),backoff:s.readerCapacityBackoffs}));throw Error('capacity HTTP wait timed out');};
 const inventory={agent:{agentId:'capacity-agent',managedLookupProtocol:MANAGED_LOOKUP_PROTOCOL,lookupRuntimeId:crypto.randomUUID(),health:{airtest:{enabled:true,ok:true}}},devices:[51,52,54].map(n=>({adbSerial:'CAP-'+n,state:'device',deviceName:String(n)}))};
 const sync=()=>api('POST','/api/v1/windows-agents/capacity-agent/devices/sync',inventory,token);
 try{
  await wait(async()=>{try{return (await fetch(base+'/readyz')).ok;}catch{return false;}});
  await api('POST','/api/v1/users',{username:'capacity_user',password:crypto.randomUUID(),role:'user'});({token}=await api('POST','/api/v1/windows-agents',{agentId:'capacity-agent'}));await sync();
  for(const n of [51,52,54])await api('PUT','/api/v1/devices/adb:CAP-'+n,{deviceName:String(n),listingStatus:'listed'});
  const ds=(await api('POST','/api/v1/admin/lookup-pool/preview',{})).devices.filter(x=>x.matches===1);
  await api('PUT','/api/v1/admin/lookup-pool',{enabled:true,concurrency:2,devices:ds.map(d=>({...d,enabled:true})),grants:[{clientId:'capacity',enabled:true,consentReference:'synthetic'}]});
  const p=await external('POST','/prepare',{},'capacity-prepare');
  worker=(async()=>{let heartbeat=0;while(run){
   if(Date.now()-heartbeat>2000){await sync();heartbeat=Date.now();}
   const r=await api('GET','/api/v1/windows-agents/capacity-agent/tasks/next?managedLookupDelivery='+MANAGED_LOOKUP_PROTOCOL+'&lookupReaderCapacityProtocol=1&lookupReaderCapacity='+encodeURIComponent(JSON.stringify({version:1,runtimeId:inventory.agent.lookupRuntimeId,limit:3,pinnedSerials:[]}))+'&activeTaskIds='+encodeURIComponent([...heldStops,...heldBusiness].map(x=>x.taskId).join(',')),undefined,token);
   if(r.task){const {task:t,acknowledged}=await hydrateManagedLookupTask(r.task,{request:(p,o={})=>api(o.method||'GET',p,o.body,token)});assert.ok(acknowledged);console.log('capacity HTTP task',t.type,t.adbSerial,t.payload.phoneNumber===probe?'probe':'business');
    if(t.type==='alipay_name_start'){starts.push({at:Date.now(),device:t.adbSerial});if(probeFailed)secondStartAt??=Date.now();await finish(t);}
    else if(t.type==='alipay_name_stop'){if(holdStops)heldStops.push(t);else await finish(t);}
    else if(t.type==='alipay_name_query'){
     if(t.payload.phoneNumber===probe){if(!probeFailed){probeFailed=true;firstProbeFailureAt=Date.now();await fail(t);}else await finish(t,{alipayDisplayName:'测试(*甲)',realNameTailCharacter:'甲'});}
     else{queries.push({phone:t.payload.phoneNumber,taskId:t.taskId});if(!businessFailed){businessFailed=true;heldBusiness.push(t);}else if(holdBusiness)heldBusiness.push(t);else await finish(t,{alipayDisplayName:'测试(*乙)',realNameTailCharacter:'乙'});}
    }else throw Error('unexpected synthetic task');
   }await sleep(15);
  }})().catch(e=>error=e);
  await wait(async()=>(await external('POST','/prepare',{},'capacity-prepare')).ready);

  let s=await pool();for(const d of s.devices){assert.equal(d.prepareFailureCount,0);assert.equal(d.lookupUnavailable,false);assert.equal(d.preparationIssue,undefined);}
  holdStops=true;const first=await external('POST','/tasks',{phoneNumber:'13900000001'},'capacity-business-1');
  await wait(()=>heldBusiness.length===1);
  const lostTask=heldBusiness.shift();const runtimeChangedAt=Date.now();inventory.agent.lookupRuntimeId=crypto.randomUUID();await sync();
  await wait(()=>heldStops.some(t=>t.payload.automationSessionId===lostTask.payload.automationSessionId));
  assert.ok(Date.now()-runtimeChangedAt>=29500,'new process observation must allow old outbox grace');
  assert.equal((await external('POST','/tasks',{phoneNumber:'13900000001'},'capacity-business-new-key')).lookupId,first.lookupId);
  const other=await external('POST','/tasks',{phoneNumber:'13900000002'},'capacity-business-2');await wait(()=>heldBusiness.length===1);
  const otherTask=heldBusiness.shift();assert.equal(otherTask.payload.phoneNumber,'13900000002');await finish(otherTask,{alipayDisplayName:'测试(*乙)',realNameTailCharacter:'乙'});
  await wait(async()=>(await external('GET','/tasks/'+other.lookupId)).status==='completed');assert.equal(queries.filter(x=>x.phone==='13900000001').length,1,'no replay before stop ACK');
  // Three failed physical cleanups exceed the previous permanent two-retry cap.
  for(let failure=0;failure<3;failure++){
   const failedStop=heldStops.shift(),failedStopAt=Date.now();
   await finish(failedStop,{errorCode:'lookup_reader_cleanup_unconfirmed'},'failed');
   await sleep(1000);
   assert.equal(queries.filter(x=>x.phone==='13900000001').length,1,'no replay without cleanup proof');
   assert.ok((await pool()).channels.some(c=>c.sessionId===failedStop.payload.automationSessionId));
   await wait(()=>heldStops.length===1);
   assert.ok(Date.now()-failedStopAt>=29500,'cleanup retries are paced');
   assert.notEqual(heldStops[0].taskId,failedStop.taskId);
  }
  if(Date.now()-runtimeChangedAt<121000)await sleep(121000-(Date.now()-runtimeChangedAt));
  assert.equal((await external('POST','/tasks',{phoneNumber:'13900000001'},'retry-after-real-two-minutes')).lookupId,first.lookupId);
  assert.equal(queries.filter(x=>x.phone==='13900000001').length,1);
  holdStops=false;holdBusiness=false;await finish(heldStops.shift());
  await wait(async()=>(await external('GET','/tasks/'+first.lookupId)).status==='completed');
  assert.equal(queries.filter(x=>x.phone==='13900000001').length,2);s=await pool();assert.ok(s.devices.every(d=>!d.lookupUnavailable&&!d.prepareFailureCount&&!d.preparationIssue));
  assert.equal((await finish(lostTask,{alipayDisplayName:'迟到旧结果',realNameTailCharacter:'旧'})).ignored,true);
  assert.equal((await external('GET','/tasks/'+first.lookupId)).name,'测试(*乙)');
  const next=await external('POST','/tasks',{phoneNumber:'13900000003'},'recovery-next-business');
  await wait(async()=>(await external('GET','/tasks/'+next.lookupId)).status==='completed');
  assert.equal(queries.filter(x=>x.phone==='13900000003').length,1);
  holdStops=true;
  await external('POST','/stop',{preparationId:p.preparationId},'capacity-stop');
  await wait(()=>heldStops.length===2);
  for(const t of heldStops.splice(0))await finish(t,{errorCode:'lookup_reader_cleanup_unconfirmed'},'failed');
  await wait(async()=>(await external('POST','/stop',{preparationId:p.preparationId},'capacity-stop')).stopped);
  assert.equal((await pool()).channels.length,2,'round completion must retain both unknown physical reservations');
  await wait(()=>heldStops.length===2);
  holdStops=false;for(const t of heldStops.splice(0))await finish(t);
  await wait(async()=>!(await pool()).channels.length);
  assert.equal((await external('GET','/tasks/'+first.lookupId)).name,'测试(*乙)');
 }finally{
  run=false;await worker?.catch(()=>{});if(child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await exit;clearTimeout(timer);}await fs.rm(temp,{recursive:true,force:true});
 }
});
