import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function moduleUri(serviceSource,preinputSource,baseUrl){
 const rewrite=(s,override)=>s.replace(/from\s*(['"])(\.\/[^'"]+)\1/g,(all,q,p)=>'from '+q+(override?.[p]||new URL(p,baseUrl).href)+q);
 const pre='data:text/javascript;base64,'+Buffer.from(rewrite(preinputSource)).toString('base64');
 return 'data:text/javascript;base64,'+Buffer.from(rewrite(serviceSource,{'./wecom-preinput-recovery.mjs':pre})).toString('base64');
}
export function recoveryFunctionHash(source){const start=source.indexOf('  async function recoveryStart('),end=source.indexOf('\n  function recoveryLease',start);assert.ok(start>=0&&end>start);return hash(source.slice(start,end).trim());}
export async function applyHotpatch({origin,serviceSource,preinputSource,beforeHash,afterHash,expectedPid,apply=false,closeInspector=false}){
 const target=new URL(origin);assert.ok(target.protocol==='http:'&&target.hostname==='127.0.0.1'&&!target.username&&!target.password&&!target.search);
 const list=await(await fetch(new URL('/json/list',target),{signal:AbortSignal.timeout(3000)})).json();assert.equal(list.length,1);
 const wsurl=new URL(list[0].webSocketDebuggerUrl);assert.equal(wsurl.hostname,'127.0.0.1');assert.equal(wsurl.port,target.port);
 const socket=new WebSocket(wsurl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Error('inspector_connect_failed')),{once:true});});
 let seq=0;const pending=new Map(),commands=[];const group='wecom_recovery_'+randomUUID();
 socket.addEventListener('message',event=>{let m;try{m=JSON.parse(event.data);}catch{return;}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error('inspector_rpc_failed:'+p.method));else p.resolve(m.result);});
 async function rpc(method,params={}){assert.ok(['Runtime.evaluate','Runtime.getProperties','Runtime.callFunctionOn','Runtime.releaseObjectGroup'].includes(method));commands.push(method);const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('inspector_rpc_timeout:'+method));},15000);pending.set(id,{resolve,reject,timer,method});socket.send(JSON.stringify({id,method,params}));});}
 const properties=async objectId=>(await rpc('Runtime.getProperties',{objectId,ownProperties:true}));
 async function scopes(fnId){const p=await properties(fnId);const id=p.internalProperties?.find(v=>v.name==='[[Scopes]]')?.value?.objectId;if(!id)return[];return(await properties(id)).result.filter(p=>/^\d+$/.test(p.name)).map(p=>p.value?.objectId).filter(Boolean);}
 try{
  const info=await rpc('Runtime.evaluate',{expression:'({pid:process.pid,uptime:process.uptime()})',returnByValue:true});assert.equal(info.result.value.pid,expectedPid);
  const listeners=await rpc('Runtime.evaluate',{expression:"process._getActiveHandles().filter(h=>h&&typeof h.listeners==='function'&&h.listeners('request').length).flatMap(h=>h.listeners('request'))",objectGroup:group});
  const functions=(await properties(listeners.result.objectId)).result.filter(p=>/^\d+$/.test(p.name)&&p.value?.type==='function');let service;
  for(const fn of functions){for(const sid of await scopes(fn.value.objectId)){const values=(await properties(sid)).result;const found=values.find(p=>p.name==='wecomCleanup'&&p.value?.objectId);if(found){service=found.value;break;}}if(service)break;}
  assert.ok(service,'service_scope_not_found');const method=(await properties(service.objectId)).result.find(p=>p.name==='recoveryStart');assert.ok(method?.value?.objectId);
  function imports(source){const rows=[];const body=source.replace(/^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];\s*/gm,(_,entries,spec)=>{rows.push({spec,names:entries.split(',').map(v=>v.trim().split(/\s+as\s+/).at(-1)).filter(Boolean)});return'';});assert.ok(rows.length>=3);assert.ok(!/^import\b/m.test(body));return{rows,body:body.replace(/^export\s+/gm,''),exports:[...source.matchAll(/^export\s+(?:const|function)\s+(\w+)/gm)].map(m=>m[1])};}
  const svc=imports(serviceSource),pre=imports(preinputSource);
  const preSpec=svc.rows.find(r=>r.spec.endsWith('wecom-preinput-recovery.mjs'));assert.ok(preSpec);
  const names=['state','persist','conflict','clock','now','id','queues','committing','checkpointFences'];
  async function capture(fnId,wanted){const map={};for(const sid of await scopes(fnId)){for(const p of(await properties(sid)).result)if(wanted.includes(p.name)&&p.value&&!map[p.name])map[p.name]=p.value;if(wanted.every(n=>map[n]))break;}return map;}
  const serviceDeps=svc.rows.filter(r=>r!==preSpec).flatMap(r=>r.names);
  const config=await capture(method.value.objectId,[...names,...serviceDeps,'originalRecoveryContext']);
  assert.ok([...names,...serviceDeps,'originalRecoveryContext'].every(k=>config[k]),'service_options_scope_not_found');
  const preNames=pre.rows.flatMap(r=>r.names),preCaptured=await capture(config.originalRecoveryContext.objectId,preNames);assert.ok(preNames.every(k=>preCaptured[k]),'preinput_scope_not_found');
  const arg=v=>v.objectId?{objectId:v.objectId}:{value:v.value};
  const args=names.map(n=>arg(config[n]));args.push({value:svc.body},{value:pre.body},{value:svc.rows},{value:preNames},{value:pre.exports},{value:beforeHash},{value:afterHash},{value:apply});args.push(...serviceDeps.map(n=>arg(config[n])),...preNames.map(n=>arg(preCaptured[n])));
  const action=function(state,persist,conflict,clock,now,id,queues,committing,checkpointFences,serviceBody,preBody,serviceImports,preNames,preExports,beforeHash,afterHash,apply,...deps){
   const {createHash}=process.getBuiltinModule('node:crypto');const hash=x=>createHash('sha256').update(x).digest('hex');
   function check(){if(queues.size||committing.size||checkpointFences.size)throw Error('wecom_mutation_in_progress');if(state.automationJobs.some(j=>j.kind==='wecom_customer_preview'&&!['succeeded','failed','cancelled','expired'].includes(j.status)))throw Error('active_wecom_job');if(state.windowsTasks.some(t=>['wecom_customer_preview','wecom_cleanup_verify'].includes(t.type)&&!['succeeded','failed','cancelled','expired'].includes(t.status)))throw Error('active_wecom_task');if(hash(this.recoveryStart.toString())!==beforeHash)throw Error('service_source_drift');}
   check.call(this);
   const regularNames=serviceImports.filter(r=>!r.spec.endsWith('wecom-preinput-recovery.mjs')).flatMap(r=>r.names);
   const pre=Function(...preNames,'"use strict";\n'+preBody+'\nreturn {'+preExports.join(',')+'};')(...deps.slice(regularNames.length));
   let offset=0;const bindings=serviceImports.flatMap(r=>r.names.map(n=>r.spec.endsWith('wecom-preinput-recovery.mjs')?pre[n]:deps[offset++]));
   const mod=Function(...serviceImports.flatMap(r=>r.names),'"use strict";\n'+serviceBody+'\nreturn {createWecomCleanupService};')(...bindings);
   const replacement=mod.createWecomCleanupService({state,persist,conflict,clock,now,id});
   if(Object.keys(this).some(k=>typeof this[k]!=='function'||Object.getOwnPropertyDescriptor(this,k)?.writable!==true))throw Error('service_descriptor_drift');
   if(Object.keys(this).sort().join('|')!==Object.keys(replacement).sort().join('|')||hash(replacement.recoveryStart.toString())!==afterHash)throw Error('replacement_shape_or_source_mismatch');
   for(const lock of state.deviceLocks.filter(l=>l.lockType==='wecom_physical_cleanup'&&l.status!=='released'))if(replacement.pending(lock.deviceId)!==this.pending(lock.deviceId))throw Error('state_reference_changed');
   check.call(this);const symbol=Symbol.for('phonecloud.wecom.recovery.hotpatch');if(globalThis[symbol])throw Error('existing_hotpatch');
   const before={pid:process.pid,uptime:process.uptime(),state,clock,methods:{...this}};
   if(apply){globalThis[symbol]={service:this,...before,appliedAt:Date.now(),beforeHash,afterHash};Object.assign(this,replacement);}
   return{applied:apply,pid:process.pid,uptime:process.uptime(),sameState:true,sameClock:true,methods:Object.keys(replacement),beforeHash,afterHash,paused:false,restarted:false};
  };
  const result=await rpc('Runtime.callFunctionOn',{objectId:service.objectId,functionDeclaration:action.toString(),arguments:args,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error('hotpatch_denied:'+String(result.exceptionDetails.exception?.description||'unknown').split('\n')[0]);
  assert.equal(result.result.value.pid,expectedPid);assert.ok(commands.every(m=>m.startsWith('Runtime.')));
  return{...result.result.value,protocolCommands:commands.length,noDebuggerOrPauseCommand:true};
 }finally{await rpc('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});if(closeInspector)await rpc('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('node:inspector').close(),250);true",returnByValue:true}).catch(()=>{});socket.close();}
}
