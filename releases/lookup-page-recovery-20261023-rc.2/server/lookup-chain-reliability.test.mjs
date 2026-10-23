import {isHumanLookupResume} from "./device-occupancy.mjs";
import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersistencePolicy } from './persistence-policy.mjs';
import { createPostgresRepositories } from './postgres-repositories.mjs';
import * as automation from './automation-center.mjs';
import { verifiedSavedAccounts, isPreparedLookupLimitConfirmed } from './lookup-account-cooldown.mjs';
import { pendingLookupHumanNotifications } from './lookup-human-notifications.mjs';
const server = await fs.readFile(new URL('./index.mjs', import.meta.url), 'utf8');
const agent = await fs.readFile(new URL('../windows-agent/src/index.mjs', import.meta.url), 'utf8');
import { createTaskStatusPersistence } from './task-status-persistence.mjs';
function fn(source,name) {
 const start=source.search(new RegExp('(?:async )?function '+name+'\\('));
 assert.ok(start>=0,name);
 const tail=source.slice(start);
 const next=tail.slice(1).search(/\n(?:async )?function /);
 return next<0?tail:tail.slice(0,next+1);
}
const canDeliverManagedLookupTask=()=>true;
const isManagedLookupTask=t=>t?.payload?.managedLookup?.protocol==='managed_lookup_v1';
const terminal=s=>['succeeded','failed','cancelled','expired'].includes(s);
const nowIso=()=>new Date().toISOString();
function syncHarness(kind='alipay_name_query') {
 const job={jobId:'original-job',resultId:'original-result',kind,status:'running',sessionId:'session',resumeAfterHumanVerification:true,phoneNumber:'13800000000',events:[]};
 const session={sessionId:'session',deviceId:'device',userId:'owner',source:'open-api',clientId:'client',status:'querying',pendingJobId:job.jobId,successfulCount:0,results:[{resultId:'original-result',status:'running'}]};
 const state={automationJobs:[job],automationSessions:[session],windowsTasks:[],deviceLocks:[]};
 const context=vm.createContext({isHumanLookupResume,...automation,verifiedSavedAccounts,isPreparedLookupLimitConfirmed,state,nowIso,isTerminalStatus:terminal,sanitizeTaskResult:x=>x,
 repos:{devices:{findById:()=>({deviceId:'device'})}},allSavedAccountsCooling:()=>false,
 screenSessions:{activeForDevice:()=>null},isAdbOnline:()=>true,
 releaseAutomationLock:()=>null,
 queueAutomationWindowsTask:(_device,j)=>{ const t={taskId:'next-task',status:'queued'}; j.windowsTaskId=t.taskId;state.windowsTasks.push(t);return t; }
 });
 for(const name of ['finishLookupSession','upsertLookupResult','syncAutomationJobFromWindowsTask','queuedOpenLookupJobs','refreshOpenLookupQueuePositions','dispatchNextOpenLookupQuery']) vm.runInContext(fn(server,name),context);
 return {context,state,session,job};
}
test('successful lookup is never downgraded by a reporting transport error',async()=>{
 const statuses=[];
 const context=vm.createContext({log:()=>{},taskEvent:async()=>{},lookupStatusOutbox:{isAvailable:()=>true},
 taskAlipayNameLookupWithAccounts:async()=>({realNameTailCharacter:'甲',currentAccount:'account-a'}),
 compactTaskResultForEvent:x=>x,
 taskStatus:async(_t,status,result)=>{statuses.push({status,hasName:!!result.realNameTailCharacter});if(status==='succeeded')throw new Error('synthetic transport timeout');},
 isAutomationTaskCancellation:()=>false,isScreenPriorityCancellation:()=>false,
 captureFailureEvidence:async()=>({}),taskFailureResult:e=>({error:e.message}),shouldRunPostTaskDeviceScan:()=>false});
 vm.runInContext(fn(agent,'runTask'),context);
 await assert.rejects(context.runTask({taskId:'synthetic',type:'alipay_name_query',adbSerial:'SYNTHETIC'}),/synthetic transport timeout/);
 assert.deepEqual(statuses,[{status:'succeeded',hasName:true}]);
});
test('terminal retry ACK follows persistence after failed first write',async()=>{
 const task={taskId:'synthetic',status:'running',events:[]};let writes=0;
 const persistencePolicy=createPersistencePolicy({structuredWritesEnabled:false,saveSnapshot:async()=>{writes++;if(writes===1)throw new Error('synthetic disk failure');},scheduleCheckpoint:()=>{}});
 const context=vm.createContext({isManagedLookupTask,req:{method:'POST'},res:{},url:{pathname:'/api/v1/windows-agent-tasks/synthetic/status'},
 requireWindowsAgent:()=>({}),requireWindowsScope:()=>{},readJson:async()=>({status:'succeeded',result:{realNameTailCharacter:'甲'}}),
 repos:{windowsTasks:{findById:()=>task}},windowsCtxCanAccessTask:()=>true,isTerminalStatus:terminal,
 publicWindowsTask:t=>({status:t.status}),json:(_r,status,body)=>({status,body}),
 materializeTaskResultEvidence:async x=>x,sanitizeTaskResult:x=>x,nowIso,compactCompletedTask:()=>{},
 syncXhsTaskFromWindowsTask:()=>null,syncAutomationJobFromWindowsTask:()=>null,state:{deviceLocks:[]},persistencePolicy,structuredRepos:null,taskStatusPersistence:createTaskStatusPersistence()});
 const start=server.indexOf('  const taskStatusMatch =');const end=server.indexOf('  const taskEventsMatch =',start);
 vm.runInContext('async function route(){'+server.slice(start,end)+'}',context);
 await assert.rejects(context.route(),/synthetic disk failure/);
 const retry=await context.route();
 assert.equal(retry.status,200);assert.equal(retry.body.ignored,true);assert.equal(writes,2);
});
for(const mode of ['web','open-api'])test('C '+mode+': end route persists cancelled running job and task in PostgreSQL transaction',async()=>{
 const h=syncHarness();h.job.resumeAfterHumanVerification=false;
 const oldTask={taskId:'old-task',status:'running'};h.job.windowsTaskId=oldTask.taskId;h.state.windowsTasks.push(oldTask);
 const writes=[];
 const pool={connect:async()=>({query:async(sql,args)=>{if(sql.startsWith('insert into'))writes.push({table:sql.match(/insert into (\w+)/)[1],id:args[0]});return {rows:[]};},release:()=>{}})};
 const structuredRepos=createPostgresRepositories({getPool:async()=>pool});
 Object.assign(h.context,{req:{method:'POST'},res:{},lookupEndMatch:['','session'],openLookupEndMatch:['','session'],
 requireAuth:()=>({userId:'owner'}),readSignedOpenJson:async()=>({ctx:{clientId:'client'}}),url:{},openNameLookupSession:()=>h.session,publicOpenLookupSession:s=>s,OPEN_NAME_LOOKUP_CLIENTS:new Map(),
 json:(_r,status,body)=>({status,body}),addAudit:()=>null,
 createAutomationJob:input=>{const j={jobId:'stop-job',...input};h.state.automationJobs.push(j);return j;},
 persistencePolicy:createPersistencePolicy({structuredWritesEnabled:true,saveSnapshot:async()=>{},scheduleCheckpoint:()=>{}}),structuredRepos});
 h.context.setTimeout = setTimeout;
 vm.runInContext(fn(server,'drainPendingLookupQueryBeforeStop'),h.context);
 vm.runInContext(fn(server,'cancelAutomationJob'),h.context);
 vm.runInContext(fn(server,'cancelQueuedOpenLookupQueries'),h.context);
 let start,end;
 if(mode==='web'){start=server.indexOf('  if (req.method === "POST" && lookupEndMatch)');end=server.indexOf('\n  if (req.method === "GET" && url.pathname === "/api/v1/app-release/latest")',start);}
 else{start=server.indexOf('    if (req.method === "POST" && openLookupEndMatch)');end=server.indexOf('\n  }\n\n  if (req.method === "GET" && url.pathname === "/api/v1/overview")',start);}
 vm.runInContext('async function route(){'+server.slice(start,end)+'}',h.context);
 assert.equal((await h.context.route()).status,202);
 assert.equal(h.job.status,'cancelled');assert.equal(oldTask.status,'cancelled');
 assert.ok(writes.some(w=>w.id==='stop-job'));assert.ok(writes.some(w=>w.id==='original-job'));assert.ok(writes.some(w=>w.id==='old-task'));
});
test('ordinary human resume failure pauses original query without puzzle notification',()=>{
 const h=syncHarness();
 h.state.automationJobs.push({jobId:'next-job',resultId:'next-result',kind:'alipay_name_query',status:'queued',sessionId:'session',source:'open-api',clientId:'client',queueSequence:2});
 const task={taskId:'original-task',payload:{automationJobId:h.job.jobId}};
 h.context.syncAutomationJobFromWindowsTask(task,'failed',{errorCode:'alipay_page_element_changed',error:'synthetic Poco transport error'});
 assert.equal(h.session.results.find(r=>r.resultId==='original-result').status,'needs_recovery');
 assert.equal(h.context.dispatchNextOpenLookupQuery(h.session),null);assert.equal(h.session.pendingJobId,'');
 assert.deepEqual(pendingLookupHumanNotifications([h.session],[{deviceId:'device',deviceName:'118'}]),[]);
});
test('startup jigsaw preserves session and produces one notification target',()=>{
 const h=syncHarness('alipay_name_start');h.session.results=[];
 h.context.syncAutomationJobFromWindowsTask({taskId:'start-task',payload:{automationJobId:h.job.jobId}},'failed',{
 errorCode:'alipay_human_verification_required',error:'alipay_human_verification_required:jigsaw_verification',diagnostic:{limitReason:'jigsaw_verification'}});
 assert.equal(h.session.status,'needs_human_verification');
 assert.equal(pendingLookupHumanNotifications([h.session],[{deviceId:'device',deviceName:'118'}]).length,1);
});


