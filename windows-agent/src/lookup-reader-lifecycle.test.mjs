import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
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
