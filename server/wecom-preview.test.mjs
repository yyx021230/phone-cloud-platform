import { pendingWecomCleanup } from "./wecom-physical-cleanup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import {isManagedLookupTask} from "./managed-lookup-delivery.mjs";
import { WECOM_PREVIEW_DEVICES as pool, previewTarget, previewRequest, previewLease, previewRemarkInput, previewRemarkFingerprint, createPreviewSubmissionGate, invitationRequest, publicInvitation, publicWecomDevice } from "./wecom-preview.mjs";

test("only eight fixed physical identities and the verified Android users are allowed", () => {
  assert.deepEqual(pool, JSON.parse(fs.readFileSync(new URL("../windows-agent/scripts/wecom_preview_devices.json", import.meta.url), "utf8")));
  assert.equal(Object.keys(pool).length, 8);
  for (const [number, entry] of Object.entries(pool)) {
    assert.equal(previewTarget({ deviceName: number, deviceId: `adb:${entry.serial}`, adb: { serial: entry.serial } }).androidUser, number === "155" ? 999 : 0);
    assert.throws(() => previewTarget({ deviceName: number, deviceId: "adb:OTHER", adb: { serial: "OTHER" } }), /mapping_unconfirmed/);
  }
  assert.throws(() => previewTarget({ deviceName: "67" }), /not_allowed/);
});

test("API requires explicit known execution mode and rejects arbitrary flags or slots", () => {
  const input = { deviceId: `adb:${pool["25"].serial}`, phoneNumber: "13800138000", requestId: "request_test_001" };
  assert.deepEqual(previewRequest(input), {...input,remarkName:"测试客户",description:"接口联调测试"});
  assert.equal(previewRequest({ ...input, appSlot: "clone" }).appSlot, "clone");
  assert.equal(previewRequest({...input,mode:"send"}).mode,"send");
  for (const mode of [null, "", "auto", true]) assert.throws(()=>previewRequest({...input,mode}),/invalid_wecom_mode/);
  for (const appSlot of [null, "", "auto", 999, {}, "app2"]) assert.throws(() => previewRequest({ ...input, appSlot }), /invalid_wecom_app_slot/);
  for (const extra of [{ send: true }, { androidUser: 999 }, { maxRetries: 5 }]) assert.throws(() => previewRequest({ ...input, ...extra }), /invalid_wecom_preview_fields/);
  for (const phoneNumber of ["10086", "138 0013 8000", 13800138000, "11800138000"]) assert.throws(() => previewRequest({ ...input, phoneNumber }), /invalid_phone_number/);
});

test("custom remarks normalize blanks and newlines; bounds and controls fail before submission",()=>{
  assert.deepEqual(previewRemarkInput({remarkName:" \ufeff ",description:"\n "}),{remarkName:"测试客户",description:"接口联调测试"});
  assert.deepEqual(previewRemarkInput({remarkName:" 客户甲😀 ",description:"渠道A\r\n联调"}),{remarkName:"客户甲😀",description:"渠道A\n联调"});
  assert.equal(previewRemarkInput({remarkName:"😀".repeat(20)}).remarkName.length,40);
  for(const value of [null,42,{},"字".repeat(21),"甲\n乙","甲\u0000乙","\ud800"])assert.throws(()=>previewRemarkInput({remarkName:value}),/invalid_wecom_remarkName/);
  for(const value of [null,{},"字".repeat(121),"甲\u0001乙","\ud800"])assert.throws(()=>previewRemarkInput({description:value}),/invalid_wecom_description/);
});

test("configured slots bind Android user; an unconfigured clone never falls back to main", () => {
  const device = number => ({ deviceName: number, deviceId: `adb:${pool[number].serial}`, adb: { serial: pool[number].serial } });
  assert.equal(previewTarget(device("155")).appSlot,"clone");
  assert.equal(previewTarget(device("155"),"main").androidUser,0);
  assert.equal(previewTarget(device("155"),"clone").androidUser,999);
  assert.throws(()=>previewTarget(device("25"),"clone"),/slot_not_configured/);
  assert.throws(()=>previewTarget(device("155"),null),/invalid_wecom_app_slot/);
});

