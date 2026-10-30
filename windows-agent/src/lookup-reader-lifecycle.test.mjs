import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {requireConfirmedLookupCleanup} from './lookup-cleanup-policy.mjs';
import {isLookupReaderRecovery,readerExitDiagnostic,verifyLookupReaderCleanup,lookupReaderStopReason} from './lookup-reader-lifecycle.mjs';
import {restartLookupQueryOnce} from './lookup-page-recovery.mjs';
const source=await fs.readFile(new URL('./index.mjs',import.meta.url),'utf8');

test('only lookup recovery receives the new stop protocol',()=>{
 for(const r of ['lookup_query_app_recovery','poco_query_result_channel_timeout','poco_query_resume_result_channel_timeout','lookup_session_stopped','automatic_account_rotation'])assert.ok(isLookupReaderRecovery(r));
 for(const r of ['screen_control','xml_uiautomator','agent_shutdown','resident_limit','idle_timeout','task_timeout'])assert.equal(isLookupReaderRecovery(r),false);
});
test('long traceback keeps safe stage and cause, never raw secrets',()=>{
 const d=readerExitDiagnostic('private-phone secret '+ 'noise'.repeat(200)+'poco_worker_bootstrap_failed:adb_probe:timeout',1,null);
 assert.deepEqual(d,{stage:'adb_probe',cause:'timeout',exitCode:1,signal:null});
 assert.equal(readerExitDiagnostic('unrecognized account text').cause,'unknown');
});
test('wrapped instrumentation dependency failure survives worker exit without private data',()=>{
 const d=readerExitDiagnostic('poco_worker_instrumentation_handshake_failed:elapsedMs=312:poco_worker_bootstrap_failed:instrumentation:dependency_missing',1,null);
 assert.deepEqual(d,{stage:'instrumentation',cause:'dependency_missing',exitCode:1,signal:null});
 assert.equal(readerExitDiagnostic('poco_worker_transport_probe_failed:poco_worker_bootstrap_failed:transport_probe:timeout').stage,'transport_probe');
});
test('cleanup touches only this serial and Poco forwards',async()=>{
 const calls=[];let removed=false;
 assert.equal(await verifyLookupReaderCleanup('one',async args=>{calls.push(args);assert.deepEqual(args.slice(0,2),['-s','one']);
 if(args[2]==='shell'&&args[3].startsWith('pidof'))return 'LOOKUP_READER_ABSENT';
 if(args[2]==='forward'&&args[3]==='--list')return (removed?'':'one tcp:123 tcp:10080\n')+'two tcp:456 tcp:10080\none tcp:789 localabstract:scrcpy';
 if(args[3]==='--remove'){assert.equal(args[4],'tcp:123');removed=true;}return '';}),true);
 assert.equal(calls.filter(x=>x.includes('--remove')).length,1);
});
for(const returned of ['1234','', 'pidof: permission denied'])test('unconfirmed absence blocks recovery: '+JSON.stringify(returned),async()=>{
 await assert.rejects(verifyLookupReaderCleanup('one',async args=>args[3]?.startsWith('pidof')?returned:''),/cleanup_unconfirmed/);
});
test('read failure is not swallowed as cleanup success',async()=>{await assert.rejects(verifyLookupReaderCleanup('one',async()=>{throw Error('read failure')}),/read failure/);});
test('lookup stop waits for confirmation and preserves screen budget/protocol',async()=>{
 const begin=source.indexOf('async function stopAirtestWorkerImpl('),end=source.indexOf('async function cleanupAirtestDeviceAfterForcedStop',begin);
 async function exercise(reason,confirmed){const sent=[];let options;
 const worker={child:{stdin:{write:x=>sent.push(x)}}};
 const fn=new Function('airtestWorkersBySerial','isLookupReaderRecovery','stopWorkerWithFallback','verifyLookupReaderCleanup','run','config','log','cleanupAirtestForwardsAfterStop',source.slice(begin,end)+';return stopAirtestWorkerImpl;')(new Map([['one',worker]]),isLookupReaderRecovery,async(w,o)=>{options=o;o.requestStop();w.lookupStopConfirmed=confirmed;return {exited:true,forced:false};},async()=>{throw Error('failed cleanup');},()=>{}, {},()=>{},async()=>{});
 return {ok:await fn('one',reason),sent,options};}
 const bad=await exercise('lookup_query_app_recovery',false);assert.equal(bad.ok,false);assert.equal(bad.sent[0],'__exit_lookup__\n');assert.equal(bad.options.gracefulTimeoutMs,5000);
 const good=await exercise('lookup_query_app_recovery',true);assert.equal(good.ok,true);
 const screen=await exercise('screen_control',false);assert.equal(screen.ok,true);assert.equal(screen.sent[0],'__exit__\n');assert.equal(screen.options.gracefulTimeoutMs,5000);
});
test('submitted raw failure observes original request once without replay',async()=>{const operations=[];
 const result=await restartLookupQueryOnce({operation:'query',error:new Error('HTTPConnectionPool(host=local): Read timed out'),payload:{taskId:'original'},submitted:true,stopWorker:async()=>true,onRecovery:async()=>{},runWorker:async p=>{operations.push(p);return {ok:true};}});
 assert.ok(result.ok);assert.equal(operations.length,1);assert.equal(operations[0].taskId,'original');assert.equal(operations[0].operation,'query_resume');assert.equal(operations[0].allowEmptyInputRecovery,false);assert.equal(operations[0].recoverUnexpectedPage,false);
});

