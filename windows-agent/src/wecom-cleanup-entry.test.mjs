import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {physicalBinding} from './wecom-cleanup-protocol.mjs';
import {handleWecomCleanupVerification} from './wecom-cleanup-verify.mjs';
import {PREINPUT_RECOVERY} from './wecom-preinput-recovery.mjs';
const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
const fixture=JSON.parse(fs.readFileSync(new URL('../../verification/wecom-cleanup-v1/fixtures.json',import.meta.url)));
function load(name,values){
  const match=source.match(new RegExp('^(?:async )?function '+name+'\\([\\s\\S]*?^\\}','m'));
  assert.ok(match,'actual Agent function exists');const context=vm.createContext(values);vm.runInContext(match[0],context);return context[name];
}
const config={agentId:fixture.binding.agentId,serverBaseUrl:'http://127.0.0.1:1',agentToken:'fixture-only'};
const ordinary={type:'wecom_customer_preview',taskId:fixture.binding.originalTaskId,agentId:config.agentId,deviceId:fixture.binding.deviceId,adbSerial:fixture.binding.serial,payload:{appSlot:'main',androidUser:0,physicalCleanup:fixture.binding}};

test('actual cap1 Agent entry rejects missing obligation before API or spawn',async()=>{
  let called=0;const run=load('taskWecomPreview',{config,agentDir:'/fixture',physicalBinding,api:()=>{called++;throw Error('no API');},runWecomPreviewTask:()=>{called++;throw Error('no spawn');},log:()=>{}});
  const legacy={...ordinary,payload:{appSlot:'main',androidUser:0}};
  await assert.rejects(run(legacy),/binding_missing/);assert.equal(called,0);
});
test('actual bound entry goes through the product readiness wrapper',async()=>{
  let called=0;const run=load('taskWecomPreview',{config,agentDir:'/fixture',physicalBinding,api:()=>assert.fail('no pre-host phone lease'),runWecomPreviewTask:async(t,options)=>{called++;assert.equal(t,ordinary);assert.equal(options.config,config);return'fixture';},log:()=>{}});
  assert.equal(await run(ordinary),'fixture');assert.equal(called,1);
});
test('actual runTask verification bypasses generic success, evidence and scan',async()=>{
  const statuses=[];
  const run=load('runTask',{config,agentDir:'/fixture',
    handleWecomCleanupVerification:(task,options)=>handleWecomCleanupVerification(task,{...options,run:async()=>({verified:true})}),
    taskEvent:async()=>{},taskStatus:async(...args)=>statuses.push(args),
    log:()=>assert.fail('generic runTask body must not start'),captureFailureEvidence:()=>assert.fail('no evidence'),scanAndSync:()=>assert.fail('no scan')});
  assert.equal((await run({type:'wecom_cleanup_verify',taskId:'fixture'})).verified,true);assert.equal(statuses.length,0);
});
test('actual verification failure reports fixed failure without generic capture path',async()=>{
  const statuses=[];
  const run=load('runTask',{config,agentDir:'/fixture',
    handleWecomCleanupVerification:(task,options)=>handleWecomCleanupVerification(task,{...options,run:async()=>{throw Error('wecom_reader_still_present');}}),
    taskEvent:async()=>{},taskStatus:async(...args)=>statuses.push(args),log:()=>assert.fail('no generic log'),captureFailureEvidence:()=>assert.fail('no evidence'),scanAndSync:()=>assert.fail('no scan')});
  await run({type:'wecom_cleanup_verify',taskId:'fixture'});assert.equal(statuses.length,1);assert.equal(statuses[0][1],'failed');
});
test('actual polling advertises protocol and does not start verification after unknown ACK',async()=>{
  let polls=0,starts=0;
  const run=load('pollTask',{config:{...config,maxConcurrentAdbTasks:1},activeTasksById:new Map(),activeTaskSerials:new Set(),screenControlledSerials:new Set(),lookupStatusOutbox:{pendingTasks:()=>[]},
    URLSearchParams,PREINPUT_RECOVERY,MANAGED_LOOKUP_PROTOCOL:'fixture',SCREEN_GALLERY_DELIVERY_PROTOCOL:'fixture',XHS_PUBLISH_DELIVERY_PROTOCOL:'fixture',lookupReaderCapacityReport:()=>({}),
    observeLookupReaderAdmission:()=>{},abortCancelledAutomationTasks:()=>{},log:()=>{},
    api:async route=>{polls++;assert.equal(new URL('http://fixture'+route).searchParams.get('wecomCleanupProtocol'),'1');assert.equal(new URL('http://fixture'+route).searchParams.get('wecomPreinputRecovery'),PREINPUT_RECOVERY);return polls===1?{task:{taskId:'fixture',type:'wecom_cleanup_verify',payload:{}},cancelledTaskIds:[]}:{task:null};},
    hydrateLeasedWindowsTask:async task=>({task,acknowledged:false,acknowledgementError:Error('fixture')}),startTask:()=>starts++});
  await run();assert.equal(starts,0);assert.equal(polls,2);
});
test('actual recovery entry selects only the new read-only leaf, bypassing generic phone actions',async()=>{
  let calls=0;
  const leaf=async()=>{calls++;return {verified:false,pending:true};};
  const run=load('runTask',{config,agentDir:'/fixture',runWecomPreinputRecovery:leaf,
    handleWecomCleanupVerification:async(task,options)=>{assert.equal(options.run,leaf);return options.run(task,options);},
    taskEvent:async()=>{},taskStatus:()=>assert.fail('no generic status'),log:()=>assert.fail('no generic runTask body'),scanAndSync:()=>assert.fail('no scan')});
  assert.equal((await run({type:'wecom_cleanup_verify',payload:{preinputRecovery:PREINPUT_RECOVERY}})).pending,true);assert.equal(calls,1);
});