test("concurrent duplicate status reports join the failed mutation and retry it exactly", async () => {
  const pending = createTaskStatusPersistence();
  let fail, writes = 0, fallback = 0;
  const firstWrite = () => { writes++; return writes === 1 ? new Promise((_r, reject) => { fail = reject; }) : Promise.resolve(); };
  const first = pending.persist("terminal", firstWrite);
  await Promise.resolve();
  const duplicate = pending.persist("terminal", () => { fallback++; });
  assert.equal(writes, 1);
  fail(Error("database unavailable"));
  assert.equal((await Promise.allSettled([first, duplicate])).every((x) => x.status === "rejected"), true);
  await pending.persist("terminal", () => { fallback++; });
  assert.equal(writes, 2); assert.equal(fallback, 0);
});

test("late evidence materialization cannot overwrite a winning terminal result", async () => {
  const task = { taskId: "race", status: "running" };
  let releaseFirst, materializations = 0, syncs = 0;
  const inputs = [ { status: "succeeded", result: { marker: "late" } }, { status: "succeeded", result: { marker: "winner" } } ];
  const context = vm.createContext({ isManagedLookupTask,req: { method: "POST" }, res: {}, url: { pathname: "/api/v1/windows-agent-tasks/race/status" },
    requireWindowsAgent: () => ({}), requireWindowsScope: () => {}, readJson: async () => inputs.shift(),
    repos: { windowsTasks: { findById: () => task } }, windowsCtxCanAccessTask: () => true, isTerminalStatus: terminal,
    publicWindowsTask: (t) => ({ status: t.status }), json: (_r, status, body) => ({ status, body }),
    materializeTaskResultEvidence: async (result) => { materializations++; if (materializations === 1) await new Promise((r) => { releaseFirst = r; }); return result; },
    sanitizeTaskResult: (x) => x, nowIso, compactCompletedTask: () => {}, syncXhsTaskFromWindowsTask: () => null,
    syncAutomationJobFromWindowsTask: () => { syncs++; return null; }, state: { deviceLocks: [] },
    persistencePolicy: { persist: async () => {} }, structuredRepos: null, taskStatusPersistence: createTaskStatusPersistence() });
  const start = server.indexOf("  const taskStatusMatch ="), end = server.indexOf("  const taskEventsMatch =", start);
  vm.runInContext("async function route(){" + server.slice(start, end) + "}", context);
  const late = context.route(); await Promise.resolve(); await Promise.resolve();
  const winner = await context.route(); assert.equal(winner.status, 200);
  releaseFirst(); assert.equal((await late).body.ignored, true);
  assert.equal(task.result.marker, "winner"); assert.equal(syncs, 1);
});

