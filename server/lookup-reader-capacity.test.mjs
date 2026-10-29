import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture(){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{if(!options?.recovery)c.queryIdentity=c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1');r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
 let service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});
 const configure=(numbers=[51,52,54,55,87,138,152])=>service.configure({enabled:true,devices:numbers.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'fixture-allowed'}]},'test');
 const prepare=(key='prepare-key-1')=>service.prepare({clientId:'a',key});
 const readyStart=async c=>{obs.set(c.deviceId,{ready:true});await service.tick();};
 const result=async(c,name='名',status='succeeded')=>{obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId||store.snapshot().channels.find(x=>x.deviceId===c.deviceId).queryId,status,name}});await service.tick();};
 const twoReady=async()=>{await prepare();await service.tick();let cs=store.snapshot().channels.slice(0,2);for(const c of cs)await readyStart(c);for(const c of cs)await result(c);return cs;};
 return {get service(){return service;},store,adapter,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}


import {lookupHumanRecoveryUnresolved} from './automation-center.mjs';
import {lookupFailureDomain} from './lookup-failure-domain.mjs';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
import fs from 'node:fs';
const text=fs.readFileSync(new URL('../windows-agent/src/index.mjs',import.meta.url),'utf8');
const classifier=new Function(text.slice(text.indexOf('function alipayAccountSwitchReasonFromError('),text.indexOf('async function observeLookupHumanVerification('))+';return classifyAlipayNameLookupFailure;')();
const capacityJob=()=>({kind:'alipay_name_query',result:{errorCode:'alipay_lookup_failed',diagnostic:classifier('Airtest/Poco 常驻 worker 已达到上限 8，当前均在执行任务')}});
function capacity(f,c,jobId='capacity-1',start=false){
 f.adapter.preparationFailure=x=>x.deviceId===c.deviceId?{domain:'capacity',code:'alipay_lookup_failed',jobId}:null;
 f.obs.set(c.deviceId,start?{stopped:true,startFailed:true}:{ready:true,recovery:true,recoveryFailure:{domain:'capacity',jobId},result:{resultId:c.queryId,status:'needs_recovery'}});
}
function groups(f){f.adapter.readerCapacityGroup=id=>['d51','d52','d54'].includes(id)?'agent:one':'agent:two';}
test('actual Agent classification enters resumable lifecycle, bypassing image AI and account limits',()=>{
 const j=capacityJob();assert.equal(j.result.diagnostic.runnerReason,'lookup_worker_capacity_reached');assert.equal(lookupFailureDomain(j),'capacity');assert.equal(lookupHumanRecoveryUnresolved(j,'failed'),true);assert.equal(lookupHumanRecoveryUnresolved(j,'running'),false);assert.equal(lookupHumanRecoveryUnresolved(j,'failed',{limitReached:true}),false);
 const job={...j,jobId:'j',resultId:'q',sessionId:'s',deviceId:'d',windowsTaskId:'t',status:'failed'};
 const state={automationJobs:[job],windowsTasks:[{taskId:'t',status:'failed'}],automationSessions:[{sessionId:'s',deviceId:'d',status:'ready',results:[{resultId:'q',status:'needs_recovery'}]}],devices:[],windowsAgents:[]};
 const a=createManagedLookupAdapter({state,online:()=>true}),c={sessionId:'s',deviceId:'d',queryId:'q'};assert.equal(a.preparationFailure(c).domain,'capacity');assert.equal(a.observe(c).recoveryFailure.domain,'capacity');assert.equal(a.aiEvidence(c,{}) ,null);
});
test('start saturation pauses new probes on same Agent, without isolating phones; other Agent proceeds',async()=>{
 const f=fixture();groups(f);await f.configure([51,52,54,87]);await f.service.configure({concurrency:2},'test');await f.prepare();await f.service.tick();
 const c=f.store.snapshot().channels.find(c=>c.deviceId==='d51');capacity(f,c,'start-capacity',true);await f.service.tick();await f.service.tick();
 let s=f.store.snapshot();assert.equal(s.devices.find(d=>d.deviceId==='d51').prepareFailureCount,0);assert.equal(s.devices.find(d=>d.deviceId==='d51').preparationIssue,undefined);assert.ok(f.events.some(e=>e.kind==='start'&&e.device==='d87'));assert.ok(!f.events.some(e=>e.kind==='start'&&e.device==='d54'));
 f.advance(29999);await f.service.tick();assert.ok(!f.events.some(e=>e.kind==='start'&&e.device==='d54'));assert.equal(f.service.aiCandidates().length,0);
});
test('capacity failure preserves original ID through ACK, other warmed phone completes, no permanent exclusion',async()=>{
 const f=fixture();groups(f);await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);capacity(f,c);
 f.adapter.stop=async c=>{f.events.push({kind:'stop',device:c.deviceId});f.obs.set(c.deviceId,{busy:true});};await f.service.tick();assert.equal((await f.submit('replacement-client-key')).lookupId,r.lookupId);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();const next=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);assert.ok(next);assert.notEqual(next.deviceId,c.deviceId);await f.result(next,'续');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'续');
 const d=f.store.snapshot().devices.find(d=>d.deviceId===c.deviceId);assert.equal(d.prepareFailureCount,0);assert.equal(d.lookupUnavailable,false);assert.equal(d.preparationIssue,undefined);assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).recoveryExcludedDevices,undefined);
});
test('capacity wait persists restart, expires once and requires new probe; stop never dispatches queued work',async()=>{
 const f=fixture();groups(f);await f.configure([51,52]);await f.prepare();await f.service.tick();for(const c of f.store.snapshot().channels){capacity(f,c,'start-'+c.deviceId,true);await f.service.tick();await f.service.tick();}
 f.restart();f.advance(29999);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,2);f.advance(1);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,4);assert.equal((await f.prepare()).ready,false);
 await f.service.stopRound({clientId:'a',key:'stop-capacity-test',preparationId:f.store.snapshot().preparations[0].preparationId});await f.service.tick();await f.service.tick();const count=f.events.length;f.advance(60000);await f.service.tick();assert.equal(f.events.length,count);
});