test("live lease must agree with task, job, owner, physical phone, clone and original monotonic remaining budget", () => {
  const device = { deviceName: "155", deviceId: `adb:${pool["155"].serial}`, adb: { serial: pool["155"].serial, agentId: "agent" } };
  const task = { taskId: "task", deviceId: device.deviceId, adbSerial: device.adb.serial, agentId: "agent", type: "wecom_customer_preview", status: "running", payload: { automationJobId: "job", deviceNumber: "155", androidUser: 999 } };
  const job = { jobId: "job", windowsTaskId: "task", kind: task.type, status: "running", deviceId: device.deviceId, wecomDeviceNumber: "155", wecomAndroidUser: 999, userId: "owner", lockId: "lock" };
  const lock = { lockId: "lock", deviceId: device.deviceId, taskId: "job", ownerUserId: "owner", lockType: task.type, status: "active", expiresAt: new Date(Date.now()+60_000).toISOString() };
  const valid = (t=task,j=job,l=lock,d=device,a="agent") => previewLease(t,j,l,d,a,Date.now(),60000);
  assert.equal(valid(), true);
  for(const remaining of [null,0,3000,3000.5,NaN]) assert.equal(previewLease(task,job,lock,device,"agent",Date.now(),remaining),false);
  assert.equal(previewLease(task,job,{...lock,expiresAt:new Date(0).toISOString()},device,"agent",Date.now()+86400000,60000),true,"audit wall expiry cannot override the original monotonic budget");
  assert.equal(valid({...task,payload:{...task.payload,phoneNumber:"13800138000"}}, {...job,phoneNumber:"13900139000"}),false,"lease binds the complete target phone");
  for (const change of [{ status: "cancelled" }, { agentId: "other" }, { adbSerial: "OTHER" }, { deviceId: "other" }]) assert.equal(valid({ ...task, ...change }), false);
  for (const change of [{ status: "failed" }, { wecomAndroidUser: 0 }, { windowsTaskId: "other" }]) assert.equal(valid(task,{ ...job, ...change }), false);
  for (const change of [{ status: "released" }, { ownerUserId: "other" }, { lockType: "screen_control" }]) assert.equal(valid(task,job,{ ...lock, ...change }), false);
  assert.equal(valid(task,job,lock,device,"other"), false);
  const slottedJob={...job,wecomAppSlot:"clone"};
  const slottedTask={...task,payload:{...task.payload,appSlot:"clone"}};
  assert.equal(valid(slottedTask,slottedJob),true);
  assert.equal(valid({...slottedTask,payload:{...slottedTask.payload,appSlot:"main"}},slottedJob),false);
  assert.equal(valid({...slottedTask,payload:{...slottedTask.payload,androidUser:0}},{...slottedJob,wecomAndroidUser:0}),false);
  const customJob={...slottedJob,wecomRemarkName:"客户甲😀",wecomDescription:"渠道A\n联调"};
  const customTask={...slottedTask,payload:{...slottedTask.payload,remarkName:"客户甲😀",description:"渠道A\n联调"}};
  assert.equal(valid(customTask,customJob),true);
  assert.equal(valid({...customTask,payload:{...customTask.payload,remarkName:"另一个备注"}},customJob),false);
  assert.equal(valid(slottedTask,customJob),false,"dropping custom values cannot fall back to defaults");
  assert.match(previewRemarkFingerprint(customJob),/^[a-f0-9]{64}$/);
});

test("duplicate submission waits for persistence; a blocked phone does not block another key", async () => {
  const gate = createPreviewSubmissionGate(); let release; let committed=false; let created=0;
  const wait = new Promise(resolve => { release=resolve; });
  const create = () => gate("same", async () => { if (committed) return "original"; created++; await wait; committed=true; return "original"; });
  const first=create(); const duplicate=create();
  assert.equal(await gate("another_phone", () => "independent"), "independent");
  release(); assert.deepEqual(await Promise.all([first,duplicate]), ["original","original"]); assert.equal(created,1);
});

test("actual offline recovery never requeues a preview with uncertain UI writes; other kinds retain their policy", () => {
  const source=fs.readFileSync(new URL("./index.mjs",import.meta.url),"utf8");
  const start=source.indexOf("function recoverStalledTasks(");
  const fn=source.slice(start,source.indexOf("\n}\n",start)+2);
  for (const type of ["wecom_customer_preview","xhs_qr_appium"]) {
    const task={type,taskId:"original",agentId:"agent",status:"running",events:[]};
    const agent={agentId:"agent",online:false};
    const context=vm.createContext({isManagedLookupTask,state:{windowsAgents:[agent],windowsTasks:[task]},
      isWindowsAgentOnline:a=>a.online,nowIso:()=>new Date().toISOString(),newId:()=>"event",
      syncXhsTaskFromWindowsTask:()=>{},syncAutomationJobFromWindowsTask:()=>{},toTime:s=>Date.parse(s),WINDOWS_TASK_TTL_MS:300_000});
    vm.runInContext(fn,context);context.recoverStalledTasks();assert.equal(task.status,"stalled");
    agent.online=true;context.recoverStalledTasks();
    assert.equal(task.status,type==="wecom_customer_preview"?"stalled":"queued");assert.equal(task.taskId,"original");
  }
});


test("integration facade accepts four business fields and resolves public number without trusting an ADB serial",()=>{
  const devices=Object.entries(pool).map(([deviceName,d])=>({deviceName,deviceId:"adb:"+d.serial,adb:{serial:d.serial}}));
  const input={deviceNumber:"59",appSlot:"main",phoneNumber:"13800138000",remarkName:"yyx（坦克）"};
  const options={requestId:"fixture_auto_request"};
  const normalized=invitationRequest(input,devices,options);
  assert.equal(normalized.deviceId,"adb:"+pool['59'].serial);assert.equal(normalized.mode,"send");
  assert.equal(normalized.requestId,options.requestId);assert.equal(normalized.remarkName,input.remarkName);
  assert.equal(invitationRequest({...input,deviceNumber:59,appSlot:undefined},devices,options).appSlot,"main");
  assert.throws(()=>invitationRequest({...input,deviceNumber:'155',appSlot:undefined},devices,options),/app_slot_required/);
  for(const appSlot of ['main','clone']) assert.equal(invitationRequest({...input,deviceNumber:'155',appSlot},devices,options).appSlot,appSlot);
  for(const extra of [{mode:'preview'},{requestId:'caller_body_key'},{description:'extra'},{deviceId:'adb:other'}]) assert.throws(()=>invitationRequest({...input,...extra},devices,options),/invalid_wecom_invitation_fields/);
  assert.throws(()=>invitationRequest(input,[...devices,devices.find(d=>d.deviceName==='59')],options),/not_unique/);
});

