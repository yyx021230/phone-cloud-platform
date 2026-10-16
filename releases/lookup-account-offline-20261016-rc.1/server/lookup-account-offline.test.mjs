import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture(){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
 let service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});
 const configure=(numbers=[51,52,54,55,87,138,152])=>service.configure({enabled:true,devices:numbers.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'fixture-allowed'}]},'test');
 const prepare=(key='prepare-key-1')=>service.prepare({clientId:'a',key});
 const readyStart=async c=>{obs.set(c.deviceId,{ready:true});await service.tick();};
 const result=async(c,name='名',status='succeeded')=>{obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId||store.snapshot().channels.find(x=>x.deviceId===c.deviceId).queryId,status,name}});await service.tick();};
 const twoReady=async()=>{await prepare();await service.tick();let cs=store.snapshot().channels.slice(0,2);for(const c of cs)await readyStart(c);for(const c of cs)await result(c);return cs;};
 return {get service(){return service;},store,adapter,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}

import {lookupAccountOfflineEvidence,pendingAccountOfflineNotifications,recordAccountOffline} from './lookup-account-offline.mjs';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
import {createLookupHumanNotifier} from './lookup-human-notifications.mjs';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';

const offline=(id='login-1',account='138******01')=>({jobId:id,account,accountSource:'selected_target',reason:'account_login_required'});
const loginJob=(extra={})=>({jobId:'j1',sessionId:'s1',deviceId:'d51',kind:'alipay_name_start',status:'failed',createdAt:'2026-10-16T01:00:00Z',result:{errorCode:'alipay_login_required'},...extra});
test('login classification distinguishes actual login Activity, normal home, picker and generic errors',()=>{
 for(const currentActivity of ['com.eg.android.AlipayGphone/.AlipayLogin','com.eg.android.AlipayGphone/.AccountManagerActivity',''])assert.equal(lookupAccountOfflineEvidence(loginJob({result:{errorCode:'alipay_page_element_changed',currentActivity}})),null);
 const currentActivity='mCurrentFocus=Window{abc u0 com.eg.android.AlipayGphone/com.ali.user.mobile.loginupgrade.activity.LoginActivity type=1}';
 assert.equal(lookupAccountOfflineEvidence(loginJob({result:{errorCode:'alipay_lookup_failed',currentActivity}})).reason,'account_login_required');
 assert.equal(lookupAccountOfflineEvidence(loginJob({result:{currentActivity:'com.eg.android.AlipayGphone/com.ali.user.mobile.loginupgrade.activity.LoginActivity'}})).reason,'account_login_required');
 assert.equal(lookupAccountOfflineEvidence(loginJob({status:'running'})),null);
 assert.equal(lookupAccountOfflineEvidence(loginJob({kind:'alipay_name_stop'})),null);
});
test('selected target wins over stale current account; unknown and last-known identities are honest',()=>{
 const j=loginJob({result:{errorCode:'alipay_login_required',currentAccount:'13800000001'},events:[{stepId:'account_selected',detail:{toAccount:'13900000002'}}]});
 assert.equal(lookupAccountOfflineEvidence(j).account,'139******02');
 assert.equal(lookupAccountOfflineEvidence(j).accountSource,'selected_target');
 assert.equal(lookupAccountOfflineEvidence(loginJob()).accountSource,'unknown');
 assert.equal(lookupAccountOfflineEvidence(loginJob(),{currentAccount:'138******01'}).accountSource,'last_confirmed');
 const history=loginJob({result:{diagnostic:{code:'alipay_login_required',accountSwitchHistory:[{toAccount:'139******02'}]}}});
 assert.equal(lookupAccountOfflineEvidence(history).account,'139******02');
});
test('first-account logout is excluded for this round, survives restart, and never increments hard failure circuit',async()=>{
 const f=fixture();await f.configure([51,52,54]);await f.prepare();await f.service.tick();const c=f.store.snapshot().channels[0];
 f.obs.set(c.deviceId,{accountOffline:offline(),stopped:true,ready:false});await f.service.tick();await f.service.tick();
 let d=f.store.snapshot().devices.find(d=>d.deviceId===c.deviceId);assert.equal(d.lookupUnavailable,false);assert.equal(d.prepareFailureCount,0);
 assert.equal(f.service.admin().devices.find(d=>d.deviceId===c.deviceId).health.reason,'account_login_required');
 const count=f.events.filter(e=>e.kind==='start'&&e.device===c.deviceId).length;
 for(let i=0;i<3;i++){f.advance(31000);await f.prepare();await f.service.tick();}
 assert.equal(f.events.filter(e=>e.kind==='start'&&e.device===c.deviceId).length,count);
 f.restart();await f.prepare();await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start'&&e.device===c.deviceId).length,count);
 await f.prepare('next-explicit-start');await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start'&&e.device===c.deviceId).length,count+1);
 const next=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId);assert.ok(next);await f.readyStart(next);await f.result(next);
 d=f.store.snapshot().devices.find(d=>d.deviceId===c.deviceId);assert.equal(d.accountOffline,undefined);assert.equal(d.prepareFailureCount,0);
});
test('business login loss keeps same task ID and waits for stop ACK before handoff; other phone continues',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const a=await f.submit(),b=await f.submit('second-business','13900000001');await f.service.tick();
 const c=f.store.snapshot().channels.find(c=>c.requestId===a.lookupId),other=f.store.snapshot().channels.find(c=>c.requestId===b.lookupId);
 f.obs.set(c.deviceId,{accountOffline:offline('switch-login'),ready:false,result:{resultId:c.queryId,status:'failed'}});await f.service.tick();
 assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===a.lookupId).status,'rerouting');
 assert.equal((await f.submit('changed-request-key')).lookupId,a.lookupId);
 assert.equal(f.events.filter(e=>e.id===a.lookupId&&e.kind==='query').length,1);
 await f.result(other,'名');await f.service.tick();const replacement=f.store.snapshot().channels.find(c=>c.requestId===a.lookupId);
 assert.equal(replacement.deviceId,other.deviceId);await f.result(replacement,'新');assert.equal((await f.service.getAsyncResult(a.lookupId,'a')).name,'新');
 assert.equal(f.events.filter(e=>e.id===a.lookupId&&e.kind==='query').length,2);
 assert.equal(f.store.snapshot().devices.find(d=>d.deviceId===c.deviceId).prepareFailureCount,0);
});
test('stop ACK, not terminal login alone, releases an active phone reservation',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const a=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===a.lookupId);
 f.adapter.stop=async()=>{f.obs.set(c.deviceId,{busy:true});};f.obs.set(c.deviceId,{accountOffline:offline()});await f.service.tick();await f.service.tick();
 assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).phase,'stopping');assert.equal(f.events.filter(e=>e.id===a.lookupId&&e.kind==='query').length,1);
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();assert.equal(f.events.filter(e=>e.id===a.lookupId&&e.kind==='query').length,2);
});
test('cancellation during login cleanup does not requeue the original phone number',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const a=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===a.lookupId);
 f.obs.set(c.deviceId,{accountOffline:offline()});await f.service.tick();await f.service.cancel(a.lookupId,'test');await f.service.tick();
 assert.equal((await f.service.getAsyncResult(a.lookupId,'a')).status,'failed');assert.equal(f.events.filter(e=>e.id===a.lookupId&&e.kind==='query').length,1);
});
test('a fresh explicit prepare converts only evidenced legacy login isolation and preserves cooldowns',async()=>{
 const f=fixture();await f.configure([51,52]);await f.store.transact(s=>{for(const d of s.devices){d.lookupUnavailable=true;d.prepareFailureCount=3;d.quarantineUntil=Date.now()+999999;d.fixtureCooldowns=[{account:'138******01',cooldownUntil:'2030-01-01T00:00:00Z'}];}});
 f.adapter.legacyLoginIsolation=id=>id==='d51'?offline('old-three-logins'):null;await f.prepare();await f.service.tick();const s=f.store.snapshot();
 assert.equal(s.devices[0].lookupUnavailable,false);assert.equal(s.devices[0].prepareFailureCount,0);assert.ok(s.devices[0].accountOffline);assert.equal(s.devices[1].lookupUnavailable,true);
 assert.deepEqual(s.devices[0].fixtureCooldowns,[{account:'138******01',cooldownUntil:'2030-01-01T00:00:00Z'}]);assert.ok(s.channels.some(c=>c.deviceId==='d51'));assert.ok(!s.channels.some(c=>c.deviceId==='d52'));
});
test('unknown execution is never replayed merely because an old login observation is present',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const a=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===a.lookupId);
 f.obs.set(c.deviceId,{unknown:true,accountOffline:offline()});await f.service.tick();await f.service.tick();
 assert.equal(f.events.filter(e=>e.id===a.lookupId&&e.kind==='query').length,1);assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===a.lookupId).status,'unknown');
});
test('received result wins a racing login-loss observation and is not replayed',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const a=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===a.lookupId);
 f.obs.set(c.deviceId,{accountOffline:offline(),stopped:true,ready:false,result:{resultId:c.queryId,status:'succeeded',name:'已得'}});await f.service.tick();await f.service.tick();await f.service.tick();
 assert.ok(f.store.snapshot().devices.find(d=>d.deviceId===c.deviceId).accountOffline);
 assert.equal((await f.service.getAsyncResult(a.lookupId,'a')).name,'已得');assert.equal(f.events.filter(e=>e.id===a.lookupId&&e.kind==='query').length,1);
});
test('configuration edits preserve logout state; new prepare polling cannot fake readiness',async()=>{
 const f=fixture();await f.configure([51,52]);await f.prepare();await f.service.tick();const c=f.store.snapshot().channels[0];f.obs.set(c.deviceId,{stopped:true,accountOffline:offline()});await f.service.tick();await f.service.tick();
 await f.configure([51,52]);assert.ok(f.store.snapshot().devices[0].accountOffline);await f.prepare('explicit-new-round');assert.equal((await f.prepare('explicit-new-round')).ready,false);
 f.advance(31000);await f.service.tick();const nc=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId);await f.readyStart(nc);await f.result(nc,'','not_found');assert.ok(f.store.snapshot().devices[0].accountOffline);
});
test('legacy isolation conversion requires all three recent failures to prove login, preserving unrelated circuit',()=>{
 const jobs=[0,1,2].map(i=>loginJob({jobId:'j'+i,createdAt:'2026-10-16T01:00:0'+i+'Z'}));const state={automationJobs:jobs,automationSessions:[]};const a=createManagedLookupAdapter({state});
 assert.equal(a.legacyLoginIsolation('d51').jobId,'j2');jobs[0].result={errorCode:'device_not_online'};assert.equal(a.legacyLoginIsolation('d51'),null);
 jobs[0].result={errorCode:'alipay_login_required'};jobs[2].status='succeeded';assert.equal(a.legacyLoginIsolation('d51'),null);
});
test('adapter exposes terminal login before failed-start/generic-recovery and hides historical failures behind active work',()=>{
 const job=loginJob(),s={sessionId:'s1',status:'failed',results:[],pendingJobId:''};const state={automationJobs:[job],automationSessions:[s],windowsTasks:[],devices:[]};const a=createManagedLookupAdapter({state,online:()=>true});
 assert.equal(a.observe({sessionId:'s1'}).accountOffline.reason,'account_login_required');
 s.pendingJobId='j1';job.windowsTaskId='t';state.windowsTasks.push({taskId:'t',status:'running'});assert.equal(a.observe({sessionId:'s1'}).accountOffline,undefined);
});
test('group notice identifies phone/account, deduplicates scans and restart, never calls captcha login',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-login-notice-'));const state={devices:[{deviceId:'d51'}],preparations:[{clientId:'a',preparationId:'p',loginEpoch:'e'}]};const c={deviceId:'d51'};recordAccountOffline(state,c,offline(),Date.now());const devices=[{deviceId:'d51',deviceName:'51'}],sent=[];
 const getTargets=()=>pendingAccountOfflineNotifications(state,devices);const options={receiptsDir:dir,webhookUrl:'https://open.feishu.cn/open-apis/bot/v2/hook/test-fixture',getTargets,fetchImpl:async(url,opts)=>{sent.push(JSON.parse(opts.body).content.text);return {ok:true,status:200,json:async()=>({code:0})};}};
 try{const n=createLookupHumanNotifier(options);await Promise.all([n.poll(),n.poll()]);await createLookupHumanNotifier(options).poll();assert.equal(sent.length,1);assert.match(sent[0],/51号手机.*138\*{6}01.*重新授权登录/);assert.doesNotMatch(sent[0],/出现拼图/);
 state.preparations[0].loginEpoch='new-round';recordAccountOffline(state,c,offline('new-job-same-account'),Date.now());await n.poll();assert.equal(sent.length,1);
 delete state.devices[0].accountOffline;recordAccountOffline(state,c,offline('later-after-recovery'),Date.now());await n.poll();assert.equal(sent.length,2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