test("pending lookup reports reserve only their serial while retaining screen polling parameters", async () => {
  let params;
  const context = vm.createContext({ URLSearchParams, encodeURIComponent, config: { maxConcurrentAdbTasks: 1, agentId: "a" },
    activeTasksById: new Map([["active", {}]]), activeTaskSerials: new Set(["ACTIVE"]), screenControlledSerials: new Set(["SCREEN"]),
    lookupStatusOutbox: { pendingTasks: () => [{ taskId: "pending", adbSerial: "LOOKUP" }] },
    canDeliverManagedLookupTask,MANAGED_LOOKUP_PROTOCOL:"managed_lookup_v1",SCREEN_GALLERY_DELIVERY_PROTOCOL: "gallery", XHS_PUBLISH_DELIVERY_PROTOCOL: "publish",
    api: async (url) => { params = new URL("http://local" + url).searchParams; return { task: null, cancelledTaskIds: [] }; },
    abortCancelledAutomationTasks: () => {}, log: () => {} });
  vm.runInContext(fn(agent, "pollTask"), context); await context.pollTask();
  assert.deepEqual(new Set(params.get("excludeSerials").split(",")), new Set(["ACTIVE", "SCREEN", "LOOKUP"]));
  assert.equal(params.get("screenGallerySerials"), "SCREEN");
  assert.deepEqual(new Set(params.get("activeTaskIds").split(",")), new Set(["active", "pending"]));
});


