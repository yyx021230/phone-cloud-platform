// Localhost-only maintenance, Runtime protocol only. No Debugger/pause, no ADB.
import fs from 'node:fs/promises';import {createHash,randomUUID}from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const mode=process.argv[2]||'inspect';if(!['inspect','apply'].includes(mode))throw Error('invalid_mode');
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
 const listeners=await rpc('Runtime.evaluate',{expression:"process._getActiveHandles().filter(h=>h&&typeof h.listeners==='function'&&h.listeners('request').length).flatMap(h=>h.listeners('request'))",objectGroup:groups});
 const wanted=['engine'];let captured;
 for(const l of(await props(listeners.result.objectId)).result.filter(p=>/^\d+$/.test(p.name)&&p.value?.type==='function')){
  for(const s of await scope(l.value.objectId)){const values=(await props(s)).result;const c=Object.fromEntries(values.filter(p=>wanted.includes(p.name)&&p.value).map(p=>[p.name,p.value]));if(wanted.every(k=>c[k])){captured=c;break;}}
  if(captured)break;
 }
 if(!captured)throw Error('batch_runtime_scope_unconfirmed');
 const module=await rpc('Runtime.evaluate',{expression:"process.getBuiltinModule('node:module').createRequire('file:///app/server/index.mjs')('/app/server/xhs-batch/engine.mjs').validateClients",awaitPromise:false,objectGroup:groups});
 if(module.exceptionDetails)throw Error('batch_validator_import_failed');
 const validate=module.result;if(!validate?.objectId)throw Error('batch_validator_missing');
 const result=await call(captured.engine.objectId,async function(plan,validateClients,mode){
  const crypto=process.getBuiltinModule('node:crypto'),fs=process.getBuiltinModule('node:fs');
  const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
  const clients=[...this.clients.values()];
  const select=list=>list.flatMap(c=>c.targets).filter(t=>t.deviceId===plan.oldDeviceId);
  if(select(clients).length!==1||select(clients)[0].xhsId!=='63033691880'||select(clients)[0].appSlot!=='app1')throw Error('batch_target_binding_changed');
  const currentFile=fs.readFileSync(process.env.XHS_BATCH_CONFIG_FILE);
  if(hash(currentFile)!==(mode==='apply'?plan.batchConfigAfterSha256:plan.batchConfigBeforeSha256))throw Error('batch_disk_config_drift');
  const normalized=validateClients(JSON.parse(currentFile).clients);
  if(mode==='apply'){
   const changed=normalized.flatMap(c=>c.targets).filter(t=>t.deviceId===plan.newDeviceId&&t.xhsId==='63033691880'&&t.appSlot==='app1');
   if(changed.length!==1)throw Error('batch_new_target_missing');changed[0].deviceId=plan.oldDeviceId;
  }
  if(JSON.stringify(normalized)!==JSON.stringify(clients))throw Error('batch_file_memory_shape_drift');
  const apply=async()=>{
   const active=await this.store.runs({active:true,limit:1});if(active.length)throw Error('batch_has_active_run');
   if(mode==='apply'){
    select(clients).forEach(t=>{t.deviceId=plan.newDeviceId;});
   }
   return {mode,targetCount:1,appSlot:'app1',xhsId:'63033691880',oldDeviceId:plan.oldDeviceId,newDeviceId:plan.newDeviceId,activeRuns:0,changed:mode==='apply',credentialsChanged:false,schedulesChanged:false,historyChanged:false,restarted:false};
  };
  return mode==='apply'?await this.serial(apply):await apply();
 },[{value:plan},arg(validate),{value:mode}]);
 console.log(JSON.stringify(result));
}finally{
 await rpc('Runtime.releaseObjectGroup',{objectGroup:groups}).catch(()=>{});
 await rpc('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('node:inspector').close(),100);true",returnByValue:true}).catch(()=>{});socket.close();
}