test('generic lookup preflight and RPC deadlines use lookup cleanup, other workflows unchanged',()=>{
 for(const r of ['ready_timeout','idle_before_task','poco_probe_failed','task_timeout']){
  assert.ok(isLookupReaderRecovery(lookupReaderStopReason({workflow:'alipay_name'},r)));
  assert.equal(lookupReaderStopReason({workflow:'xhs'},r),r);
  assert.equal(lookupReaderStopReason({},r),r);
 }
 assert.equal(lookupReaderStopReason({workflow:'alipay_name'},'screen_control'),'screen_control');
});
test('lookup recycle rejects unconfirmed cleanup before another worker starts',async()=>{
 const start=source.indexOf('async function recycleAirtestWorker('),end=source.indexOf('function hasActiveAirtestLookupWarmLease(',start);
 let created=0;
 const fn=new Function('airtestWorkersBySerial','stopAirtestWorker','isLookupReaderRecovery','waitForWorkerExit','getAirtestWorker',source.slice(start,end)+';return recycleAirtestWorker;')(new Map([['one',{}]]),async()=>false,isLookupReaderRecovery,async()=>true,async()=>{created++;});
 await assert.rejects(fn('one','lookup_reader_poco_probe_failed'),/cleanup_unconfirmed/);assert.equal(created,0);
 await fn('one','poco_probe_failed');assert.equal(created,1);
});

test('lost force-stop ACK requires real absence and forward confirmation',async()=>{
 let forceAttempts=0,checks=0;
 const ok=await verifyLookupReaderCleanup('one',async args=>{
  if(args[3]==='am'){forceAttempts++;throw Error('command acknowledgement timeout');}
  if(args[3]?.startsWith('pidof')){checks++;return 'LOOKUP_READER_ABSENT';}
  return '';
 });
 assert.equal(ok,true);assert.equal(forceAttempts,2);assert.equal(checks,2);
 await assert.rejects(verifyLookupReaderCleanup('one',async args=>{if(args[3]==='am')throw Error('timeout');return '1234';}),/cleanup_unconfirmed/);
});

