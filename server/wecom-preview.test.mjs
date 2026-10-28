import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { WECOM_PREVIEW_DEVICES as pool, previewTarget, previewRequest, previewLease, createPreviewSubmissionGate } from "./wecom-preview.mjs";

test("only eight fixed physical identities and the verified Android users are allowed", () => {
  assert.deepEqual(pool, JSON.parse(fs.readFileSync(new URL("../windows-agent/scripts/wecom_preview_devices.json", import.meta.url), "utf8")));
  assert.equal(Object.keys(pool).length, 8);
  for (const [number, entry] of Object.entries(pool)) {
    assert.equal(previewTarget({ deviceName: number, deviceId: `adb:${entry.serial}`, adb: { serial: entry.serial } }).androidUser, number === "155" ? 999 : 0);
    assert.throws(() => previewTarget({ deviceName: number, deviceId: "adb:OTHER", adb: { serial: "OTHER" } }), /mapping_unconfirmed/);
  }
  assert.throws(() => previewTarget({ deviceName: "67" }), /not_allowed/);
});

test("API rejects all sending flags, arbitrary slots and invalid inputs", () => {
  const input = { deviceId: `adb:${pool["25"].serial}`, phoneNumber: "13800138000", requestId: "request_test_001" };
  assert.deepEqual(previewRequest(input), input);
  assert.equal(previewRequest({ ...input, appSlot: "clone" }).appSlot, "clone");
  for (const appSlot of [null, "", "auto", 999, {}, "app2"]) assert.throws(() => previewRequest({ ...input, appSlot }), /invalid_wecom_app_slot/);
  for (const extra of [{ send: true }, { mode: "send" }, { androidUser: 999 }, { maxRetries: 5 }]) assert.throws(() => previewRequest({ ...input, ...extra }), /invalid_wecom_preview_fields/);
  for (const phoneNumber of ["10086", "138 0013 8000", 13800138000, "11800138000"]) assert.throws(() => previewRequest({ ...input, phoneNumber }), /invalid_phone_number/);
});

test("configured slots bind Android user; an unconfigured clone never falls back to main", () => {
  const device = number => ({ deviceName: number, deviceId: `adb:${pool[number].serial}`, adb: { serial: pool[number].serial } });
  assert.equal(previewTarget(device("155")).appSlot,"clone");
  assert.equal(previewTarget(device("155"),"main").androidUser,0);
  assert.equal(previewTarget(device("155"),"clone").androidUser,999);
  assert.throws(()=>previewTarget(device("25"),"clone"),/slot_not_configured/);
  assert.throws(()=>previewTarget(device("155"),null),/invalid_wecom_app_slot/);
});

test("live lease must agree with task, job, owner, physical phone, clone and lock expiry", () => {
  const device = { deviceName: "155", deviceId: `adb:${pool["155"].serial}`, adb: { serial: pool["155"].serial } };
  const task = { taskId: "task", deviceId: device.deviceId, adbSerial: device.adb.serial, agentId: "agent", type: "wecom_customer_preview", status: "running", payload: { automationJobId: "job", deviceNumber: "155", androidUser: 999 } };
  const job = { jobId: "job", windowsTaskId: "task", kind: task.type, status: "running", deviceId: device.deviceId, wecomDeviceNumber: "155", wecomAndroidUser: 999, userId: "owner", lockId: "lock" };
  const lock = { lockId: "lock", deviceId: device.deviceId, taskId: "job", ownerUserId: "owner", lockType: task.type, status: "active", expiresAt: new Date(Date.now()+60_000).toISOString() };
  const valid = (t=task,j=job,l=lock,d=device,a="agent") => previewLease(t,j,l,d,a);
  assert.equal(valid(), true);
  for (const change of [{ status: "cancelled" }, { agentId: "other" }, { adbSerial: "OTHER" }, { deviceId: "other" }]) assert.equal(valid({ ...task, ...change }), false);
  for (const change of [{ status: "failed" }, { wecomAndroidUser: 0 }, { windowsTaskId: "other" }]) assert.equal(valid(task,{ ...job, ...change }), false);
  for (const change of [{ status: "released" }, { ownerUserId: "other" }, { lockType: "screen_control" }, { expiresAt: new Date(0).toISOString() }]) assert.equal(valid(task,job,{ ...lock, ...change }), false);
  assert.equal(valid(task,job,lock,device,"other"), false);
  const slottedJob={...job,wecomAppSlot:"clone"};
  const slottedTask={...task,payload:{...task.payload,appSlot:"clone"}};
  assert.equal(valid(slottedTask,slottedJob),true);
  assert.equal(valid({...slottedTask,payload:{...slottedTask.payload,appSlot:"main"}},slottedJob),false);
  assert.equal(valid({...slottedTask,payload:{...slottedTask.payload,androidUser:0}},{...slottedJob,wecomAndroidUser:0}),false);
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
    const context=vm.createContext({state:{windowsAgents:[agent],windowsTasks:[task]},
      isWindowsAgentOnline:a=>a.online,nowIso:()=>new Date().toISOString(),newId:()=>"event",
      syncXhsTaskFromWindowsTask:()=>{},syncAutomationJobFromWindowsTask:()=>{},toTime:s=>Date.parse(s),WINDOWS_TASK_TTL_MS:300_000});
    vm.runInContext(fn,context);context.recoverStalledTasks();assert.equal(task.status,"stalled");
    agent.online=true;context.recoverStalledTasks();
    assert.equal(task.status,type==="wecom_customer_preview"?"stalled":"queued");assert.equal(task.taskId,"original");
  }
});
