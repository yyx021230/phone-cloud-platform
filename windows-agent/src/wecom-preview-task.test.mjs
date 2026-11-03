import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runWecomPreviewTask } from "./wecom-preview-task.mjs";

const task = { type: "wecom_customer_preview", taskId: "fixture", deviceId: "adb:fixture", adbSerial: "fixture", payload: { previewOnly: true, phoneNumber: "13800138000", deviceNumber: "25", androidUser: 0 } };
const config = { pythonCommand: "fixture-python", agentId: "fixture", agentToken: "fixture-token", serverBaseUrl: "http://127.0.0.1:8787" };
function childFixture(output, exitCode=0) {
  let args; let input="";
  const spawnChild = (...values) => {
    args=values;
    const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.stdin=new PassThrough(); child.kill=()=>{};
    child.stdin.on("data", chunk=>{ input+=chunk; queueMicrotask(()=>{ child.stderr.write("private library diagnostics"); child.stdout.write(JSON.stringify(output)); child.emit("close",exitCode); }); });
    return child;
  };
  return {spawnChild,values:()=>({args,input})};
}
test("preview child receives secrets only on stdin and exposes only bounded public fields", async()=>{
  const fixture=childFixture({previewStatus:"ready_before_send",previewCode:"preview_ready",invitationSent:false,remarkSaveStatus:"confirmed",privateField:"must disappear"});
  const result=await runWecomPreviewTask(task,{config,agentDir:"/fixture",spawnChild:fixture.spawnChild});
  assert.equal(result.previewStatus,"ready_before_send"); assert.equal(result.invitationSent,false);assert.equal(result.privateField,undefined);
  assert.ok(!JSON.stringify(fixture.values().args).includes(config.agentToken));assert.ok(!JSON.stringify(fixture.values().args).includes(task.payload.phoneNumber));
  assert.equal(JSON.parse(fixture.values().input).agentToken,config.agentToken);
});
test("uncertain remark state remains blocked without replay",async()=>{
  const fixture=childFixture({previewStatus:"blocked",previewCode:"remark_persistence_unconfirmed",invitationSent:false,remarkSaveStatus:"unknown"});
  const result=await runWecomPreviewTask(task,{config,agentDir:"/fixture",spawnChild:fixture.spawnChild});
  assert.equal(result.previewStatus,"blocked");assert.equal(result.remarkSaveStatus,"unknown");
});
test("custom remark and multiline description travel only on stdin",async()=>{
  const remarkName="本地客户😀",description="渠道A\n联调备注";
  const fixture=childFixture({previewStatus:"ready_before_send",previewCode:"stopped_before_send",invitationSent:false});
  await runWecomPreviewTask({...task,payload:{...task.payload,remarkName,description}},{config,agentDir:"/fixture",spawnChild:fixture.spawnChild});
  const input=JSON.parse(fixture.values().input);assert.equal(input.remarkName,remarkName);assert.equal(input.description,description);
  assert.ok(!JSON.stringify(fixture.values().args).includes(remarkName));assert.ok(!JSON.stringify(fixture.values().args).includes(description));
});
test("explicit main and clone choice is carried on stdin without an Android-user fallback",async()=>{
  for(const [appSlot,androidUser] of [["main",0],["clone",999]]) {
    const fixture=childFixture({previewStatus:"ready_before_send",previewCode:"stopped_before_send",invitationSent:false});
    await runWecomPreviewTask({...task,payload:{...task.payload,deviceNumber:"155",appSlot,androidUser}},{config,agentDir:"/fixture",spawnChild:fixture.spawnChild});
    const payload=JSON.parse(fixture.values().input);assert.equal(payload.appSlot,appSlot);assert.equal(payload.androidUser,androidUser);
  }
});
test("claimed send success, invalid statuses and nonzero exits fail closed",async()=>{
  for (const [output,exit] of [[{previewStatus:"ready_before_send",previewCode:"sent",invitationSent:true},0],[{previewStatus:"sent",previewCode:"sent",invitationSent:false},0],[{},2]]) {
    const fixture=childFixture(output,exit);await assert.rejects(runWecomPreviewTask(task,{config,agentDir:"/fixture",spawnChild:fixture.spawnChild}),/outcome_unknown/);
  }
});
test("cancelled and non-preview tasks cannot start a child",async()=>{
  const controller=new AbortController();controller.abort(new Error("fixture_cancel"));
  const spawnChild=()=>{throw new Error("must not spawn");};
  await assert.rejects(runWecomPreviewTask(task,{config,agentDir:"/fixture",signal:controller.signal,spawnChild}),/fixture_cancel/);
  await assert.rejects(runWecomPreviewTask({...task,payload:{previewOnly:false}},{config,agentDir:"/fixture",spawnChild}),/invalid_wecom_preview_task/);
});

test("active cancellation keeps ownership until the child acknowledges cleanup and exits", async()=>{
  const controller=new AbortController(); let child; let cancelReceived=false; let finished=false;
  const spawnChild=()=>{
    child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>assert.fail("cooperative child must not be killed");
    child.stdin.on("data",chunk=>{ if(String(chunk)==="cancel\n") cancelReceived=true; });return child;
  };
  const pending=runWecomPreviewTask(task,{config,agentDir:"/fixture",signal:controller.signal,spawnChild}).finally(()=>{finished=true;});
  controller.abort(new Error("fixture_active_cancel"));
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(cancelReceived,true);assert.equal(finished,false);
  child.emit("close",0);await assert.rejects(pending,/fixture_active_cancel/);assert.equal(finished,true);
});


