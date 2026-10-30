import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {lookupReaderCleanupFailure,requireConfirmedLookupCleanup} from './lookup-cleanup-policy.mjs';
import {restartLookupQueryOnce} from './lookup-page-recovery.mjs';
import {shouldFallbackAlipayPocoFailure} from './alipay-poco-fallback-policy.mjs';
import {measureLookupExecution} from './lookup-execution-metrics.mjs';
import {runLookupWithAccountPolicy} from './lookup-account-policy.mjs';
import {collectLookupTrace,isAutomaticLookupResume} from './lookup-recovery-trace.mjs';
import {readerExitDiagnostic} from './lookup-reader-lifecycle.mjs';
import {lookupFailureDomain} from '../../server/lookup-failure-domain.mjs';
import {jobDetail} from '../../server/lookup-admin-console.mjs';

const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
const cloud=fs.readFileSync(new URL('../../server/index.mjs',import.meta.url),'utf8');
const body=(src,name)=>{
 const match=src.match(new RegExp('^(?:async )?function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?^\\}','m'));
 assert.ok(match,name);
 return match[0];
};
const sanitize=new Function('cloneJson',body(cloud,'sanitizeTaskResult')+';return sanitizeTaskResult;')(structuredClone);
const classifiers=source.slice(source.indexOf('function alipayAccountSwitchReasonFromError('),
 source.indexOf('async function observeLookupHumanVerification('));
for(const code of ['lookup_reader_cleanup_unconfirmed','lookup_reader_forward_cleanup_unconfirmed',
 'lookup_old_worker_exit_unconfirmed'])for(const recovery of [false,true])test('real failure transport retains cleanup fence '+code+' recovery='+recovery,async()=>{
 const calls=[],stored=[];
 const error=Object.assign(Error('暂停'),{code});
 const deps={lookupReaderCleanupFailure,requireConfirmedLookupCleanup,restartLookupQueryOnce,shouldFallbackAlipayPocoFailure,
  measureLookupExecution,runLookupWithAccountPolicy,collectLookupTrace,isAutomaticLookupResume,readerExitDiagnostic,
  Buffer,config:{alipayNameLookupRunnerPath:'synthetic',adbPath:'unused'},screenControlledSerials:new Set(),
  fileExists:async()=>true,assertAdbDeviceOnlineFast:async()=>{},isPackageInstalled:async()=>true,
  taskEvent:async()=>{},log:()=>{},touchAirtestLookupWarmLease:()=>{},
  lookupStatusOutbox:{isAvailable:()=>true},isAutomationTaskCancellation:()=>false,isScreenPriorityCancellation:()=>false,
  captureFailureEvidence:async()=>({}),shouldRunPostTaskDeviceScan:()=>false,
  runXhsAirtestPocoWorker:async payload=>{calls.push(payload);throw recovery?Error('unexpected_popup'):error;},
  stopAirtestWorker:async()=>{if(!recovery)assert.fail();throw error;},ensureXmlUiAutomatorReady:assert.fail,
  replayAirtestEvents:async()=>{},stored,sanitize};
 const functions=['taskAlipayNameLookup','taskAlipayNameLookupWithAccounts','taskFailureResult',
  'compactScreenshotForTransport','compactEventDetail','normalizeEvidenceForTransport','compactTaskResultForStatus','compactTaskResultForEvent','runTask']
  .map(name=>body(source,name)).join('\n');
 const transport="async function taskStatus(task,status,result){stored.push({taskId:task.taskId,status,result:sanitize(JSON.parse(JSON.stringify(compactTaskResultForStatus(result))))});}";
 const run=new Function(...Object.keys(deps),classifiers+'\n'+functions+'\n'+transport+';return runTask;')(...Object.values(deps));
 await run({taskId:'original-cleanup',type:'alipay_name_query',adbSerial:'SYNTHETIC',payload:{}});
 assert.equal(calls.length,1);
 assert.equal(stored.length,1);
 const row=stored[0],result=row.result;
 assert.equal(row.taskId,'original-cleanup');
 assert.equal(row.status,'failed');
 assert.equal(result.errorCode,'alipay_lookup_failed');
 assert.equal(result.diagnostic.runnerReason,code);
 assert.equal(result.diagnostic.retryable,false);
 assert.equal(result.diagnostic.lookupExecution.readerRebuildAttempts,recovery?1:0);
 assert.equal(result.diagnostic.lookupExecution.appRestartAttempts,0);
 assert.equal(result.diagnostic.lookupExecution.resultResumeAttempts,0);
 assert.equal(lookupFailureDomain({kind:'alipay_name_query',result}),'device');
 assert.equal(jobDetail({devices:[],windowsTasks:[]},{kind:'alipay_name_query',result}).reason,code);
});
