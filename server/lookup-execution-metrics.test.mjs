import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {measureLookupExecution} from '../windows-agent/src/lookup-execution-metrics.mjs';
import {lookupExecutionMetrics,lookupExecutionDuration,lookupRecoverySummary} from './lookup-execution-metrics.mjs';
import {jobDetail,requestDetail} from './lookup-admin-console.mjs';
const agent=fs.readFileSync(new URL('../windows-agent/src/index.mjs',import.meta.url),'utf8');
const cloud=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
const fn=(s,n)=>s.match(new RegExp(`^(?:async )?function ${n}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'))[0];
const compactDetail=new Function('normalizeEvidenceForTransport',fn(agent,'compactEventDetail')+';return compactEventDetail;')(x=>x);
const compact=new Function('compactEventDetail',fn(agent,'compactTaskResultForStatus')+';return compactTaskResultForStatus;')(compactDetail);
const failure=new Function(fn(agent,'taskFailureResult')+';return taskFailureResult;')();
const sanitize=new Function('cloneJson',fn(cloud,'sanitizeTaskResult')+';return sanitizeTaskResult;')(structuredClone);
test('actual cloud sanitizer preserves unknown, accepts numeric zero and rejects invalid duration on repeat transport',()=>{
  for(const value of [null,undefined,'',' ',false,true,-1,Infinity,NaN]) {
    const r=sanitize(compact({durationMs:value}));assert.equal(r.durationMs,null);assert.equal(sanitize(r).durationMs,null);
  }
  assert.equal(sanitize(compact({durationMs:0})).durationMs,0);
});
test('old failure zero and missing metrics remain unknown; valid measured zero remains zero',()=>{
  assert.equal(lookupExecutionDuration({durationMs:0}),null);
  assert.equal(lookupExecutionMetrics({recoveryAttempts:0}),null);
  assert.equal(lookupExecutionDuration({durationMs:124}),124);
  const m={version:1,scope:'agent_command',durationMs:0,readerRebuildAttempts:0,appRestartAttempts:0,resultResumeAttempts:0};
  assert.equal(lookupExecutionDuration({diagnostic:{lookupExecution:m}}),0);
  assert.equal(lookupExecutionMetrics({diagnostic:{lookupExecution:{...m,readerRebuildAttempts:-1}}}),null);
});
test('large diagnostic compaction cannot erase metrics or carry extra metric payload',()=>{
  const m={version:1,scope:'agent_command',durationMs:1200,readerRebuildAttempts:1,appRestartAttempts:0,resultResumeAttempts:0};
  const r=sanitize(compact({diagnostic:{large:'x'.repeat(14000),lookupExecution:{...m,privateData:'do-not-copy'}}}));
  assert.equal(r.diagnostic.compacted,true);assert.deepEqual(r.diagnostic.lookupExecution,m);assert.doesNotMatch(JSON.stringify(r),/do-not-copy/);
});
for(const outcome of ['succeeded','failed','cancelled'])test(`actual Agent ${outcome} -> HTTP status -> sanitize -> admin retains execution metrics, excluding evidence/report time`,async t=>{
  let clock=0,receivedResolve;const received=new Promise(resolve=>receivedResolve=resolve);
  const state={devices:[],automationJobs:[],windowsTasks:[],evidenceAssets:[]};
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);const job={jobId:'j',kind:'alipay_name_query',status:body.status,result:sanitize(body.result)};
    state.automationJobs.push(job);res.writeHead(200,{'content-type':'application/json'});res.end('{}');receivedResolve(jobDetail(state,job));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const deps={log:()=>{},taskEvent:async()=>{},lookupStatusOutbox:{isAvailable:()=>true},
    taskAlipayNameLookupWithAccounts:()=>measureLookupExecution(async m=>{
      clock+=1234;m.readerRebuildAttempts=2;m.resultResumeAttempts=1;
      if(outcome!=='succeeded')throw Object.assign(Error(outcome),{code:outcome==='cancelled'?'automation_task_cancelled':'read_timeout'});
      return {realNameTailCharacter:'名'};
    },()=>clock),
    compactTaskResultForEvent:x=>x,taskFailureResult:failure,
    taskStatus:async(task,status,result)=>{clock+=2000;await fetch(`http://127.0.0.1:${server.address().port}/status`,{method:'POST',body:JSON.stringify({status,result:compact(result)})});},
    isAutomationTaskCancellation:e=>e.code==='automation_task_cancelled',isScreenPriorityCancellation:()=>false,
    captureFailureEvidence:async()=>{clock+=9000;return {};},shouldRunPostTaskDeviceScan:()=>false};
  const run=new Function(...Object.keys(deps),fn(agent,'runTask')+';return runTask;')(...Object.values(deps));
  await run({taskId:'t',type:'alipay_name_query'});const detail=await received;
  assert.equal(detail.status,outcome);assert.equal(detail.executionDurationMs,1234);assert.equal(detail.execution.readerRebuildAttempts,2);assert.equal(detail.execution.resultResumeAttempts,1);
});
test('retained job counters deduplicate jobs, distinguish cloud/human resumes, and count device transitions not assignments',()=>{
  const m={version:1,scope:'agent_command',durationMs:50,readerRebuildAttempts:2,appRestartAttempts:0,resultResumeAttempts:1};
  const j={jobId:'j',kind:'alipay_name_query',clientReference:'q',resumeAfterHumanVerification:true,recoveryOrigin:'page',result:{diagnostic:{lookupExecution:m}}};
  const jobs=[j,j,{...j,jobId:'h',recoveryOrigin:'human',result:{}},{...j,jobId:'u',recoveryOrigin:undefined,result:{}}];
  const attempts=[{deviceId:'a'},{deviceId:'a'},{deviceId:'b'},{deviceId:'a'}];
  const r=lookupRecoverySummary(jobs,attempts);assert.equal(r.retainedJobs,3);assert.equal(r.measuredJobs,1);assert.equal(r.unmeasuredJobs,2);assert.equal(r.readerRebuildAttempts,2);assert.equal(r.automaticRecoveryTasks,1);assert.equal(r.humanResumeTasks,1);assert.equal(r.unknownResumeTasks,1);assert.equal(r.crossDeviceHandoffs,2);
  const detail=requestDetail({automationJobs:jobs,devices:[],windowsTasks:[],evidenceAssets:[]},{lookupId:'q',attempts,status:'running'});assert.deepEqual(detail.recovery,r);
});
test('admin renders unknown as unrecorded, distinguishes createdAt from execution duration and labels counts as attempts',()=>{
  const ui=fs.readFileSync(new URL('../public/lookup-admin.js',import.meta.url),'utf8');
  const start=ui.indexOf('const executionText='),end=ui.indexOf('\nasync function detail(',start);
  const render=new Function('row','time','labels','jobKinds','errorLabels','esc',ui.slice(start,end)+';return jobsHtml;')((k,v)=>k+':'+v+'\n',x=>x||'',{}, {}, {},x=>x??'');
  const output=render([{kind:'alipay_name_query',status:'failed',createdAt:'created',executionDurationMs:null,execution:null,evidence:[],events:[]}]);
  assert.match(output,/任务创建时间:created/);assert.match(output,/本次执行耗时:未记录/);assert.match(output,/旧版不能按0次判断/);assert.doesNotMatch(output,/0\.000 秒/);
});