test('worker exit cancels old timeout before replacement with same serial can run',async()=>{
 const {rejectExitedReaderRequest}=await import('./lookup-reader-lifecycle.mjs');let stopped=false,rejected=0;
 const worker={pending:{timer:setTimeout(()=>{stopped=true;},15),reject:()=>{rejected++;}}};
 assert.equal(rejectExitedReaderRequest(worker,Error('exited')),true);
 assert.equal(rejectExitedReaderRequest(worker,Error('duplicate exit')),false);
 await new Promise(r=>setTimeout(r,35));assert.equal(stopped,false);assert.equal(rejected,1);assert.equal(worker.pending,null);
});

test('actual worker exit/error handlers cannot time out the next worker on the same serial',async()=>{
 const {EventEmitter}=await import('node:events');const {rejectExitedReaderRequest}=await import('./lookup-reader-lifecycle.mjs');
 const body=source.slice(source.indexOf('function createAirtestWorker('),source.indexOf('function handleAirtestWorkerLine('));
 for(const event of ['exit','error']){
  const timers=new Map(),workers=new Map();let id=0,stops=0,rejections=0;
  const schedule=(f)=>{timers.set(++id,f);return id;};const clear=t=>timers.delete(t);
  const spawn=()=>{const c=new EventEmitter();for(const k of ['stdout','stderr']){c[k]=new EventEmitter();c[k].setEncoding=()=>{};}return c;};
  const deps={spawn,config:{},agentDir:'.',airtestEnv:()=>({}),setTimeout:schedule,clearTimeout:clear,
   airtestWorkersBySerial:workers,readerExitDiagnostic,log:()=>{},stopAirtestWorker:async()=>{stops++;},
   rejectExitedReaderRequest:(w,e)=>rejectExitedReaderRequest(w,e,clear)};
  const create=new Function(...Object.keys(deps),body+';return createAirtestWorker;')(...Object.values(deps));
  const old=create('same');old.readyPromise.catch(()=>{});workers.set('same',old);
  old.pending={timer:schedule(()=>{stops++;}),reject:()=>{rejections++;}};
  old.child.emit(event,event==='exit'?1:Error('spawn error'));
  const replacement={serial:'same',healthy:true};workers.set('same',replacement);
  for(const f of timers.values())f();await Promise.resolve();
  assert.equal(stops,0,event);assert.equal(rejections,1);assert.equal(workers.get('same'),replacement);
 }
});

test('lookup recovery proves Android cleanup after host worker was removed',async()=>{
 const begin=source.indexOf('async function stopAirtestWorkerImpl('),end=source.indexOf('async function cleanupAirtestDeviceAfterForcedStop',begin);
 for(const state of ['absent','still_running','transport_timeout']){
  const calls=[];
  const run=async(command,args,options)=>{
   assert.equal(command,'existing-adb');
   calls.push(args);assert.deepEqual(args.slice(0,2),['-s','one']);assert.ok(options.timeoutMs<=2000);
   if(state==='transport_timeout')throw Error('shell timeout');
   if(args[3]?.startsWith('pidof'))return state==='absent'?'LOOKUP_READER_ABSENT':'3731';
   return '';
  };
  const stop=new Function('airtestWorkersBySerial','isLookupReaderRecovery','verifyLookupReaderCleanup','run','config','log',source.slice(begin,end)+';return stopAirtestWorkerImpl;')(
   new Map(),isLookupReaderRecovery,verifyLookupReaderCleanup,run,{adbPath:'existing-adb'},()=>{});
  let resumes=0;
  const attempt=()=>restartLookupQueryOnce({operation:'query',error:Error('HTTPConnectionPool(local): Read timed out'),payload:{taskId:'original'},submitted:true,
   stopWorker:()=>stop('one','lookup_query_app_recovery'),onRecovery:async()=>{},runWorker:async p=>{resumes++;assert.equal(p.taskId,'original');assert.equal(p.operation,'query_resume');assert.equal(p.allowEmptyInputRecovery,false);return {ok:true};}});
  if(state==='absent'){assert.ok((await attempt()).ok);assert.equal(resumes,1);}
  else{await assert.rejects(attempt,/old_worker_exit_unconfirmed/);assert.equal(resumes,0);}
  assert.ok(calls.length>0);
  const before=calls.length;
  for(const reason of ['screen_control','xml_uiautomator','resident_limit','agent_shutdown'])assert.equal(await stop('one',reason),true);
  assert.equal(calls.length,before,'unrelated absent-worker paths perform no new cleanup');
 }
});