test("unavailable lookup storage stops only lookup execution and preserves unrelated task behavior", async () => {
  let lookups = 0, gallery = 0, evidence = 0;
  const reports = [];
  const context = vm.createContext({ log: () => {}, taskEvent: async () => {},
    lookupStatusOutbox: { isAvailable: () => false },
    taskAlipayNameLookupWithAccounts: async () => { lookups++; },
    taskScreenGalleryImport: async () => { gallery++; return {}; },
    compactTaskResultForEvent: (x) => x, taskStatus: async (_task, status, result) => reports.push({ status, code: result.errorCode }),
    isAutomationTaskCancellation: () => false, isScreenPriorityCancellation: () => false,
    captureFailureEvidence: async () => { evidence++; return {}; }, taskFailureResult: (error) => ({ errorCode: error.code }),
    shouldRunPostTaskDeviceScan: () => false });
  vm.runInContext(fn(agent, "runTask"), context);
  await context.runTask({ taskId: "lookup", type: "alipay_name_query" });
  await context.runTask({ taskId: "gallery", type: "screen_gallery_import" });
  assert.equal(lookups, 0); assert.equal(evidence, 0); assert.equal(gallery, 1);
  assert.deepEqual(reports, [{ status: "failed", code: "lookup_status_storage_unavailable" }, { status: "succeeded", code: undefined }]);
});

