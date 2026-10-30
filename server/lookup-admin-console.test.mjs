import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildLookupAdminOverview,jobEvidence,jobDetail,requestDetail,lookupRequestPage,parseLookupCursor} from './lookup-admin-console.mjs';
import {createManagedLookupStore} from './managed-lookup-store.mjs';
const now=Date.now(),at=new Date(now).toISOString();
function fixture(){return {pool:{revision:1,config:{enabled:true,concurrency:5},devices:[{deviceId:'d',deviceNumber:118,enabled:true,health:{ready:true},channel:{sessionId:'s',phase:'idle',deviceId:'d'}}],requests:[],preparations:[]},state:{devices:[{deviceId:'d',deviceName:'118'}],automationSessions:[{sessionId:'s',deviceId:'d',status:'ready',accountIdentityVerified:true,currentAccount:'A',savedAccounts:[{account:'A',current:true},{account:'B',current:false}],updatedAt:at}],automationJobs:[],windowsTasks:[],evidenceAssets:[]},isReady:()=>true,now};}
test('overview distinguishes device conditions from actual readiness and preserves every bound phone',()=>{const f=fixture();f.isReady=()=>false;for(let i=0;i<47;i++)f.pool.devices.push({deviceId:'x'+i,deviceNumber:i,enabled:true,health:{ready:true}});const x=buildLookupAdminOverview(f);assert.equal(x.devices.length,48);assert.equal(x.counts.ready,0);assert.equal(x.devices.find(d=>d.deviceId==='x0').accountsKnown,false);assert.equal(x.devices.find(d=>d.deviceId==='d').accounts[1].status,'unprobed');});
test('active verified account only can be ready; no channel means historical identity',()=>{const f=fixture();assert.equal(buildLookupAdminOverview(f).devices[0].accounts[0].status,'ready');delete f.pool.devices[0].channel;const d=buildLookupAdminOverview(f).devices[0];assert.equal(d.ready,false);assert.equal(d.accounts[0].status,'unprobed');assert.equal(d.accounts[0].identity,'last_confirmed');});
test('cooldown remains per device and per account; expiry is not readiness',()=>{const f=fixture();f.state.devices[0].lookupAccountCooldowns=[{account:'B',cooldownUntil:new Date(now+10000).toISOString(),limitedAt:at,reason:'access_denied'}];let x=buildLookupAdminOverview(f).devices[0];assert.equal(x.accounts[0].status,'ready');assert.equal(x.accounts[1].status,'cooling');f.now+=20000;x=buildLookupAdminOverview(f).devices[0];assert.equal(x.accounts[1].status,'unprobed');assert.equal(x.accounts[1].cooldown.remainingMs,0);});
test('login isolation has its own status and unknown identity is never guessed',()=>{const f=fixture();f.pool.devices[0].accountOffline={account:'B'};assert.equal(buildLookupAdminOverview(f).devices[0].accounts[1].status,'login_required');f.pool.devices[0].accountOffline={account:''};assert.notEqual(buildLookupAdminOverview(f).devices[0].accounts[1].status,'login_required');});
test('stale puzzle observations are checking, and confirmed normal observations lose human badge',()=>{const f=fixture(),c=f.pool.devices[0].channel;f.isReady=()=>false;c.phase='human';f.state.automationSessions[0].status='needs_human_verification';c.humanObservation={state:'search_ready',confirmed:true,at:now};assert.equal(buildLookupAdminOverview(f).devices[0].card.state,'verified_waiting');c.humanObservation.at=now-40000;assert.equal(buildLookupAdminOverview(f).devices[0].card.state,'checking');assert.equal(buildLookupAdminOverview(f).counts.human,0);});
test('projection does not mutate, return secret fields, raw snapshots or fake empty outcomes',()=>{const f=fixture();f.pool.secret='secret';f.pool.preparations=[{preparationId:'p',clientId:'c',probePhone:'secret',key:'secret'}];f.state.automationSessions[0].token='secret';const before=JSON.stringify(f);const result=buildLookupAdminOverview(f);assert.equal(JSON.stringify(f),before);assert.doesNotMatch(JSON.stringify(result),/secret/);const page=lookupRequestPage([{lookupId:'q',createdAt:at,status:'failed',name:'',fingerprint:'private',idempotencyKey:'private',phoneNumber:'13800000000'}]);assert.equal(page.requests[0].name,null);assert.doesNotMatch(JSON.stringify(page),/private/);});
function evidenceFixture(){const job={jobId:'j',sessionId:'s',deviceId:'d',windowsTaskId:'t',kind:'alipay_name_query',status:'failed',clientReference:'q',result:{errorCode:'unconfirmed',screenshot:{evidenceId:'e',capturedAt:at}}};return {job,state:{devices:[{deviceId:'d',deviceName:'118'}],automationJobs:[job],windowsTasks:[{taskId:'t',deviceId:'d',events:[]}],evidenceAssets:[{evidenceId:'e',taskId:'t',kind:'screenshot',mimeType:'image/png',createdAt:at,filePath:'/private/asset'}]}};}
test('screenshot is exact persisted task evidence, not a supplied external URL',()=>{const {state,job}=evidenceFixture();job.result.screenshot.url='https://attacker/';const e=jobEvidence(state,job);assert.equal(e.length,1);assert.match(e[0].url,/^\/api\/v1\/admin\/lookup-pool\/console\/jobs\/j\/evidence\/e$/);assert.doesNotMatch(JSON.stringify(jobDetail(state,job)),/attacker|private/);});
test('cross task/device/missing asset/non-image evidence is refused',()=>{for(const change of [f=>f.state.evidenceAssets[0].taskId='other',f=>f.state.windowsTasks[0].deviceId='other',f=>f.state.evidenceAssets=[],f=>f.state.evidenceAssets[0].mimeType='text/html',f=>f.job.kind='xhs_publish']){const f=evidenceFixture();change(f);assert.deepEqual(jobEvidence(f.state,f.job),[]);}});
test('request attempt only includes original lookup job not later sibling query',()=>{const {state,job}=evidenceFixture();state.automationJobs.push({...job,jobId:'other',clientReference:'other'});const d=requestDetail(state,{lookupId:'q',createdAt:at,status:'failed',attempts:[{deviceId:'d',sessionId:'s',at}]});assert.deepEqual(d.attempts[0].jobs.map(j=>j.jobId),['j']);assert.equal(d.name,null);});
test('keyset paging handles tied times, probes and duplicates without skipping',()=>{const rows=Array.from({length:65},(_,i)=>({lookupId:String(i).padStart(3,'0'),createdAt:at,status:'succeeded',name:'测'}));rows.push({...rows[0]},{lookupId:'probe',purpose:'readiness_probe',createdAt:at});let c=null,seen=[];do{const page=lookupRequestPage(rows,c);seen.push(...page.requests.map(r=>r.lookupId));c=parseLookupCursor(page.nextCursor);}while(c);assert.equal(seen.length,65);assert.equal(new Set(seen).size,65);assert.deepEqual(seen,[...seen].sort().reverse());});
test('malformed cursor refused, absent cursor starts latest',()=>{assert.equal(parseLookupCursor(''),null);for(const c of ['bad',Buffer.from(JSON.stringify({createdAt:'invalid',lookupId:'q'})).toString('base64url'),Buffer.from(JSON.stringify({createdAt:at,lookupId:'../x'})).toString('base64url')])assert.throws(()=>parseLookupCursor(c),{statusCode:400});});
test('read-only file store queries preserve revision and disk state',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-admin-unit-'));const store=await createManagedLookupStore({file:path.join(dir,'pool.json')});t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});await store.transact(s=>s.requests.push({lookupId:'q',createdAt:at,status:'failed',phoneNumber:'13800000000'}));const before=await fs.readFile(path.join(dir,'pool.json'),'utf8'),revision=store.snapshot().revision;assert.equal((await store.adminRequests(null)).requests.length,1);assert.equal((await store.adminRequest('q')).status,'failed');assert.equal(await store.adminRequest('missing'),null);assert.equal(store.snapshot().revision,revision);assert.equal(await fs.readFile(path.join(dir,'pool.json'),'utf8'),before);});

test('expired idle proof never labels account as ready or idle eligible',()=>{const f=fixture();f.isReady=()=>false;const a=buildLookupAdminOverview(f).devices[0].accounts[0];assert.equal(a.status,'unprobed');assert.match(a.reason,/重新探测/);});

test('blocking failure binds exact trip task instead of newer account CAPTCHA',()=>{
 const f=fixture(),d=f.pool.devices[0];d.health={ready:false,reason:'page_preparation_backoff'};
 d.lastPreparationFailure={jobId:'old',at:now-600000,domain:'page',code:'alipay_lookup_failed'};
 f.state.automationJobs=[{jobId:'old',deviceId:'d',kind:'alipay_name_start',status:'failed',createdAt:new Date(now-600000).toISOString(),result:{diagnostic:{runnerReason:'alipay_known_overlay_close_unverified:fullscreen_ad'}}},{jobId:'new',deviceId:'d',kind:'alipay_name_query',status:'failed',createdAt:at,result:{currentAccount:'A',errorCode:'alipay_human_verification_required'}}];
 const x=buildLookupAdminOverview(f).devices[0];assert.equal(x.blockingFailure.jobId,'old');assert.equal(x.blockingFailure.detailsAvailable,true);assert.match(x.blockingFailure.reason,/fullscreen_ad/);assert.equal(x.accounts[0].lastFailure.jobId,'new');
});
test('expired and cross-device blocking detail never substituted by latest failure',()=>{
 for(const other of [false,true]){const f=fixture(),d=f.pool.devices[0];d.health={ready:false,reason:'lookup_device_unavailable'};d.lastPreparationFailure={jobId:'gone',at:now,domain:'device',code:'alipay_lookup_failed'};if(other)f.state.automationJobs=[{jobId:'gone',deviceId:'other',kind:'alipay_name_query',status:'failed'}];const b=buildLookupAdminOverview(f).devices[0].blockingFailure;assert.equal(b.jobId,'gone');assert.equal(b.detailsAvailable,false);assert.equal(b.hasScreenshot,false);}
});
test('recovered or cooling device does not advertise historical preparation block',()=>{
 for(const health of [{ready:true},{ready:false,reason:'accounts_cooling'}]){const f=fixture();Object.assign(f.pool.devices[0],{health,lastPreparationFailure:{jobId:'old',at:now}});assert.equal(buildLookupAdminOverview(f).devices[0].blockingFailure,null);}
});

test('exact archived failure is readable without rehydrating live state',async()=>{
 const {state,job}=evidenceFixture();const task=state.windowsTasks[0];state.automationJobs=[];state.windowsTasks=[];
 const before=JSON.stringify(state);const {lookupJobContext}=await import('./lookup-admin-console.mjs');let calls=[];
 const ctx=await lookupJobContext(state,'j',async id=>{calls.push(id);return {job,task};});
 assert.equal(jobDetail(ctx.state,ctx.job).evidence.length,1);assert.deepEqual(calls,['j']);assert.equal(JSON.stringify(state),before);
});
test('archive cannot substitute a different job, workflow, task or device',async()=>{
 const {lookupJobContext}=await import('./lookup-admin-console.mjs');
 for(const mutate of [j=>j.jobId='other',j=>j.kind='xhs_publish']){const {state,job}=evidenceFixture();state.automationJobs=[];mutate(job);assert.equal(await lookupJobContext(state,'j',async()=>({job})),null);}
 for(const mutate of [t=>t.taskId='other',t=>t.deviceId='other']){const {state,job}=evidenceFixture();const task=structuredClone(state.windowsTasks[0]);mutate(task);state.automationJobs=[];state.windowsTasks=[];const ctx=await lookupJobContext(state,'j',async()=>({job,task}));assert.deepEqual(jobEvidence(ctx.state,ctx.job),[]);}
});
test('live detail wins, invalid IDs do not hit storage and storage failure is not reported as deletion',async()=>{
 const {lookupJobContext}=await import('./lookup-admin-console.mjs');const {state,job}=evidenceFixture();
 const read=async()=>{throw Error('storage_down');};assert.equal((await lookupJobContext(state,'j',read)).job,job);
 assert.equal(await lookupJobContext(state,'../x',read),null);state.automationJobs=[];state.windowsTasks=[];await assert.rejects(lookupJobContext(state,'j',read),/storage_down/);
});

test('153-shaped archived preflight error exposes a safe cause without raw command data',async()=>{
 const {lookupJobContext}=await import('./lookup-admin-console.mjs');const {state,job}=evidenceFixture();
 job.kind='alipay_name_start';job.result={errorCode:'task_failed',error:'package_manager_unresponsive:private-serial:Command failed: private-path shell cmd package path private-package\n'};
 const task=state.windowsTasks[0];state.automationJobs=[];state.windowsTasks=[];
 const ctx=await lookupJobContext(state,'j',async()=>({job,task}));
 const d=jobDetail(ctx.state,ctx.job);assert.equal(d.reason,'package_manager_unresponsive');assert.equal(d.code,'task_failed');assert.equal(d.evidence.length,0);assert.doesNotMatch(JSON.stringify(d),/private/);
});
test('failure detail uses only the exact matching task diagnostic and never arbitrary raw errors',()=>{
 const {state,job}=evidenceFixture();job.result={};state.windowsTasks[0].result={errorCode:'task_failed',diagnostic:{runnerReason:'poco_query_resume_state_mismatch'}};
 assert.equal(jobDetail(state,job).reason,'poco_query_resume_state_mismatch');assert.equal(jobDetail(state,job).code,'task_failed');
 state.windowsTasks[0].deviceId='other';assert.equal(jobDetail(state,job).reason,'');assert.equal(jobDetail(state,job).code,'');
 job.result={error:'private secret phone command'};assert.equal(jobDetail(state,job).reason,'');
 job.result={error:'notpackage_manager_unresponsive:private'};assert.equal(jobDetail(state,job).reason,'');
});
test('live blocking preflight cause retains exact task and structured diagnostics take priority',()=>{
 const f=fixture(),d=f.pool.devices[0];d.health={ready:false,reason:'preparation_failed_round'};d.lastPreparationFailure={jobId:'old',at:now,code:'task_failed'};
 const j={jobId:'old',deviceId:'d',kind:'alipay_name_start',status:'failed',result:{error:'package_manager_unresponsive:private'}};f.state.automationJobs=[j];
 assert.equal(buildLookupAdminOverview(f).devices[0].blockingFailure.reason,'package_manager_unresponsive');
 j.result.diagnostic={runnerReason:'poco_query_before_input_failed'};assert.equal(buildLookupAdminOverview(f).devices[0].blockingFailure.reason,'poco_query_before_input_failed');
});