test('lookup recycle checks cleanup even when exit already deleted worker',async()=>{
 const start=source.indexOf('async function recycleAirtestWorker('),end=source.indexOf('function hasActiveAirtestLookupWarmLease(',start);
 let stopped=0,created=0,confirmed=false;
 const fn=new Function('airtestWorkersBySerial','stopAirtestWorker','isLookupReaderRecovery','waitForWorkerExit','getAirtestWorker',source.slice(start,end)+';return recycleAirtestWorker;')(
  new Map(),async()=>{stopped++;return confirmed;},isLookupReaderRecovery,async()=>{throw Error('no host to wait for');},async()=>{created++;return {};});
 await assert.rejects(fn('one','lookup_reader_poco_probe_failed'),/cleanup_unconfirmed/);assert.equal(created,0);assert.equal(stopped,1);
 confirmed=true;await fn('one','lookup_reader_poco_probe_failed');assert.equal(created,1);assert.equal(stopped,2);
 await fn('one','poco_probe_failed');assert.equal(created,2);assert.equal(stopped,2);
});

test('cleanup command failure records bounded stage without losing original error',async()=>{
 const original=Object.assign(Error('private-output'),{killed:true});
 await assert.rejects(verifyLookupReaderCleanup('one',async args=>{
  if(args[3]?.startsWith('pidof'))throw original;
  return '';
 }),error=>{
  assert.equal(error,original);
  assert.deepEqual(error.lookupCleanup,{version:1,stage:'absence_check',component:'poco_service',outcome:'timeout'});
  assert.ok(!JSON.stringify(error.lookupCleanup).includes('private-output'));
  return true;
 });
});
for(const stage of ['forward_list','forward_remove','forward_check'])test('cleanup diagnostics distinguish '+stage,async()=>{
 let lists=0;
 await assert.rejects(verifyLookupReaderCleanup('one',async args=>{
  if(args[3]?.startsWith('pidof'))return 'LOOKUP_READER_ABSENT';
  if(args[2]!=='forward')return '';
  if(args[3]==='--list'){
   lists++;
   if(stage==='forward_list'||stage==='forward_check'&&lists===2)throw Error('command failed');
   return 'one tcp:123 tcp:10080';
  }
  if(stage==='forward_remove')throw Error('command failed');
  return '';
 }),error=>{assert.deepEqual(error.lookupCleanup,{version:1,stage,component:'poco_forwards',outcome:'command_failed'});return true;});
});
test('absence and remaining forward are not mistaken for command failures or success',async()=>{
 await assert.rejects(verifyLookupReaderCleanup('one',async args=>args[3]?.startsWith('pidof')?'1234':''),
  error=>{assert.equal(error.lookupCleanup.outcome,'absence_unconfirmed');return true;});
 await assert.rejects(verifyLookupReaderCleanup('one',async args=>args[3]?.startsWith('pidof')?'LOOKUP_READER_ABSENT':args[3]==='--list'?'one tcp:123 tcp:10080':''),
  error=>{assert.equal(error.lookupCleanup.outcome,'forward_remaining');assert.equal(error.lookupCleanup.stage,'forward_check');return true;});
});
test('shared cleanup budget remains eight seconds and no command starts after it expires',async()=>{
 let clock=0,calls=0;
 await assert.rejects(verifyLookupReaderCleanup('one',async()=>{calls++;clock=8000;throw Error('lost ACK');},()=>clock),
  error=>{assert.equal(error.message,'lookup_reader_cleanup_deadline');assert.equal(error.lookupCleanup.outcome,'deadline');return true;});
 assert.equal(calls,1);
});
test('actual absent-worker stop logs cleanup stage and keeps false; screen stop stays untouched',async()=>{
 const begin=source.indexOf('async function stopAirtestWorkerImpl('),end=source.indexOf('async function cleanupAirtestDeviceAfterForcedStop',begin);
 const logs=[];let checks=0;
 const stop=new Function('airtestWorkersBySerial','isLookupReaderRecovery','verifyLookupReaderCleanup','run','config','log',source.slice(begin,end)+';return stopAirtestWorkerImpl;')(
  new Map(),isLookupReaderRecovery,async()=>{checks++;throw Object.assign(Error('failure'),{lookupCleanup:{version:1,stage:'absence_check',component:'poco_service',outcome:'command_failed'}});},assert.fail,{adbPath:'unused'},(event,detail)=>logs.push({event,detail}));
 assert.equal(await stop('one','lookup_session_stopped'),false);
 assert.equal(logs[0].event,'lookup reader cleanup unconfirmed');
 assert.equal(logs[0].detail.cleanup.stage,'absence_check');
 assert.equal(await stop('one','screen_control'),true);
 assert.equal(checks,1);
});