test("sending uses an explicit mode and private fixed claim directory; unknown delivery stays unknown",async()=>{
  const fixture=childFixture({previewStatus:"send_attempted",previewCode:"invitation_click_issued_delivery_unknown",invitationSent:null,sendStatus:"unknown",remarkSaveStatus:"confirmed"});
  const result=await runWecomPreviewTask({...task,payload:{...task.payload,mode:"send",previewOnly:false,appSlot:"clone",androidUser:999}},{config,agentDir:"/fixture",spawnChild:fixture.spawnChild});
  assert.equal(result.sendStatus,"unknown");assert.equal(result.invitationSent,null);
  const payload=JSON.parse(fixture.values().input);
  assert.equal(payload.mode,"send");assert.equal(payload.claimDirectory,"/fixture/data/wecom-send-claims");
  assert.equal(payload.appSlot,"clone");assert.equal(payload.androidUser,999);
});

test("a send worker may never turn a click into confirmed delivery or silently preview instead",async()=>{
  for (const output of [{previewStatus:"send_attempted",previewCode:"sent",invitationSent:true,sendStatus:"unknown"},{previewStatus:"ready_before_send",previewCode:"preview_ready",invitationSent:false}]) {
    const fixture=childFixture(output);
    await assert.rejects(runWecomPreviewTask({...task,payload:{...task.payload,mode:"send",previewOnly:false}},{config,agentDir:"/fixture",spawnChild:fixture.spawnChild}),/outcome_unknown/);
  }
});

const progressLine = (phase, step=1, state='begin', extra={}) => 'WECOM_DIAGNOSTIC '+JSON.stringify({version:1,step,phase,state,elapsedMs:step,...extra})+'\n';
function manualChild() {
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};return child;
}
test('split progress records survive; arbitrary stderr, oversized and regressing frames are discarded', async()=>{
  const child=manualChild();
  const pending=runWecomPreviewTask(task,{config,agentDir:'/fixture',spawnChild:()=>child});
  const line=progressLine('foreground_wait');child.stderr.write(line.slice(0,9));child.stderr.write(line.slice(9));
  child.stderr.write('raw private phone UI token\n');
  child.stderr.write(progressLine('selector_click',2,'begin',{phoneNumber:'private'}));
  child.stderr.write('X'.repeat(2000)+progressLine('selector_click',2));
  child.stderr.write(progressLine('selector_click',2));child.stderr.write(progressLine('home_navigation',1));
  child.stderr.write(progressLine('cleanup',3,'end',{cleanupConfirmed:false}));
  child.stdout.write(JSON.stringify({previewStatus:'blocked',previewCode:'wecom_launch_not_ready',invitationSent:false}));child.emit('close',0);
  const result=await pending, execution=result.diagnostic.wecomExecution;
  assert.equal(execution.cleanupConfirmed,false);assert.deepEqual(execution.events.map(e=>e.phase),['foreground_wait','selector_click','cleanup']);
  assert.equal(JSON.stringify(result).includes('private'),false);
});
test('parent watchdog retains last stage and waits for child cleanup without replay', async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=manualChild();let cancelled=0,finished=false;
  child.stdin.on('data',chunk=>{if(String(chunk)==='cancel\n')cancelled++;});
  const pending=runWecomPreviewTask(task,{config,agentDir:'/fixture',spawnChild:()=>child}).finally(()=>{finished=true;});
  child.stderr.write(progressLine('selector_click'));
  t.mock.timers.tick(230000);await Promise.resolve();assert.equal(cancelled,1);assert.equal(finished,false);
  child.stderr.write(progressLine('cleanup',2,'end',{cleanupConfirmed:false}));
  child.emit('close',0);
  await assert.rejects(pending,error=>{
    assert.equal(error.message,'wecom_preview_worker_timeout_no_replay');
    assert.equal(error.diagnostic.wecomExecution.cleanupConfirmed,false);
    assert.equal(error.diagnostic.wecomExecution.events[0].phase,'selector_click');return true;
  });
});
test('real Python adapter configuration rejection crosses the child pipe with a fixed stage and no ADB', async()=>{
  const { fileURLToPath }=await import('node:url');
  const agentDir=fileURLToPath(new URL('..',import.meta.url));
  const result=await runWecomPreviewTask(task,{config:{...config,pythonCommand:'python3'},agentDir});
  assert.equal(result.previewCode,'device_not_authorized');
  assert.equal(result.diagnostic.wecomExecution.failurePhase,'configuration');
  assert.equal(result.invitationSent,false);
});

test('CPS phone verification flag reaches stdin; successful output without independent proof fails closed',async()=>{
  const cps={...task,payload:{...task.payload,requireRemarkPhone:true}};
  const valid=childFixture({previewStatus:'ready_before_send',previewCode:'stopped_before_send',invitationSent:false,remarkPhoneSet:true});
  const result=await runWecomPreviewTask(cps,{config,agentDir:'/fixture',spawnChild:valid.spawnChild});
  assert.equal(JSON.parse(valid.values().input).requireRemarkPhone,true);assert.equal(result.remarkPhoneSet,true);
  const missing=childFixture({previewStatus:'ready_before_send',previewCode:'stopped_before_send',invitationSent:false});
  await assert.rejects(runWecomPreviewTask(cps,{config,agentDir:'/fixture',spawnChild:missing.spawnChild}),/outcome_unknown/);
});
