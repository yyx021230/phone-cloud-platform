import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import {LOOKUP_POOL_NUMBERS,MANAGED_LOOKUP_PROTOCOL} from './managed-lookup-store.mjs';
import {hydrateManagedLookupTask} from '../windows-agent/src/managed-lookup-delivery.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('real isolated HTTP:phone-only result,49-device mapping,max5,duplicate replay,cancel,unknown ACK,stop cleanup', {timeout:45000},async t=>{
  const root=path.resolve(import.meta.dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'managed-lookup-http-'));
  await fs.cp(path.join(root,'server'),path.join(temp,'server'),{recursive:true,filter:p=>!p.endsWith('.test.mjs')});await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');
  const portServer=net.createServer().listen(0,'127.0.0.1');await once(portServer,'listening');const port=portServer.address().port;await new Promise(r=>portServer.close(r));const base=`http://127.0.0.1:${port}`;
  const admin=crypto.randomUUID(),secret=crypto.randomBytes(32).toString('hex');let child,run=true,worker,errors='';
  const clients=['client-a','client-b'].map((id,i)=>({clientId:id,secret,username:`lookup_${i}`,deviceIds:['adb:SYNTH-161']}));
  const localDatabase=process.env.MANAGED_LOOKUP_TEST_DATABASE_URL||'';if(localDatabase)assert.equal(new URL(localDatabase).hostname,'127.0.0.1');
  if(localDatabase)await fs.cp(path.join(root,'deploy/sql'),path.join(temp,'deploy/sql'),{recursive:true});
  const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:path.join(temp,'data'),STORAGE_BACKEND:localDatabase?'postgres':'json',STRUCTURED_WRITES:'true',REDIS_URL:'',DATABASE_URL:localDatabase,ADMIN_API_TOKEN:admin,ADMIN_PASSWORD:crypto.randomUUID(),WINDOWS_AGENT_TOKEN:crypto.randomUUID(),DEVICE_AGENT_TOKEN:crypto.randomUUID(),SCREEN_MEDIA_AUTH_SECRET:crypto.randomUUID(),OPEN_NAME_LOOKUP_API_ENABLED:'true',MANAGED_NAME_LOOKUP_ENABLED:'true',OPEN_NAME_LOOKUP_CLIENTS_JSON:JSON.stringify(clients)};
  const start=()=>{child=spawn(process.execPath,[path.join(temp,'server/index.mjs')],{cwd:temp,env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>errors=(errors+b).slice(-4000));};
  t.after(async()=>{run=false;await worker?.catch(()=>{});if(child?.exitCode===null){const e=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await e;clearTimeout(timer);}await fs.rm(temp,{recursive:true,force:true});});
  start();for(let i=0;i<100;i++){if(child.exitCode!==null)assert.fail('local server startup failed:'+errors);try{if((await fetch(base+'/readyz')).ok)break;}catch{}await sleep(30);}
  async function raw(method,p,token,body){const response=await fetch(base+p,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
  async function api(method,p,token,body){const x=await raw(method,p,token,body);assert.ok(x.status<300,`${p}:${x.status}:${x.body.error}`);return x.body;}
  async function signed(phone,key,client='client-a',signal){const p='/api/v1/open/name-lookups/query',body=JSON.stringify({phoneNumber:phone}),timestamp=String(Date.now()),nonce=crypto.randomUUID(),hash=crypto.createHash('sha256').update(body).digest('hex'),sig=crypto.createHmac('sha256',secret).update(['POST',p,timestamp,nonce,hash].join('\n')).digest('hex');const res=await fetch(base+p,{method:'POST',signal,headers:{'Content-Type':'application/json','X-Client-Id':client,'X-Timestamp':timestamp,'X-Nonce':nonce,'X-Signature':sig,'Idempotency-Key':key},body});return {status:res.status,body:await res.json()};}
  async function asyncSubmit(phone,key){const p='/api/v1/open/name-lookups/tasks',body=JSON.stringify({phoneNumber:phone}),timestamp=String(Date.now()),nonce=crypto.randomUUID(),hash=crypto.createHash('sha256').update(body).digest('hex'),signature=crypto.createHmac('sha256',secret).update(['POST',p,timestamp,nonce,hash].join('\n')).digest('hex');const response=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Client-Id':'client-a','X-Timestamp':timestamp,'X-Nonce':nonce,'X-Signature':signature,'Idempotency-Key':key},body});return {status:response.status,body:await response.json()};}
  for(let i=0;i<2;i++)await api('POST','/api/v1/users',admin,{username:`lookup_${i}`,password:crypto.randomUUID(),role:'user'});
  const {token}=await api('POST','/api/v1/windows-agents',admin,{agentId:'fake-agent'});
  await api('POST','/api/v1/windows-agents/fake-agent/devices/sync',token,{agent:{agentId:'fake-agent',managedLookupProtocol:MANAGED_LOOKUP_PROTOCOL,lookupPostHumanProtocol:1,health:{airtest:{enabled:true,ok:true}}},devices:LOOKUP_POOL_NUMBERS.map(n=>({adbSerial:`SYNTH-${n}`,state:'device',deviceName:String(n)}))});
  for(const n of LOOKUP_POOL_NUMBERS)await api('PUT',`/api/v1/devices/${encodeURIComponent('adb:SYNTH-'+n)}`,admin,{deviceName:String(n),listingStatus:'listed'});
  const preview=await api('POST','/api/v1/admin/lookup-pool/preview',admin,{});assert.equal(preview.devices.length,49);assert.ok(preview.devices.every(d=>d.matches===1&&d.ready));
  const cfg={enabled:true,concurrency:5,waitMs:12000,idleMs:400,devices:preview.devices.map(d=>({...d,enabled:true})),grants:clients.map(c=>({clientId:c.clientId,consentReference:'authorized-test-fixture',enabled:true}))};await api('PUT','/api/v1/admin/lookup-pool',admin,cfg);
  assert.equal((await signed('invalid',crypto.randomUUID())).status,400);
  assert.equal((await raw('PUT','/api/v1/admin/lookup-pool',admin,{concurrency:6})).status,400);
  assert.equal((await raw('GET','/api/v1/admin/lookup-pool','invalid',undefined)).status,401);
  let max=0,queryCount=0,release=false,loseNextAck=false,holdOne=false,heldTask=null;const puzzled=new Set(),uncertain=new Set(),recoveryFailed=new Set();const live=new Map(),tasks=[],inFlight=new Set();
  const request=async(p,o={})=>api(o.method||'GET',p,token,o.body);
  async function complete(task){
    const lose=loseNextAck;loseNextAck=false;const prepared=await hydrateManagedLookupTask(task,{request:async(p,o)=>{const result=await request(p,o);if(lose&&p.endsWith('/ack'))throw new Error('simulated ACK response lost');return result;}});if(!prepared.acknowledged){uncertain.add(task.taskId);return;}task=prepared.task;tasks.push(task);
    const m=task.payload.managedLookup.generation;let result={},status='succeeded';
    if(task.type!=='alipay_name_stop')result={currentAccount:'fixture-account',accountIdentityVerified:true,savedAccounts:[{account:'fixture-account',current:true}]};
    if(task.type==='alipay_name_query'){
      assert.equal(live.has(task.adbSerial),false,'same phone cannot overlap');live.set(task.adbSerial,task.taskId);max=Math.max(max,live.size);queryCount++;
      while((!release||holdOne)&&run)await sleep(10);if(holdOne){heldTask=task;live.delete(task.adbSerial);return;}await sleep(50);result={...result,...(task.payload.phoneNumber.endsWith('9')?{notFound:true}:{alipayDisplayName:'测*',realNameTailCharacter:'测'})};if(task.payload.phoneNumber==='13800009991'&&!puzzled.has(task.payload.phoneNumber)){puzzled.add(task.payload.phoneNumber);status='failed';result={...result,errorCode:'alipay_human_verification_required'};}if(['13800009994','13800009995'].includes(task.payload.phoneNumber)&&!recoveryFailed.has(task.payload.phoneNumber)){recoveryFailed.add(task.payload.phoneNumber);status='failed';result={...result,errorCode:task.payload.phoneNumber.endsWith('5')?'alipay_lookup_result_unconfirmed':'lookup_status_storage_unavailable'};}live.delete(task.adbSerial);
    }
    const bad=await raw('POST',`/api/v1/windows-agent-tasks/${task.taskId}/status`,token,{status:'succeeded',result,managedLookupGeneration:'stale'});assert.equal(bad.status,409);
    await api('POST',`/api/v1/windows-agent-tasks/${task.taskId}/status`,token,{status,result,managedLookupGeneration:m});
  }
  const drive=()=> (async()=>{while(run){const x=await api('GET',`/api/v1/windows-agents/fake-agent/tasks/next?managedLookupDelivery=${MANAGED_LOOKUP_PROTOCOL}`,token);if(x.task){const p=complete(x.task);inFlight.add(p);p.finally(()=>inFlight.delete(p));}else await sleep(15);}await Promise.all(inFlight);})();worker=drive();
  const keys=Array.from({length:20},()=>crypto.randomUUID()),phones=keys.map((_,i)=>'1380000'+String(i).padStart(4,'0'));
  const calls=phones.map((phone,i)=>signed(phone,keys[i]));const replay=signed(phones[0],keys[0]);
  for(let i=0;i<200&&live.size<5;i++)await sleep(15);if(live.size!==5){const debug=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;console.error(JSON.stringify({counts:debug.counts,channels:debug.channels,requests:debug.requests.map(r=>({status:r.status,queryId:r.queryId})),errors}));}assert.equal(live.size,5);const busyPool=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;assert.equal(busyPool.counts.executing,5);assert.equal(busyPool.requests.length,20,'same key does not add request');assert.equal((await signed(phones[1],keys[0])).status,409);
  assert.equal((await api('GET','/api/v1/windows-agents/fake-agent/tasks/next',token)).task,null,'old Agent cannot claim pool task');
  release=true;const results=await Promise.all(calls);assert.ok(results.every(r=>r.status===200));assert.deepEqual(results[0].body,{ok:true,name:'测*'});assert.equal(results[9].body.code,'not_found');assert.equal((await replay).status,429,"21st waiting connection is bounded without duplicating task");assert.equal(max,5);assert.equal(queryCount,20);
  assert.ok(results.every(r=>!('lookupId' in r.body)&&!('session' in r.body)),'success exposes no task management');
  const same=await signed(phones[0],keys[0]);assert.deepEqual(same,results[0]);assert.equal(queryCount,20);
  for(let i=0;i<150;i++){const p=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;if(!p.channels.length)break;await sleep(20);}assert.equal((await api('GET','/api/v1/admin/lookup-pool',admin)).pool.channels.length,0,'confirmed stop releases channels');
  assert.equal((await api('GET','/api/v1/device-locks',admin)).locks.filter(l=>l.status==='active').length,0);
  // ACK committed but response lost: no UI execution and no fresh request.
  await api('PUT','/api/v1/admin/lookup-pool',admin,{waitMs:800});loseNextAck=true;const lostKey=crypto.randomUUID();const beforeLost=queryCount;
  const lost=await signed('13800009990',lostKey);assert.equal(lost.status,504);assert.equal(queryCount,beforeLost);assert.equal(uncertain.size,1);
  const lostRequest=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool.requests.find(r=>r.status==='preparing');assert.ok(lostRequest);
  await api('POST',`/api/v1/admin/lookup-pool/requests/${lostRequest.lookupId}/cancel`,admin,{});
  for(let i=0;i<100;i++){const p=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;if(!p.channels.length)break;await sleep(20);}assert.equal((await api('GET','/api/v1/admin/lookup-pool',admin)).pool.channels.length,0);
  assert.equal((await signed('13800009990',lostKey)).body.code,'lookup_cancelled');assert.equal(queryCount,beforeLost);
  // A puzzle reserves that phone; unrelated work still returns a name.
  await api('PUT','/api/v1/admin/lookup-pool',admin,{waitMs:3000});
  const puzzleKey=crypto.randomUUID();const puzzle=await signed('13800009991',puzzleKey);assert.equal(puzzle.status,503);assert.equal(puzzle.body.code,'lookup_manual_action_pending');
  const human=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;assert.equal(human.counts.waitingHuman,1);const original=human.requests.find(r=>r.status==='waiting_human');const queryId=original.queryId;
  await api('PUT','/api/v1/admin/lookup-pool',admin,{waitMs:3000});assert.equal((await signed('13800009992',crypto.randomUUID())).status,200);
  const probePath='/api/v1/windows-agents/fake-agent/lookup-human-verifications';let probes=(await api('GET',probePath,token)).probes;assert.equal(probes.length,1);assert.equal((await api('POST',probePath,token,{probeId:probes[0].probeId,state:'search_ready'})).resumed,false);
  await sleep(2100);probes=(await api('GET',probePath,token)).probes;assert.equal((await api('POST',probePath,token,{probeId:probes[0].probeId,state:'search_ready'})).resumed,false);
  for(let i=0;i<150;i++){const p=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;if(p.requests.find(r=>r.lookupId===original.lookupId)?.status==='succeeded')break;await sleep(20);}
  const recovered=await signed('13800009991',puzzleKey);assert.deepEqual(recovered.body,{ok:true,name:'测*'});const after=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool.requests.find(r=>r.lookupId===original.lookupId);assert.equal(after.queryId,queryId,'human recovery writes original result');
  await api('PUT','/api/v1/admin/lookup-pool',admin,{waitMs:1000});const recoveryKey=crypto.randomUUID();const failedRecovery=await signed('13800009994',recoveryKey);assert.equal(failedRecovery.body.code,'lookup_recovery_required');
  const recoverable=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool.requests.find(r=>r.status==='needs_recovery');assert.ok(recoverable);
  await api('POST',`/api/v1/admin/lookup-pool/requests/${recoverable.lookupId}/retry`,admin,{});assert.equal((await signed('13800009994',recoveryKey)).body.name,'测*');assert.equal((await api('GET','/api/v1/admin/lookup-pool',admin)).pool.requests.find(r=>r.lookupId===recoverable.lookupId).queryId,recoverable.queryId);
  // A first query with ambiguous evidence stays active across a new partner request ID.
  const ambiguousPhone='13800009995',ambiguousKey=crypto.randomUUID();
  assert.equal((await signed(ambiguousPhone,ambiguousKey)).body.code,'lookup_recovery_required');
  const pendingRecovery=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool.requests.find(r=>r.status==='needs_recovery');
  assert.ok(pendingRecovery);const beforeAmbiguousReplay=queryCount;
  const replayAmbiguous=await asyncSubmit(ambiguousPhone,crypto.randomUUID());
  assert.equal(replayAmbiguous.status,200);assert.equal(replayAmbiguous.body.lookupId,pendingRecovery.lookupId);
  assert.equal(replayAmbiguous.body.reused,true);
  assert.equal(queryCount,beforeAmbiguousReplay,'new request ID must not execute ambiguous phone twice');
  const pendingAgain=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool.requests.filter(r=>r.status==='needs_recovery');
  assert.equal(pendingAgain.length,1);assert.equal(pendingAgain[0].lookupId,pendingRecovery.lookupId);
  assert.equal(pendingAgain[0].queryId,pendingRecovery.queryId);
  assert.equal((await signed('13800009996',crypto.randomUUID())).body.name,'测*','other phones continue');
  await api('POST',`/api/v1/admin/lookup-pool/requests/${pendingRecovery.lookupId}/retry`,admin,{});
  assert.equal((await signed(ambiguousPhone,ambiguousKey)).body.name,'测*');
  assert.equal((await api('GET','/api/v1/admin/lookup-pool',admin)).pool.requests.find(r=>r.lookupId===pendingRecovery.lookupId).queryId,pendingRecovery.queryId);
  assert.equal((await raw('PUT','/api/v1/admin/lookup-pool',admin,{enabled:false,expectedConfigRevision:-1})).status,409,'stale admin edits cannot overwrite configuration');
  assert.ok(max<=5);await api('PUT','/api/v1/admin/lookup-pool',admin,{enabled:false});
  for(let i=0;i<120;i++){if(!(await api('GET','/api/v1/admin/lookup-pool',admin)).pool.channels.length)break;await sleep(20);}assert.equal((await api('GET','/api/v1/device-locks',admin)).locks.filter(l=>l.status==='active').length,0);
  await api('PUT','/api/v1/admin/lookup-pool',admin,{enabled:true,waitMs:4000});holdOne=true;const pendingKey=crypto.randomUUID();const pending=signed('13800009993',pendingKey).catch(()=>({status:0}));
  for(let i=0;i<120&&!live.size;i++)await sleep(20);assert.equal(live.size,1);const beforeCrash=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool.requests.find(r=>r.status==='running');assert.ok(beforeCrash);
  run=false;await worker;const exit=once(child,'exit');child.kill('SIGKILL');await exit;await pending;
  start();for(let i=0;i<100;i++){try{if((await fetch(base+'/readyz')).ok)break;}catch{}await sleep(30);}
  const restored=await signed(phones[0],keys[0]);assert.deepEqual(restored,results[0],'hard restart preserves stored name and same-key result');
  const activeRestored=(await api('GET','/api/v1/admin/lookup-pool',admin)).pool;assert.equal(activeRestored.channels.length,1);assert.equal(activeRestored.requests.find(r=>r.lookupId===beforeCrash.lookupId).queryId,beforeCrash.queryId);
  assert.equal((await api('GET',`/api/v1/windows-agents/fake-agent/tasks/next?managedLookupDelivery=${MANAGED_LOOKUP_PROTOCOL}`,token)).task,null,'in-flight query is not redelivered after platform crash');
  const attach=signed('13800009993',pendingKey);assert.ok(heldTask);await api('POST',`/api/v1/windows-agent-tasks/${heldTask.taskId}/status`,token,{status:'succeeded',managedLookupGeneration:heldTask.payload.managedLookup.generation,result:{currentAccount:'fixture-account',accountIdentityVerified:true,savedAccounts:[{account:'fixture-account',current:true}],alipayDisplayName:'原*',realNameTailCharacter:'原'}});
  assert.deepEqual((await attach).body,{ok:true,name:'原*'});holdOne=false;run=true;worker=drive();await api('PUT','/api/v1/admin/lookup-pool',admin,{enabled:false});for(let i=0;i<100;i++){if(!(await api('GET','/api/v1/admin/lookup-pool',admin)).pool.channels.length)break;await sleep(20);}assert.equal((await api('GET','/api/v1/admin/lookup-pool',admin)).pool.channels.length,0);
  assert.doesNotMatch(errors,/fatal|SyntaxError|unhandled/i);
});
