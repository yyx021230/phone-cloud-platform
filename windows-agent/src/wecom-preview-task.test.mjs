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
