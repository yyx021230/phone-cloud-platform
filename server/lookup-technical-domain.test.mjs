import test from 'node:test';import assert from 'node:assert/strict';
import {lookupFailureDomain,lookupTerminalResultReason} from './lookup-failure-domain.mjs';
for(const [reason,domain] of [
 ["error: device 'TEST-SERIAL' not found",'device'],
 ['error: device "TEST-SERIAL" unauthorized','device'],
 ["Command '['adb.exe', '-s', 'TEST', 'exec-out', 'screencap', '-p']' timed out after 15 seconds",'device'],
 ['poco_query_page_recovery_failed:poco_query_before_input_failed:RuntimeError:poco_rpc_failed:HTTPConnectionPool(test): Read timed out','device'],
 ['worker 已退出: verify_worker_adb_transport','device'],
 ['local_lookup_result_unconfirmed:foreground_changed','state'],
 ['poco_query_resume_observation_failed:local_lookup_result_unconfirmed:observation_budget_exhausted','page'],
 ['local_lookup_result_unconfirmed:ocr_reader_timeout','page'],
 ['model_read timed out after 120 seconds','page'],
 ['alipay_account_home_navigation_failed:search_activity_persisted','page'],
 ['selector_missing:我的','page'],
])test('incident classifier: '+reason,()=>{const j={result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:reason}}};assert.equal(lookupFailureDomain(j),domain);if(domain!=='page')assert.equal(lookupTerminalResultReason(j),'');});

test('preflight task_failed classifies explicit ADB not-found without runner diagnostic',()=>{
 assert.equal(lookupFailureDomain({result:{errorCode:'task_failed',message:"ADB 设备未连接：SYNTHETIC Command failed: adb.exe -s SYNTHETIC get-state\nerror: device 'SYNTHETIC' not found"}}),'device');
 for(const message of ['server_error',"error: device 'SYNTHETIC' not found",'ADB 设备未连接：SYNTHETIC timeout'])assert.equal(lookupFailureDomain({result:{errorCode:'task_failed',message}}),'');
 assert.equal(lookupFailureDomain({result:{errorCode:'alipay_lookup_result_unconfirmed',diagnostic:{runnerReason:'local_lookup_result_unconfirmed:network_refresh_unconfirmed'}}}),'network');
});

for(const line of ['error: device unauthorized.','error: device offline','error: device not found',"error: device 'SYNTHETIC' unauthorized",'error: device "SYNTHETIC" offline.']){
 for(const newline of ['\n','\r\n'])test('executor ADB stderr shape '+JSON.stringify([line,newline]),()=>{
  const message=['ADB 设备未连接：SYNTHETIC Command failed: adb.exe -s SYNTHETIC get-state',line,"Try 'adb kill-server' if that seems wrong.",'Otherwise check for a confirmation dialog on your device.'].join(newline);
  for(const kind of ['alipay_name_query','alipay_name_stop']){
   const job={kind,status:'failed',result:{errorCode:'task_failed',message}};
   assert.equal(lookupFailureDomain(job),'device');assert.equal(lookupTerminalResultReason(job),'');
  }
 });
}
for(const text of [
 'error: device unauthorized.',
 'unrelated\nADB 设备未连接：SYNTHETIC\nerror: device unauthorized.',
 'ADB 设备未连接：SYNTHETIC error: device unauthorized.',
 'ADB 设备未连接：SYNTHETIC\nTip: error: device unauthorized.',
 'ADB 设备未连接：SYNTHETIC\n"error: device unauthorized."',
 "ADB 设备未连接：SYNTHETIC\nTry 'adb kill-server' if that seems wrong.",
 "ADB 设备未连接：SYNTHETIC\nadb shell echo 'error: device unauthorized.'",
 'ADB 设备未连接：SYNTHETIC\nerror: device unauthorized. Try adb kill-server',
 'ADB 设备未连接：SYNTHETIC\nerror: device unauthorized-extra',
 'ADB 设备未连接：SYNTHETIC\nerror: device \'SYNTHETIC" unauthorized',
])test('non-stderr advice cannot classify task as device failure '+JSON.stringify(text),()=>{
 assert.equal(lookupFailureDomain({kind:'alipay_name_query',result:{errorCode:'task_failed',message:text}}),'');
});

for(const prefix of ['', 'poco_query_resume_observation_failed:'])test('exhausted ADB read stays transport: '+prefix,()=>{
 const j={result:{errorCode:'alipay_lookup_result_unconfirmed',diagnostic:{runnerReason:prefix+'local_lookup_result_unconfirmed:adb_read_unavailable'}}};
 assert.equal(lookupFailureDomain(j),'device');assert.equal(lookupTerminalResultReason(j),'');
});
test('empty successful read is not proof of transport failure',()=>{
 for(const reason of ['local_lookup_result_unconfirmed:adb_read_empty','local_lookup_result_unconfirmed:visual_card_not_proven','selector_missing:adb_read_unavailable'])assert.equal(lookupFailureDomain({result:{errorCode:'alipay_lookup_result_unconfirmed',diagnostic:{runnerReason:reason}}}),'page');
});

test('legacy missing-person error is a page recovery only for the exact query failure',()=>{const result={errorCode:'alipay_person_result_not_found',diagnostic:{runnerReason:'alipay_lookup_failed_after_recovery:alipay_person_result_not_found:texts=[]'}};assert.equal(lookupFailureDomain({kind:'alipay_name_query',result}),'page');for(const job of [{kind:'alipay_name_start',result},{kind:'alipay_name_query',result:{...result,diagnostic:{runnerReason:'unrelated'}}}])assert.notEqual(lookupFailureDomain(job),'page');});

for(const cause of ['timeout','device_unavailable','command_failed'])test('reader preflight transport failure cannot become image AI: '+cause,()=>{const j={kind:'alipay_name_query',result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:'poco_worker_bootstrap_failed:adb_probe:'+cause}}};assert.equal(lookupFailureDomain(j),'device');assert.equal(lookupTerminalResultReason(j),'');});

for(const reason of ['lookup_worker_capacity_reached','Airtest/Poco 常驻 worker 已达到上限 #，当前均在执行任务'])test('shared reader saturation is neither page AI nor a failed phone: '+reason,()=>{const j={result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:reason}}};assert.equal(lookupFailureDomain(j),'capacity');assert.equal(lookupTerminalResultReason(j),'');});
for(const reason of ['lookup_old_worker_exit_unconfirmed','poco_query_page_recovery_failed:lookup_old_worker_exit_unconfirmed','lookup_reader_cleanup_unconfirmed'])test('unconfirmed reader cleanup cannot consume screenshot as a page result: '+reason,()=>assert.equal(lookupFailureDomain({result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:reason}}}),'device'));
test('package manager preflight failure is eligible for transport recovery, not unknown round exclusion',()=>{assert.equal(lookupFailureDomain({result:{errorCode:'task_failed',message:'package_manager_unresponsive:FIXTURE:command timed out'}}),'device');assert.equal(lookupFailureDomain({result:{errorCode:'task_failed',message:'selector_missing:package_manager_unresponsive'}}),'');});