test("integration status never turns a native click or unknown persistence into confirmed customer delivery",()=>{
  for(const status of ['queued','running']) assert.equal(publicInvitation({jobId:'fixture',status,result:{sendStatus:'unknown'}}).status,status);
  for(const task of [{status:'succeeded',result:{status:'send_attempted',sendStatus:'unknown'}},{status:'stalled',result:{}},{status:'failed',result:{remarkSaveStatus:'unknown'}}]) assert.equal(publicInvitation({jobId:'fixture',...task}).status,'unknown');
  assert.equal(publicInvitation({jobId:'fixture',status:'failed',result:{code:'login_required'}}).status,'needs_attention');
});


test("integration inventory separates online/busy/WeCom eligibility and never exposes private device data",()=>{
  const device={deviceName:'155',deviceId:'adb:'+pool['155'].serial,adb:{serial:pool['155'].serial,agentId:'private-agent'},sims:[{phoneNumber:'13800138000'}],token:'private-token'};
  const live={online:true,adbOnline:true,agentOnline:true,listed:true};
  const row=publicWecomDevice(device,live);
  assert.equal(row.available,true);assert.equal(row.busy,false);assert.equal(row.wecomAllowed,true);
  assert.deepEqual(row.appSlots.map(s=>s.appSlot),['main','clone']);assert.equal(row.deviceNumber,'155');
  const busy=publicWecomDevice(device,{...live,occupancy:{kind:'screen_control',label:'实时控制',ownerLabel:'private-user',taskId:'private-task'}});
  assert.equal(busy.online,true);assert.equal(busy.available,false);assert.equal(busy.busyReason,'实时控制');
  assert.deepEqual(busy.occupancy,{type:'screen_control',label:'实时控制'});
  const output=JSON.stringify(busy);for(const text of [pool['155'].serial,'private-agent','13800138000','private-token','private-user','private-task'])assert.ok(!output.includes(text));
  assert.equal(publicWecomDevice(device,{...live,adbOnline:false}).unavailableReason,'adb_offline');
  assert.equal(publicWecomDevice(device,{...live,agentOnline:false}).unavailableReason,'agent_offline');
  assert.equal(publicWecomDevice(device,{...live,listed:false}).available,false);
  const duplicate=publicWecomDevice(device,{...live,mappingCount:2});assert.equal(duplicate.wecomAllowed,false);assert.equal(duplicate.unavailableReason,'device_number_conflict');
  const wrong=publicWecomDevice({...device,deviceName:'67'},live);assert.equal(wrong.online,true);assert.equal(wrong.available,false);assert.equal(wrong.unavailableReason,'wecom_not_configured');
  assert.equal(publicWecomDevice({...device,adb:{serial:'wrong'}},live).wecomAllowed,false);
  assert.equal(publicWecomDevice(device,{...live,occupancy:{kind:'wecom_customer_preview'}}).busyReason,'企微加客户');
});


test("integration occupancy reads do not expire locks or invoke device recovery",()=>{
  const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function deviceOccupancyForViewer('),end=source.indexOf('\nfunction addAudit(',start);
  const expired={deviceId:'fixture',status:'active',expiresAt:new Date(0).toISOString()};
  const valid={deviceId:'fixture',status:'active',expiresAt:new Date(Date.now()+60000).toISOString(),lockType:'wecom_customer_preview'};
  const state={deviceLocks:[expired,valid],smsOrders:[],users:[],automationSessions:[],automationJobs:[]};const before=JSON.stringify(state);
  const context=vm.createContext({state,pendingWecomCleanup,managedLookup:null,managedLookupReservationLock:()=>null,
    screenSessions:{activeForDevice:()=>null},activeXhsTaskForDevice:()=>null,buildDeviceOccupancy:({lock})=>lock,
    activeDeviceLockForTask:()=>{throw new Error('expiry_mutator_must_not_run');}});
  vm.runInContext(source.slice(start,end),context);
  assert.equal(context.deviceOccupancyForViewer({deviceId:'fixture'},null,{readOnly:true}),expired,'read-only view conservatively retains active locks until normal maintenance releases them');
  assert.equal(context.deviceOccupancyForViewer({deviceId:'other'},null,{readOnly:true}),null);
  assert.equal(JSON.stringify(state),before);
  assert.throws(()=>context.deviceOccupancyForViewer({deviceId:'fixture'}),/expiry_mutator/,'normal callers retain their existing expiry path');
});
