// Localhost-only maintenance, Runtime protocol only. No Debugger/pause, no ADB.
import fs from 'node:fs/promises';import {createHash,randomUUID}from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const mode=process.argv[2]||'inspect';if(!['inspect','activate','retire'].includes(mode))throw Error('invalid_mode');
const plan=JSON.parse(await fs.readFile('/tmp/device18-plan.json','utf8'));
const groups='device18_'+randomUUID();let sequence=0;const pending=new Map();
const targets=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(3000)})).json();
if(targets.length!==1)throw Error('inspector_target_ambiguous');
const address=new URL(targets[0].webSocketDebuggerUrl);if(address.hostname!=='127.0.0.1'||address.port!=='9229')throw Error('inspector_origin_invalid');
const socket=new WebSocket(address);await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
socket.addEventListener('message',event=>{const m=JSON.parse(event.data);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.no(Error('runtime_rpc_failed:'+p.method+':'+m.error.code+':'+m.error.message)):p.ok(m.result);});
async function rpc(method,params={}){
 if(!['Runtime.evaluate','Runtime.getProperties','Runtime.callFunctionOn','Runtime.releaseObjectGroup'].includes(method))throw Error('forbidden_protocol');
 return new Promise((ok,no)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);no(Error('runtime_rpc_timeout'));},20000);pending.set(id,{ok,no,timer,method});socket.send(JSON.stringify({id,method,params}));});
}
const props=async id=>(await rpc('Runtime.getProperties',{objectId:id,ownProperties:true}));
const arg=v=>v.objectId?{objectId:v.objectId}:{value:v.value};
async function scope(fn){const p=await props(fn);const list=p.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value?.objectId;if(!list)return[];return(await props(list)).result.filter(p=>/^\d+$/.test(p.name)).map(p=>p.value?.objectId).filter(Boolean);}
async function call(objectId,fn,args=[]){const r=await rpc('Runtime.callFunctionOn',{objectId,functionDeclaration:fn.toString(),arguments:args,awaitPromise:fn.constructor.name==='AsyncFunction',returnByValue:true});if(r.exceptionDetails)throw Error('maintenance_denied:'+String(r.exceptionDetails.exception?.description||'unknown').split('\n')[0]);return r.result?.value;}
try{
 const pid=await rpc('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(pid.result.value!==1)throw Error('wrong_process');
 const listeners=await rpc('Runtime.evaluate',{expression:"process._getActiveHandles().filter(h=>h&&typeof h.listeners==='function'&&h.listeners('request').length).flatMap(h=>h.listeners('request'))",objectGroup:groups});
 const wanted=['state','structuredRepos','getPostgresPool','stringifyPostgresJson','createPostgresRepositories','publicDevice','STRUCTURED_TABLE_SYNC'];let captured;
 for(const l of(await props(listeners.result.objectId)).result.filter(p=>/^\d+$/.test(p.name)&&p.value?.type==='function')){
  for(const s of await scope(l.value.objectId)){const values=(await props(s)).result;const c=Object.fromEntries(values.filter(p=>wanted.includes(p.name)&&p.value).map(p=>[p.name,p.value]));if(wanted.every(k=>c[k])){captured=c;break;}}
  if(captured)break;
 }
 if(!captured||captured.STRUCTURED_TABLE_SYNC.value!==false)throw Error('runtime_scope_or_storage_mode_unconfirmed');
 const factoryHash=await call(captured.createPostgresRepositories.objectId,function(){return process.getBuiltinModule('node:crypto').createHash('sha256').update(this.toString()).digest('hex');});
 if(factoryHash!==plan.originalFactorySha256)throw Error('original_factory_drift');
 if(mode==='inspect'){
  const result=await call(captured.state.objectId,function(plan,publicDevice){
   const old=this.devices.find(d=>d.deviceId===plan.oldDeviceId),next=this.devices.find(d=>d.deviceId===plan.newDeviceId);
   if(!old||!next||old.deviceName!=='18'||next.deviceName!=='18'||old.adb?.state==='device'||old.recovery?.physicalPresent!==false||next.adb?.state!=='device'||publicDevice(old).occupancy||publicDevice(next).occupancy)throw Error('device_identity_or_occupancy_changed');
   return {oldDeviceId:old.deviceId,newDeviceId:next.deviceId,oldOffline:true,newOnline:true,bothIdle:true,oldAccountCount:old.xhsAccounts.filter(a=>a.xhsId).length,newAccountCount:next.xhsAccounts.filter(a=>a.xhsId).length,userDeviceReferences:this.users.filter(u=>JSON.stringify(u).includes(plan.oldDeviceId)).length};
  },[{value:plan},arg(captured.publicDevice)]);console.log(JSON.stringify({mode,...result,noPause:true}));
 }else if(mode==='activate'){
  const bytes=await fs.readFile('/app/server/postgres-repositories.mjs');if(hash(bytes)!==plan.repositorySha256)throw Error('candidate_file_drift');
  const imported=await rpc('Runtime.evaluate',{expression:"import('file:///app/server/postgres-repositories.mjs?device18-retirement="+encodeURIComponent(plan.operationId)+"')",awaitPromise:true,objectGroup:groups});if(imported.exceptionDetails)throw Error('candidate_import_failed');
  const factory=(await props(imported.result.objectId)).result.find(p=>p.name==='createPostgresRepositories')?.value;if(!factory?.objectId)throw Error('candidate_factory_missing');
  const result=await call(captured.structuredRepos.objectId,function(factory,getPool,stringify,plan){
   const symbol=Symbol.for('phonecloud.device18.retirement.repositories');if(globalThis[symbol])throw Error('repository_patch_already_applied');
   const replacement=factory({getPool,stringify});const keys=Object.keys(this).sort();if(keys.join('|')!==Object.keys(replacement).sort().join('|')||keys.some(k=>typeof this[k]!=='function'||typeof replacement[k]!=='function'||Object.getOwnPropertyDescriptor(this,k)?.writable!==true))throw Error('repository_shape_changed');
   globalThis[symbol]={object:this,original:{...this},operationId:plan.operationId,appliedAt:Date.now()};Object.assign(this,replacement);
   return {activated:true,sameRepositoryObject:true,samePoolFactory:true,methods:keys.length,restarted:false,paused:false};
  },[arg(factory),arg(captured.getPostgresPool),arg(captured.stringifyPostgresJson),{value:plan}]);console.log(JSON.stringify({mode,...result}));
 }else{
  const result=await call(captured.state.objectId,async function(plan,getPool,publicDevice){
   const symbol=globalThis[Symbol.for('phonecloud.device18.retirement.repositories')];if(symbol?.operationId!==plan.operationId)throw Error('retirement_write_guard_not_active');
   const crypto=process.getBuiltinModule('node:crypto'),digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
   const accounts=d=>(d.xhsAccounts||[]).map(a=>({appSlot:a.appSlot,label:a.label,xhsId:a.xhsId,accountName:a.accountName,enabled:a.enabled}));
   const sims=d=>(d.sims||[]).map(s=>({slotIndex:s.slotIndex,phoneNumber:s.phoneNumber,enabled:s.enabled})).sort((a,b)=>a.slotIndex-b.slotIndex);
   const old=this.devices.find(d=>d.deviceId===plan.oldDeviceId),next=this.devices.find(d=>d.deviceId===plan.newDeviceId);
   if(!old||!next||old.deviceName!=='18'||next.deviceName!=='18'||old.adb?.state==='device'||old.recovery?.physicalPresent!==false||next.adb?.state!=='device'||next.listingStatus!=='unlisted'||old.listingStatus!=='unlisted'||publicDevice(old).occupancy||publicDevice(next).occupancy||old.xhsAccounts.some(a=>a.xhsId)||digest(accounts(next))!==plan.accountsSha256||digest(sims(next))!==plan.simsSha256)throw Error('replacement_scope_changed');
   const pool=await getPool();await new Promise(r=>setImmediate(r));const until=Date.now()+3000;
   while(pool.waitingCount||pool.idleCount!==pool.totalCount){if(Date.now()>until)throw Error('existing_repository_writes_busy');await new Promise(r=>setTimeout(r,25));}
   const client=await pool.connect();const at=new Date().toISOString();let committed=false;
   const audit={auditId:plan.auditId,action:'device_hardware_replaced',actor:'admin',createdAt:at,detail:{oldDeviceId:plan.oldDeviceId,newDeviceId:plan.newDeviceId,movedXhsAccounts:2,simsChanged:false,backupSha256:plan.backupSha256}};
   try{
    await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='1s'");await client.query("SET LOCAL statement_timeout='3s'");
    const rows=(await client.query('SELECT device_id,data FROM phone_cloud_devices WHERE device_id=ANY($1::text[]) ORDER BY device_id FOR UPDATE',[[plan.oldDeviceId,plan.newDeviceId]])).rows;
    const a=rows.find(r=>r.device_id===plan.oldDeviceId)?.data,b=rows.find(r=>r.device_id===plan.newDeviceId)?.data;
    if(!a||!b||a.inventoryRetiredAt||a.adb?.state==='device'||a.xhsAccounts.some(x=>x.xhsId)||digest(accounts(b))!==plan.accountsSha256||digest(sims(b))!==plan.simsSha256)throw Error('database_binding_changed');
    const archived={...a,inventoryRetiredAt:at,inventoryRetirementId:plan.operationId,replacementDeviceId:plan.newDeviceId};
    await client.query('UPDATE phone_cloud_devices SET data=$2::jsonb,updated_at=now() WHERE device_id=$1',[plan.oldDeviceId,JSON.stringify(archived)]);
    await client.query('INSERT INTO phone_cloud_audit_events(audit_id,created_at,data)VALUES($1,$2,$3::jsonb)',[audit.auditId,audit.createdAt,JSON.stringify(audit)]);
    await client.query('COMMIT');committed=true;
   }catch(e){await client.query('ROLLBACK').catch(()=>{});const r=await pool.query({text:'SELECT data->>\'inventoryRetirementId\' AS id FROM phone_cloud_devices WHERE device_id=$1',values:[plan.oldDeviceId],query_timeout:4000});if(r.rows[0]?.id===plan.operationId)committed=true;else throw e;}finally{client.release();}
   if(!committed)throw Error('retirement_commit_unknown');
   const index=this.devices.findIndex(d=>d.deviceId===plan.oldDeviceId);if(index>=0)this.devices.splice(index,1);this.audit.unshift(audit);
   return {archived:true,removedFromInventory:true,oldDeviceId:plan.oldDeviceId,newDeviceId:plan.newDeviceId,retiredAt:at,remainingNumber18:this.devices.filter(d=>d.deviceName==='18').length,historicalTasksAndSmsDeleted:0,fullSnapshotRewritten:false};
  },[{value:plan},arg(captured.getPostgresPool),arg(captured.publicDevice)]);console.log(JSON.stringify({mode,...result}));
 }
}finally{
 await rpc('Runtime.releaseObjectGroup',{objectGroup:groups}).catch(()=>{});
 await rpc('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('node:inspector').close(),100);true",returnByValue:true}).catch(()=>{});socket.close();
}