const picker = current => ["A", "B", "C"].map(account => ({ account, current: account === current }));
const verifiedResult = (currentAccount, extra = {}) => ({ currentAccount, accountIdentityVerified: true, savedAccounts: picker(currentAccount), ...extra });
const protocolTask = job => ({ taskId: "task-" + job.jobId, payload: { automationJobId: job.jobId, accountCooldownProtocol: 1 } });
function identityHarness() {
  const h = syncHarness(); Object.assign(h.session, { currentAccount: "A", accountIdentityVerified: true, savedAccounts: picker("A") });
  h.job.resumeAfterHumanVerification = false;
  return h;
}
test("a verified account switch followed by puzzle updates identity while retaining the original failed result", () => {
  const h = identityHarness();
  h.context.syncAutomationJobFromWindowsTask(protocolTask(h.job), "failed", verifiedResult("B", {
    errorCode: "alipay_human_verification_required", accountSwitched: true, accountSwitchCount: 1, diagnostic: { limitReason: "jigsaw_verification" } }));
  assert.equal(h.session.currentAccount, "B"); assert.equal(h.session.accountIdentityVerified, true);
  assert.equal(h.session.savedAccounts.find(r => r.current).account, "B");
  assert.equal(h.session.results.length, 1); assert.equal(h.session.results[0].resultId, "original-result");
  assert.equal(h.session.results[0].status, "needs_human_verification"); assert.equal(h.session.results[0].accountSwitchCount, 1);
  assert.equal(pendingLookupHumanNotifications([h.session], [{deviceId:"device",deviceName:"118"}]).length, 1);
});
test("a failed report with incomplete account proof cannot overwrite the verified session", () => {
  for (const result of [{ currentAccount: "B", savedAccounts: picker("B") },
    verifiedResult("B", { savedAccounts: picker("C") }), verifiedResult("B", { accountIdentityVerified: false })]) {
    const h = identityHarness();
    h.context.syncAutomationJobFromWindowsTask(protocolTask(h.job), "failed", { ...result, accountSwitched: true, errorCode: "network_error" });
    assert.equal(h.session.currentAccount, "A"); assert.equal(h.session.savedAccounts.find(r => r.current).account, "A");
  }
});
test("original-result rotation totals survive two resumptions, duplicate reports and pruned old jobs", () => {
  const h = identityHarness();
  const report = (job, status, result) => h.context.syncAutomationJobFromWindowsTask(protocolTask(job), status, result);
  report(h.job, "failed", verifiedResult("B", { errorCode: "alipay_human_verification_required", accountSwitched: true, accountSwitchCount: 1 }));
  const resume = { ...h.job, jobId: "resume-1", status: "running", resumeAfterHumanVerification: true, result: null };
  delete resume.lookupResultAccountSwitchBaseCount; h.state.automationJobs = [resume];
  report(resume, "failed", verifiedResult("C", { errorCode: "alipay_human_verification_required", accountSwitched: true, accountSwitchCount: 1 }));
  assert.equal(h.session.results[0].accountSwitchCount, 2);
  report(resume, "failed", verifiedResult("C", { accountSwitchCount: 1 })); assert.equal(h.session.results[0].accountSwitchCount, 2);
  // A fresh process sees persisted JSON fields, without depending on retained job history.
  const restarted = identityHarness(); restarted.session.results = JSON.parse(JSON.stringify(h.session.results));
  const final = { ...resume, jobId: "resume-2", status: "running", result: null }; delete final.lookupResultAccountSwitchBaseCount;
  restarted.state.automationJobs = [final];
  restarted.context.syncAutomationJobFromWindowsTask(protocolTask(final), "succeeded", verifiedResult("C", { realNameTailCharacter: "甲", accountSwitchCount: 0 }));
  assert.equal(restarted.session.results.length, 1); assert.equal(restarted.session.results[0].status, "succeeded");
  assert.equal(restarted.session.results[0].accountSwitchCount, 2); assert.equal(restarted.session.results[0].accountSwitched, true);
  restarted.context.upsertLookupResult(restarted.session, final, { accountSwitchCount: 0, accountSwitched: false });
  assert.equal(restarted.session.results[0].accountSwitchCount, 2);
});
