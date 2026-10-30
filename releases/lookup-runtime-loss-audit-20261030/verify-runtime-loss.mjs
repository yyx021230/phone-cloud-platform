// Local diagnostic only. Evaluates existing production-matched functions with
// synthetic state and clock; does not start the server or access the network.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {canAdmitLookupReader} from '../../server/lookup-reader-admission.mjs';
import {isManagedLookupTask, hasActiveScreenGalleryDelivery,
  issueScreenGalleryDelivery, acknowledgeScreenGalleryDelivery} from '../../server/managed-lookup-delivery.mjs';

const source=fs.readFileSync(fileURLToPath(new URL('../../server/index.mjs',import.meta.url)),'utf8');
function between(name,next) {
  const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction '+next+'(',start);
  assert(start>=0&&end>start,'source boundaries changed; inspect before updating diagnostic');
  return source.slice(start,end);
}
const start=Date.parse('2026-10-30T01:21:10Z');
let clock=start+60_001;
const task={taskId:'synthetic-query',agentId:'synthetic-agent',deviceId:'synthetic-device',
  adbSerial:'SYNTHETIC',type:'alipay_name_query',status:'running',
  createdAt:new Date(start).toISOString(),updatedAt:new Date(start).toISOString(),
  events:[{stepId:'submit_search',createdAt:new Date(start).toISOString()}],
  payload:{managedLookup:{protocol:'managed_lookup_v1',generation:'synthetic-generation'}},
  delivery:{token:'synthetic-old',leasedAt:new Date(start).toISOString(),
    expiresAt:new Date(start+60_000).toISOString(),ackedAt:new Date(start).toISOString()}};
const state={windowsTasks:[task],windowsAgents:[{agentId:'synthetic-agent',lookupRuntimeId:'synthetic-new-runtime'}]};
const context=vm.createContext({state,Date:class extends Date{static now(){return clock;}},
  WINDOWS_TASK_TTL_MS:300_000,ALIPAY_NAME_QUERY_WINDOWS_TASK_TTL_MS:2_100_000,
  WINDOWS_TASK_QUEUE_TTL_MS:1_800_000,isWindowsAgentOnline:()=>true,
  toTime:value=>Date.parse(value)||0,nowIso:()=>new Date(clock).toISOString(),
  newId:()=> 'synthetic-event',isManagedLookupTask,
  syncXhsTaskFromWindowsTask:()=>{},syncAutomationJobFromWindowsTask:()=>{}});
vm.runInContext([
  between('recoverStalledTasks','expireWindowsTasks'),
  between('expireWindowsTasks','expireXhsTasks'),
  between('latestTaskActivityAt','pruneState')
].join('\n'),context);
const call=name=>vm.runInContext(name+'()',context);
assert.equal(call('recoverStalledTasks'),false);
assert.equal(task.status,'running');
assert.equal(call('expireWindowsTasks'),false);
const afterRuntimeChange=task.status;
clock=start+2_100_001;
assert.equal(call('expireWindowsTasks'),true);
assert.equal(task.status,'stalled');
const afterTtl=task.status;
assert.equal(call('recoverStalledTasks'),true);
assert.equal(task.status,'queued');
const afterRecovery=task.status;
assert.equal(hasActiveScreenGalleryDelivery(task,clock),false);
const delivered=issueScreenGalleryDelivery(task,{token:'synthetic-new',nowMs:clock,leaseMs:60_000});
assert.equal(delivered.taskId,task.taskId);
assert.equal(task.delivery.ackedAt,'');
assert.equal(acknowledgeScreenGalleryDelivery(task,'synthetic-new',clock).ok,true);
assert.equal(task.status,'running');
const oldClaims=Array.from({length:6},(_,i)=>({...task,taskId:'synthetic-old-'+i,
  adbSerial:'SYNTHETIC-OLD-'+i,status:'running'}));
const capacityInput={task:{...task,status:'queued',adbSerial:'SYNTHETIC-NEXT'},
  agentId:'synthetic-agent',now:clock,activeTaskIds:[],
  report:{version:1,runtimeId:'11111111-1111-4111-8111-111111111111',
    limit:12,pinnedSerials:[],receivedAt:clock},tasks:oldClaims};
const claimDecision=canAdmitLookupReader(capacityInput);
assert.equal(claimDecision.used,6);
assert.equal(claimDecision.limit,12);
const sixNewReaders=Array.from({length:6},(_,i)=>'SYNTHETIC-NEW-'+i);
const fullDecision=canAdmitLookupReader({...capacityInput,
  report:{...capacityInput.report,pinnedSerials:sixNewReaders}});
assert.equal(fullDecision.used,12);
assert.equal(fullDecision.allowed,false);
console.log(JSON.stringify({
  kind:'diagnostic_reproduction_not_fix',
  scope:'existing functions, synthetic state and clock; no HTTP, Agent, ADB, database, model or phone actions',
  observations:{runtimeChangedWhileAgentOnline:afterRuntimeChange,
    afterQueryInactivityTtl:afterTtl,afterNextOnlineRecovery:afterRecovery,
    originalTaskCanReceiveNewLease:true,
    oldUnexecutedRunningTasksStillClaimReaderBudget:claimDecision.used,
    sixOldClaimsPlusSixPinnedReadersDenyAnother:!fullDecision.allowed,afterSyntheticNewAck:task.status,
    originalOperationStillQuery:task.type==='alipay_name_query',
    queryResumeFlagsPresent:Boolean(task.payload.resumeAfterHumanVerification||task.payload.preparedLookup?.observationOnlyResume)},
  limitations:['Does not execute the complete tasks/next filter, coordinator or Agent runner',
    'Proves metadata requeue and lease path, not that production duplicate input has occurred',
    'Other timing, cancellation, capacity and generation gates may affect actual delivery'],
  productionFixed:false
},null,2));
