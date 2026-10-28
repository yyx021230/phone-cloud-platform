import test from "node:test";
import assert from "node:assert/strict";
import { createWecomPanelModel, wecomStatusLabel } from "../public/wecom-automation-ui.js";

const ctx={userId:"fixture-admin",role:"admin",token:"fixture-token"};
const inventory={devices:[{deviceId:"adb:fixture155",available:true,appSlot:"clone",appSlots:[{appSlot:"main",androidUser:0},{appSlot:"clone",androidUser:999}]},{deviceId:"adb:fixture25",available:true,appSlot:"main",appSlots:[{appSlot:"main",androidUser:0}]}]};
const input={deviceId:"adb:fixture155",appSlot:"clone",phoneNumber:"13800138000",requestId:"fixture_request_001",remarkName:"本地备注",description:"仅用于本地模拟"};
function storageFixture(){const saved=new Map();return {saved,getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("a completed worker is not shown as ready without the explicit preview proof",()=>{
  assert.match(wecomStatusLabel({status:"succeeded",result:{status:"ready_before_send"}}),/已到发送前/);
  assert.doesNotMatch(wecomStatusLabel({status:"succeeded",result:{}}),/已到发送前/);
  assert.doesNotMatch(wecomStatusLabel({status:"succeeded",result:{status:"blocked"}}),/已到发送前/);
});

test("timeout keeps original request across reload and blocks both slots of that phone, not another phone",async()=>{
  const storage=storageFixture();let posts=0;let tasks=[];
  const request=async(c,p,data)=>{
    if(!data)return p.endsWith("devices")?inventory:{tasks};
    posts++;if(data.deviceId===input.deviceId)throw new Error("fixture_timeout");
    return {task:{jobId:"other",deviceId:data.deviceId,appSlot:data.appSlot,requestId:data.requestId,status:"queued"}};
  };
  const first=createWecomPanelModel({storage,request});await first.refresh(ctx);
  await assert.rejects(first.submit(ctx,input),/timeout/);assert.equal(posts,1);
  const disk=[...storage.saved.values()].join("");assert.ok(!disk.includes(input.phoneNumber));assert.ok(!disk.includes(ctx.token));assert.ok(!disk.includes(input.remarkName));assert.ok(!disk.includes(input.description));
  const second=createWecomPanelModel({storage,request});await second.refresh(ctx);
  await assert.rejects(second.submit(ctx,{...input,appSlot:"main",requestId:"fixture_new_key_002"}),/原任务/);assert.equal(posts,1);
  await second.submit(ctx,{...input,deviceId:"adb:fixture25",appSlot:"main",requestId:"fixture_other_003"});assert.equal(posts,2);
  tasks=[{jobId:"original",deviceId:input.deviceId,appSlot:"clone",requestId:input.requestId,status:"running"}];await second.refresh(ctx);
  assert.ok(second.snapshot().pending[input.deviceId]);
  tasks[0]={...tasks[0],status:"succeeded",result:{status:"ready_before_send"}};await second.refresh(ctx);
  assert.equal(second.snapshot().pending[input.deviceId],undefined);assert.equal(posts,2);
});

test("a definite rejection permits correction but unknown acceptance never automatically posts again",async()=>{
  let posts=0;const model=createWecomPanelModel({storage:storageFixture(),request:async(c,p,data)=>{
    if(!data)return p.endsWith("devices")?inventory:{tasks:[]};posts++;throw Object.assign(new Error("busy"),{definiteResponse:true});
  }});
  await model.refresh(ctx);await assert.rejects(model.submit(ctx,input),/busy/);
  assert.equal(model.snapshot().pending[input.deviceId],undefined);assert.equal(posts,1);
  await assert.rejects(model.submit(ctx,{...input,appSlot:"auto"}),/已配置/);assert.equal(posts,1);
});

test("late inventory or submission cannot leak into another login or a renewed session",async()=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});
  const model=createWecomPanelModel({storage:storageFixture(),request:async(c,p)=>{await wait;return p.endsWith("devices")?inventory:{tasks:[{jobId:"old-private"}]};}});
  const pending=model.refresh(ctx);model.session({...ctx,token:"new-fixture-token"});release();await pending;
  assert.equal(model.snapshot().loaded,false);assert.deepEqual(model.snapshot().tasks,[]);
  model.session({...ctx,role:"user"});assert.deepEqual(model.snapshot().devices,[]);
  let accept;const accepted=new Promise(resolve=>{accept=resolve;});
  const submitModel=createWecomPanelModel({storage:storageFixture(),request:async(c,p,data)=>data?accepted:p.endsWith("devices")?inventory:{tasks:[]}});
  await submitModel.refresh(ctx);const submit=submitModel.submit(ctx,input);await tick();submitModel.session({...ctx,userId:"different-admin"});
  accept({task:{jobId:"old-private"}});assert.equal(await submit,undefined);assert.deepEqual(submitModel.snapshot().tasks,[]);
});

test("failed freshness or recovery storage prevents any POST",async()=>{
  let offline=false,posts=0;const storage=storageFixture();
  const model=createWecomPanelModel({storage,request:async(c,p,data)=>{if(data){posts++;return{};}if(offline)throw new Error("offline");return p.endsWith("devices")?inventory:{tasks:[]};}});
  await model.refresh(ctx);offline=true;await assert.rejects(model.refresh(ctx),/offline/);
  await assert.rejects(model.submit(ctx,input),/刷新/);assert.equal(posts,0);
  offline=false;await model.refresh(ctx);storage.setItem=()=>{throw new Error("quota");};
  await assert.rejects(model.submit(ctx,input),/本次未提交/);assert.equal(posts,0);
});
