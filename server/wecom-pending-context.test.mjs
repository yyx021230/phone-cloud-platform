import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {pendingWecomContext} from './wecom-pending-context.mjs';
import {isWecomCleanupPending} from './wecom-physical-cleanup.mjs';
import {maintainTaskHistory} from './task-history-maintenance.mjs';

const duty = () => ({lockId:'duty',lockType:'wecom_physical_cleanup',status:'cleanup_pending',physicalCleanup:{
  binding:{originalTaskId:'old-task'},originalJobId:'old-job',originalLockId:'old-lock',
  verification:{verificationTaskId:'verify-task'},recovery:{verificationTaskId:'recovery-task'}
}});
test('only unresolved WeCom references survive; released/unrelated/malformed references do not pin history', () => {
  const lock=duty(),before=structuredClone(lock);
  const ids=pendingWecomContext([lock,{...duty(),status:'released',physicalCleanup:{originalJobId:'released-job'}},
    {lockType:'lookup',status:'active',physicalCleanup:{originalJobId:'lookup-job'}},
    {lockType:'wecom_physical_cleanup',physicalCleanup:{binding:{originalTaskId:'x'.repeat(161)},originalLockId:42}}]);
  assert.deepEqual([...ids.tasks],['old-task','verify-task','recovery-task']);
  assert.deepEqual([...ids.jobs],['old-job']);assert.deepEqual([...ids.locks],['old-lock']);assert.deepEqual(lock,before);
});

test('actual pruneState keeps pending context beyond both history count and age, then resumes normal retention after release',async()=>{
  const source=await readFile(new URL('./index.mjs',import.meta.url),'utf8');
  const prune=source.slice(source.indexOf('function pruneState(options = {})'),source.indexOf('\nfunction pruneArray('));
  const array=source.slice(source.indexOf('function pruneArray('),source.indexOf('\nfunction stateCounts()'));
  const lock=duty(),old='2001-01-01T00:00:00.000Z',recent=new Date().toISOString();
  const state={smsOrders:[],smsEvents:[],smsMessages:[],xhsQrTasks:[],automationSessions:[],sessions:[],audit:[],evidenceAssets:[],
    windowsTasks:[...['old-task','verify-task','recovery-task'].map(taskId=>({taskId,status:'failed',createdAt:old})),
      {taskId:'unrelated-old-lookup',status:'succeeded',createdAt:old},
      ...Array.from({length:5005},(_,i)=>({taskId:'lookup-'+i,status:'succeeded',createdAt:recent}))],
    automationJobs:[{jobId:'old-job',status:'failed',createdAt:old},{jobId:'unrelated-job',status:'failed',createdAt:old}],
    deviceLocks:[lock,{lockId:'old-lock',status:'released',createdAt:old},{lockId:'unrelated-lock',status:'released',createdAt:old}]};
  const ctx={state,pendingWecomContext,isWecomCleanupPending,maintainTaskHistory,Date,Set,RETENTION_DAYS:30,
    expireDeviceLocks(){},stateCounts(){return{};},trimTaskEvents(){},queueEvidenceCleanup(){},smsMessageIndex:{replace(){}},
    isActiveAutomationStatus:s=>['queued','running'].includes(s),toTime:v=>Date.parse(v)||0};
  for(const key of ['SMS_ORDERS','SMS_EVENTS','SMS_MESSAGES','WINDOWS_TASKS','XHS_TASKS','AUTOMATION_JOBS','AUTOMATION_SESSIONS','SESSIONS','AUDIT_EVENTS','EVIDENCE_ASSETS'])ctx['MAX_'+key]=5000;
  vm.createContext(ctx);vm.runInContext(prune+'\n'+array+'\npruneState();',ctx);
  assert.equal(state.windowsTasks.length,5000);
  assert.deepEqual(state.windowsTasks.slice(0,3).map(t=>t.taskId),['old-task','verify-task','recovery-task']);
  assert.equal(state.windowsTasks.some(t=>t.taskId==='unrelated-old-lookup'),false);
  assert.deepEqual(state.automationJobs.map(j=>j.jobId),['old-job']);
  assert.deepEqual(state.deviceLocks.map(l=>l.lockId),['duty','old-lock']);
  lock.status='released';vm.runInContext('pruneState();',ctx);
  assert.equal(state.windowsTasks.some(t=>t.taskId==='old-task'),false);
  assert.equal(state.automationJobs.length,0);assert.equal(state.deviceLocks.some(l=>l.lockId==='old-lock'),false);
});
