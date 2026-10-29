import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {MANAGED_LOOKUP_PROTOCOL} from './managed-lookup-delivery.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('actual HTTP admission counts unacknowledged leases, isolates Agent budgets and persists capability floor', {timeout:30000}, async t=>{
 const root=path.resolve(import.meta.dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'reader-admission-http-'));
 const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`,runtimeId=randomUUID(),createdAt=new Date().toISOString();
 const ids=['parallel','pinned','missing','unknown','legacy','stop','other','same','sticky','writefail','broken','broken-stop','broken-other','dir-query','dir-stop','dir-other','write-other'];
 const tokens=Object.fromEntries(ids.map(id=>[id,'pcwa_'+randomUUID()]));
 const windowsAgents=ids.map(agentId=>({agentId,lookupRuntimeId:runtimeId,lookupReaderCapacityProtocol:agentId==='legacy'||agentId==='sticky'?0:1,
  tokenHash:createHash('sha256').update(tokens[agentId]).digest('hex'),enabled:true,lastSeenAt:createdAt,maxConcurrentAdbTasks:30}));
 const windowsTasks=ids.flatMap(agentId=>Array.from({length:15},(_,n)=>({taskId:`${agentId}-${n}`,agentId,adbSerial:`${agentId}-SERIAL-${n}`,
  type:(agentId==='stop'||agentId==='writefail'||agentId.endsWith('-stop'))&&n===14?'alipay_name_stop':(agentId==='other'||agentId.endsWith('-other'))&&n===14?'sms_query':'alipay_name_query',status:'queued',createdAt,updatedAt:createdAt,
  payload:{phoneNumber:'13800000000',managedLookup:{protocol:MANAGED_LOOKUP_PROTOCOL,generation:'g-'+n}}})));
 await fs.writeFile(path.join(temp,'state.json'),JSON.stringify({windowsAgents,windowsTasks}));
 let child,errors='';
 const stop=async()=>{if(!child||child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await exited;clearTimeout(timer);};
 t.after(async()=>{await stop();await fs.rm(temp,{recursive:true,force:true});});
 const start=async()=>{
  child=spawn(process.execPath,[path.join(root,'server/index.mjs')],{cwd:temp,env:{PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:temp,
   STORAGE_BACKEND:'json',DATABASE_URL:'',REDIS_URL:'',ADMIN_API_TOKEN:randomUUID(),ADMIN_PASSWORD:randomUUID(),SCREEN_MEDIA_AUTH_SECRET:randomUUID(),
   MANAGED_NAME_LOOKUP_ENABLED:'false',OPEN_NAME_LOOKUP_API_ENABLED:'false',LOOKUP_AI_VISION_ENABLED:'false',LOOKUP_HUMAN_FEISHU_WEBHOOK:''},stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',b=>errors=(errors+String(b)).slice(-1500));
  for(let n=0;n<150;n++){assert.equal(child.exitCode,null,errors);try{if((await fetch(base+'/readyz')).ok)return;}catch{}await sleep(30);}throw Error('startup timeout');
 };
 const call=async(id,p,body)=>{const r=await fetch(base+p,{signal:AbortSignal.timeout(5000),method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokens[id],'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();assert.equal(r.status,200,j.error);return j;};
 const report=(pinnedSerials=[])=>({version:1,runtimeId,limit:8,pinnedSerials});
 const next=(id,capacity=report(),extra={})=>{const q=new URLSearchParams({managedLookupDelivery:MANAGED_LOOKUP_PROTOCOL,...extra});if(capacity!==null)q.set('lookupReaderCapacity',JSON.stringify(capacity));return call(id,`/api/v1/windows-agents/${id}/tasks/next?${q}`);};
 const heartbeat=(input)=>call('sticky','/api/v1/windows-agents/heartbeat',{agentId:'sticky',lookupRuntimeId:runtimeId,...input});
 await start();
 const claims=await Promise.all(Array.from({length:15},()=>next('parallel')));
 assert.equal(claims.filter(x=>x.task).length,8,'leases reserve capacity before ACK and before persistence await');
 assert.equal(new Set(claims.filter(x=>x.task).map(x=>x.task.taskId)).size,8);
 assert.ok(claims.filter(x=>!x.task).every(x=>x.readerCapacity.reason==='lookup_reader_capacity_full'));
 const selected=claims.find(x=>x.task).task;
 assert.equal(selected.payload.phoneNumber,undefined,'normal payload secrecy remains');
 for(let n=0;n<2;n++)await call('parallel',`/api/v1/windows-agent-tasks/${selected.taskId}/ack`,{deliveryToken:selected.deliveryToken});
 assert.equal((await next('parallel')).task,null,'duplicate ACK does not create a free slot');
 const pinned=await Promise.all(Array.from({length:10},()=>next('pinned',report(['OTHER-1','OTHER-2']))));
 assert.equal(pinned.filter(x=>x.task).length,6);
 assert.ok((await next('same',report(['same-SERIAL-0',...Array.from({length:7},(_,n)=>'PIN-'+n)]))).task,'reuse own already-pinned serial');
 for(const invalid of [null,{...report(),runtimeId:randomUUID()},{...report(),limit:0}])assert.equal((await next('missing',invalid)).task,null);
 const unknown=await next('unknown',report(),{activeTaskIds:'retired-outbox-task'});
 assert.equal(unknown.task,null);assert.equal(unknown.readerCapacity.reason,'lookup_reader_active_task_unknown');
 assert.equal((await next('stop',null)).task.type,'alipay_name_stop','cleanup bypasses reader budget');
 assert.equal((await next('other',null)).task.type,'sms_query','non-reader scheduling unchanged');
 const legacy=await next('legacy',null);assert.ok(legacy.task);assert.equal(legacy.readerCapacity.mode,'legacy_unreported');
 assert.equal((await heartbeat({lookupReaderCapacityProtocol:1})).agent.lookupReaderCapacityProtocol,1);
 assert.equal((await heartbeat({lookupReaderCapacityProtocol:0})).agent.lookupReaderCapacityProtocol,1);
 assert.equal((await heartbeat({})).agent.lookupReaderCapacityProtocol,1);
 assert.equal((await next('sticky',null)).task,null);
 const crashed=once(child,'exit');child.kill('SIGKILL');await crashed;await start();
 assert.equal((await next('sticky',null)).task,null,'capability cannot silently downgrade across restart');
 const changedRuntime=randomUUID();await heartbeat({lookupRuntimeId:changedRuntime});
 assert.equal((await next('sticky',report())).task,null,'old runtime snapshot cannot authorize current worker');
 assert.ok((await next('sticky',{...report(),runtimeId:changedRuntime})).task);
 // Filesystem failure must not force a giant snapshot or block stop delivery.
 const markerDir=path.join(temp,'lookup-reader-capabilities'),savedDir=markerDir+'.saved';
 await fs.rename(markerDir,savedDir);await fs.writeFile(markerDir,'synthetic write failure');
 const failed=await fetch(base+'/api/v1/windows-agents/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+tokens.writefail,'Content-Type':'application/json'},body:JSON.stringify({agentId:'writefail',lookupRuntimeId:runtimeId,lookupReaderCapacityProtocol:1})});
 assert.equal(failed.status,500,'failed durable declaration cannot be acknowledged');
 assert.equal((await next('write-other',report(),{lookupReaderCapacityProtocol:'1'})).task.type,'sms_query');
 const cleanup=await next('writefail',report(),{lookupReaderCapacityProtocol:'1'});
 assert.equal(cleanup.task.type,'alipay_name_stop','even failed floor storage cannot block cleanup');
 const blocked=await next('writefail',report(),{lookupReaderCapacityProtocol:'1'});
 assert.equal(blocked.task,null);assert.equal(blocked.readerCapacity.reason,'lookup_reader_capability_storage_unavailable');
 await fs.rm(markerDir);await fs.rename(savedDir,markerDir);
 assert.ok((await next('writefail',report(),{lookupReaderCapacityProtocol:'1'})).task);
 await stop();
 for(const id of ['broken','broken-stop','broken-other'])await fs.writeFile(path.join(markerDir,createHash('sha256').update(id).digest('hex')+'.v1'),'corrupt');
 await start();
 assert.equal((await next('broken',report())).task,null,'corrupt per-Agent floor cannot authorize lookup');
 assert.equal((await next('broken-stop',report())).task.type,'alipay_name_stop');
 assert.equal((await next('broken-other',report())).task.type,'sms_query');
 await stop();await fs.rename(markerDir,savedDir);await fs.writeFile(markerDir,'directory unavailable');await start();
 assert.equal((await next('dir-query',report())).task,null,'unreadable floor store is not legacy absence');
 assert.equal((await next('dir-stop',report(),{lookupReaderCapacityProtocol:'1'})).task.type,'alipay_name_stop');
 assert.equal((await next('dir-other',report(),{lookupReaderCapacityProtocol:'1'})).task.type,'sms_query');


});
