import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

const hash=s=>createHash('sha256').update(s).digest('hex');
const marker='    compact.remarkSaveStatus = ["not_attempted", "unknown", "confirmed", "not_needed"].includes(result.remarkSaveStatus) ? result.remarkSaveStatus : "unknown";\n';
const addition=`    if (typeof result.remarkPhoneSet === "boolean") compact.remarkPhoneSet = result.remarkPhoneSet;
    if (result.invitationRequestConfirmed === true && result.invitationRequestProof === "wecom_system_dialog_v1") {
      compact.invitationRequestConfirmed = true;
      compact.invitationRequestProof = "wecom_system_dialog_v1";
    }
    if (result.previewCode === "wecom_add_friend_too_frequent" && result.addFriendLimitConfirmed === true
        && result.addFriendLimitProof === "wecom_system_dialog_v1") {
      compact.addFriendLimitConfirmed = true;
      compact.addFriendLimitProof = "wecom_system_dialog_v1";
    }
`;
export function validateDelta(before,after){
  assert.equal(before.split(marker).length,2,'source_marker');
  assert.equal(before.replace(marker,marker+addition),after,'only_reviewed_compactor_delta');
}

// Explicit operator tool. Never enables an Inspector, pauses, starts tasks, or
// changes files. The caller must independently attest the exact Windows PID.
export async function liveEditCompactor({origin,before,after,expectedPid,expectedEntry,apply=false,closeInspector=false}){
  validateDelta(before,after);
  const u=new URL(origin);assert.equal(u.protocol,'http:');assert.equal(u.hostname,'127.0.0.1');
  assert.ok(!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/');
  const response=await fetch(new URL('/json/list',u),{signal:AbortSignal.timeout(2000)});
  const targets=await response.json();assert.equal(targets.length,1);
  const wsurl=new URL(targets[0].webSocketDebuggerUrl);assert.equal(wsurl.hostname,'127.0.0.1');assert.equal(wsurl.port,u.port);
  const socket=new WebSocket(wsurl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Error('connect_failed')),{once:true});});
  let seq=0,paused=0,edited=false,scriptId;const pending=new Map(),scripts=new Map();const group='wecom_compactor_'+randomUUID();
  const methods=new Set(['Runtime.evaluate','Runtime.getProperties','Runtime.callFunctionOn','Runtime.releaseObjectGroup',
    'Debugger.enable','Debugger.disable','Debugger.setSkipAllPauses','Debugger.getScriptSource','Debugger.setScriptSource']);
  socket.addEventListener('message',event=>{
    const m=JSON.parse(event.data);
    if(m.method==='Debugger.scriptParsed')scripts.set(m.params.scriptId,m.params);
    if(m.method==='Debugger.paused')paused++;
    const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);
    m.error?p.reject(Error('rpc_failed:'+p.method)):p.resolve(m.result);
  });
  function rpc(method,params={}){
    assert.ok(methods.has(method),'forbidden_command');const id=++seq;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('rpc_timeout:'+method));},5000);pending.set(id,{resolve,reject,timer,method});socket.send(JSON.stringify({id,method,params}));});
  }
  const properties=async objectId=>rpc('Runtime.getProperties',{objectId,ownProperties:true});
  async function compactor(){
    const listeners=await rpc('Runtime.evaluate',{expression:"[...process.listeners('SIGTERM'),...process.listeners('SIGINT')]",objectGroup:group});
    for(const f of(await properties(listeners.result.objectId)).result.filter(p=>/^\d+$/.test(p.name)&&p.value?.type==='function')){
      const refs=await properties(f.value.objectId);const scopes=refs.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value?.objectId;if(!scopes)continue;
      for(const s of(await properties(scopes)).result.filter(p=>/^\d+$/.test(p.name)&&p.value?.objectId)){
        const found=(await properties(s.value.objectId)).result.find(p=>p.name==='compactTaskResultForStatus'&&p.value?.type==='function');if(found)return found.value.objectId;
      }
    }
    throw Error('compactor_scope_missing');
  }
  async function invoke(fn,input){
    const r=await rpc('Runtime.callFunctionOn',{objectId:fn,functionDeclaration:'function(input){return this(input);}',arguments:[{value:input}],returnByValue:true});
    assert.ok(!r.exceptionDetails,'fixture_call_failed');return r.result.value;
  }
  const preview={previewStatus:'ready_before_send',previewCode:'stopped_before_send',sendStatus:'not_attempted',remarkSaveStatus:'confirmed',remarkPhoneSet:true};
  const lookup={realNameTailCharacter:'测',alipayDisplayName:'fixture',notFound:false,diagnostic:{lookupExecution:{version:1,scope:'agent_command',durationMs:5,readerRebuildAttempts:0,appRestartAttempts:0,resultResumeAttempts:0}}};
  try{
    const info=await rpc('Runtime.evaluate',{expression:'({pid:process.pid,entry:process.argv[1],node:process.version})',returnByValue:true});
    assert.equal(info.result.value.pid,expectedPid);assert.equal(info.result.value.entry,expectedEntry);
    await rpc('Debugger.setSkipAllPauses',{skip:true});await rpc('Debugger.enable');
    const fn=await compactor();const location=(await properties(fn)).internalProperties?.find(p=>p.name==='[[FunctionLocation]]')?.value?.value;
    assert.ok(location?.scriptId,'function_location_missing');scriptId=location.scriptId;
    const script=scripts.get(scriptId);assert.ok(script,'script_identity');
    assert.equal(decodeURIComponent(new URL(script.url).pathname).replace(/^\/(?=[A-Za-z]:)/,'').replaceAll('\\','/').toLowerCase(),expectedEntry.replaceAll('\\','/').toLowerCase(),'script_identity');
    const source=await rpc('Debugger.getScriptSource',{scriptId});assert.equal(source.scriptSource,before,'live_source_drift');
    const baseline=await invoke(fn,lookup);assert.equal((await invoke(fn,preview)).remarkPhoneSet,undefined,'already_patched');
    const dry=await rpc('Debugger.setScriptSource',{scriptId,scriptSource:after,dryRun:true});assert.equal(dry.status,'Ok','liveedit_dry_run_rejected');assert.equal(paused,0,'unexpected_pause');
    if(!apply)return{applied:false,pid:expectedPid,node:info.result.value.node,dryRun:dry.status,paused,lookupFixtureUnchanged:true,beforeHash:hash(before),afterHash:hash(after)};
    const changed=await rpc('Debugger.setScriptSource',{scriptId,scriptSource:after});assert.equal(changed.status,'Ok','liveedit_rejected');edited=true;
    assert.equal((await rpc('Debugger.getScriptSource',{scriptId})).scriptSource,after);
    assert.deepEqual(await invoke(fn,lookup),baseline,'lookup_fixture_changed');
    assert.equal((await invoke(fn,preview)).remarkPhoneSet,true);
    assert.equal((await invoke(fn,{...preview,remarkPhoneSet:'true'})).remarkPhoneSet,undefined);
    const unknown=await invoke(fn,{...preview,sendStatus:'unknown'});assert.equal(unknown.sendStatus,'unknown');assert.equal(unknown.invitationSent,null);
    const proof=await invoke(fn,{...preview,invitationRequestConfirmed:true,invitationRequestProof:'wecom_system_dialog_v1'});assert.equal(proof.invitationRequestConfirmed,true);
    assert.equal((await invoke(fn,{...preview,invitationRequestConfirmed:true,invitationRequestProof:'wrong'})).invitationRequestConfirmed,undefined);
    assert.equal((await invoke(fn,{...preview,previewCode:'wecom_add_friend_too_frequent',addFriendLimitConfirmed:true,addFriendLimitProof:'wecom_system_dialog_v1'})).addFriendLimitConfirmed,true);
    assert.equal(paused,0,'unexpected_pause');edited=false;
    return{applied:true,pid:expectedPid,node:info.result.value.node,paused,restarted:false,lookupFixtureUnchanged:true,previewFieldFixturesPassed:true,beforeHash:hash(before),afterHash:hash(after)};
  }catch(error){
    if(edited&&scriptId){const reverted=await rpc('Debugger.setScriptSource',{scriptId,scriptSource:before});assert.equal(reverted.status,'Ok','rollback_rejected');}
    throw error;
  }finally{
    await rpc('Debugger.disable').catch(()=>{});await rpc('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});
    if(closeInspector)await rpc('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('node:inspector').close(),250);true",returnByValue:true}).catch(()=>{});
    socket.close();
  }
}