test('exited-reader observation proves absence without issuing another force-stop',async()=>{
 const calls=[];
 assert.equal(await verifyLookupReaderCleanup('one',async args=>{
  calls.push(args);return args[3]?.startsWith('pidof')?'LOOKUP_READER_ABSENT':'';
 },Date.now,{observeFirst:true}),true);
 assert.equal(calls.filter(a=>a.includes('force-stop')).length,0);
 assert.equal(calls.filter(a=>a[3]?.startsWith('pidof')).length,2);
});
test('exited-reader observed process still requires targeted stop and fresh absence',async()=>{
 const stopped=new Set(),calls=[];
 assert.equal(await verifyLookupReaderCleanup('one',async args=>{
  calls.push(args);
  if(args[3]?.startsWith('pidof'))return stopped.has(args[3].split(' ')[1])?'LOOKUP_READER_ABSENT':'1234';
  if(args[3]==='am')stopped.add(args[5]);
  return '';
 },Date.now,{observeFirst:true}),true);
 assert.equal(calls.filter(a=>a.includes('force-stop')).length,2);
 assert.equal(calls.filter(a=>a[3]?.startsWith('pidof')).length,4);
});
test('exited-reader observation failure cannot be promoted to absence or skip proof',async()=>{
 let forces=0;
 await assert.rejects(verifyLookupReaderCleanup('one',async args=>{
  if(args[3]?.startsWith('pidof'))throw Error('unavailable');
  if(args[3]==='am')forces++;
  return '';
 },Date.now,{observeFirst:true}),/unavailable/);
 assert.equal(forces,1);
});

for(const workflow of ['alipay_name','xhs_qr'])for(const mode of ['false','throw','true'])test('actual ready-timeout cleanup '+workflow+' '+mode,async()=>{
 const original=Error('Airtest/Poco worker 启动超时');let stops=0;
 const start=source.indexOf('async function runXhsAirtestPocoWorker('),end=source.indexOf('\nasync function probeAirtestWorker(',start);
 const deps={getAirtestWorker:async()=>{throw original;},delay:()=>new Promise(()=>{}),lookupReaderStopReason,requireConfirmedLookupCleanup,
  stopAirtestWorker:async()=>{stops++;if(mode==='throw')throw Error('not stopped');return mode==='true';}};
 const run=new Function(...Object.keys(deps),source.slice(start,end)+';return runXhsAirtestPocoWorker;')(...Object.values(deps));
 await assert.rejects(run({serial:'synthetic',workflow},{readyTimeoutMs:1}),e=>{
  if(workflow==='alipay_name'&&mode!=='true')assert.equal(e.code,'lookup_reader_cleanup_unconfirmed');
  else assert.equal(e,original);
  return true;
 });
 assert.equal(stops,1);
});
