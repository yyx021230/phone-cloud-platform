import { syntheticHostTime } from "./wecom-cleanup-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createWecomCleanupObligation, WECOM_PACKAGES, isWecomCleanupPending, publicWecomCleanupState } from "./wecom-physical-cleanup.mjs";
import { createWecomCleanupService } from "./wecom-cleanup-service.mjs";

export function fixture() {
  let clock = Date.parse("2026-11-02T05:00:00.000Z"), sequence = 0;
  const id = () => `fixture-${++sequence}`;
  const device = { deviceId: "adb:fixture", adb: { serial: "fixture", agentId: "fixture-agent" } };
  const job = { jobId: "original-job", deviceId: device.deviceId, userId: "fixture-owner", wecomAppSlot: "main", wecomAndroidUser: 0, lockId: "original-lock", status: "running", wecomSendClaimAt: "unchanged" };
  const task = { taskId: "original-task", type: "wecom_customer_preview", status: "running", deviceId: device.deviceId,
    adbSerial: "fixture", agentId: "fixture-agent", pickedAt: new Date(clock).toISOString(), payload: { automationJobId: job.jobId } };
  const lock = createWecomCleanupObligation(task, job, device, { now: clock, id });
  task.payload.physicalCleanup = structuredClone(lock.physicalCleanup.binding);
  const state = { devices: [device], automationJobs: [job], windowsTasks: [task], deviceLocks: [lock] };
  const binding = structuredClone(lock.physicalCleanup.binding);
  let rejectSave = false, blocked = false, writes = [];
  const service = createWecomCleanupService({ state, now: () => clock, id,
    conflict: () => blocked, persist: async bundle => { if (rejectSave) throw new Error("fixture_storage_failure"); writes.push(structuredClone(bundle)); } });
  const step = (ms = 100) => { clock += ms; return new Date(clock).toISOString(); };
  const hosts = [{ role: "reader", pid: 123, ...syntheticHostTime(Date.parse(step())), machineId: "a".repeat(64) }];
  const call = (action, body) => service.handle("fixture-agent", lock.lockId, action, body);
  async function ready() {
    await call("host", { binding, hosts });
    task.status = job.status = "failed"; job.result = { previewCode: "preview_cleanup_unconfirmed", cleanupConfirmed: false };
    service.noteTerminal(task, job);
    await call("host-closed", { binding, hosts, observedAt: step(), exited: true, observerMachineId: hosts[0].machineId });
    const reply = await call("verify", { binding });
    const verifyTask = state.windowsTasks.find(t => t.taskId === reply.taskId);
    verifyTask.status = "running"; verifyTask.pickedAt = step(); service.picked(verifyTask);
    return verifyTask;
  }
  function proof() {
    const v = lock.physicalCleanup.verification;
    const snapshots = [1, 2].map(() => ({ observedAt: step(), packagesAbsent: true, packageNames: [...WECOM_PACKAGES], serialForwardCount: 0 }));
    step(); return { binding, verificationId: v.verificationId, verificationNonce: v.verificationNonce, verificationTaskId: v.verificationTaskId, snapshots };
  }
  return { state, lock, job, task, binding, hosts, service, call, ready, proof, step,
    failStorage: value => { rejectSave = value; }, block: value => { blocked = value; }, writes: () => writes };
}

test("business failure and elapsed time retain the physical fence, not another phone", async () => {
  const f = fixture(); f.task.status = f.job.status = "failed"; f.service.noteTerminal(f.task, f.job);
  f.step(1000 * 60 * 60 * 24 * 40);
  assert.equal(f.service.canPick({ deviceId: "adb:fixture", type: "alipay_name_start" }), false);
  assert.equal(f.service.canPick({ deviceId: "adb:other", type: "alipay_name_start" }), true);
  assert.equal(f.service.canPick({ deviceId: "adb:fixture", type: "wecom_customer_preview", payload: { appSlot: "clone" } }), false);
  await assert.rejects(f.call("verify", { binding: f.binding }), /host_unconfirmed/);
});

test("new verification alone releases; business result and send claim are untouched", async () => {
  const f = fixture(); const verification = await f.ready();
  const business = JSON.stringify([f.task, f.job]);
  const proof = f.proof();
  assert.equal(f.service.lease("fixture-agent", f.lock.lockId, proof), true);
  assert.deepEqual(await f.call("proof", proof), { ok: true, verified: true, reused: false });
  assert.equal(f.service.pending("adb:fixture"), null); assert.equal(verification.status, "succeeded");
  assert.equal(JSON.stringify([f.task, f.job]), business);
  assert.equal((await f.call("proof", proof)).reused, true);
  await assert.rejects(f.call("proof", { ...proof, verificationNonce: "other" }), /proof_invalid/);
});

for (const key of ["version", "obligationId", "originalTaskId", "executionId", "deviceId", "serial", "agentId", "appSlot", "androidUser", "nonce"]) {
  test(`wrong ${key} cannot register, close or release`, async () => {
    const f = fixture(); await f.ready(); const before = JSON.stringify(f.state);
    const proof = f.proof(); proof.binding = { ...proof.binding, [key]: "wrong" };
    await assert.rejects(f.call("proof", proof), /binding_mismatch/);
    assert.equal(JSON.stringify(f.state), before);
  });
}

for (const [label, alter] of [
  ["residual forward", p => { p.snapshots[1].serialForwardCount = 1; }],
  ["package present", p => { p.snapshots[0].packagesAbsent = false; }],
  ["missing package", p => { p.snapshots[0].packageNames.pop(); }],
  ["one frame", p => { p.snapshots.pop(); }],
  ["same time", p => { p.snapshots[1].observedAt = p.snapshots[0].observedAt; }],
  ["old generation", p => { p.verificationId = "old"; }],
  ["old nonce", p => { p.verificationNonce = "old"; }],
  ["wrong task", p => { p.verificationTaskId = "original-task"; }],
  ["future", p => { p.snapshots[1].observedAt = "2099-01-01T00:00:00Z"; }],
  ["unknown field", p => { p.cleanupConfirmed = true; }]
]) test(`proof rejects ${label}`, async () => {
  const f = fixture(); await f.ready(); const proof = f.proof(); alter(proof);
  await assert.rejects(f.call("proof", proof), /proof_invalid/); assert.ok(f.service.pending("adb:fixture"));
});

test("stale proof, changed device owner and wrong Agent cannot release", async () => {
  const f = fixture(); await f.ready(); const proof = f.proof(); f.step(3001);
  await assert.rejects(f.call("proof", proof), /proof_invalid/);
  await assert.rejects(f.service.handle("other", f.lock.lockId, "proof", f.proof()), /binding_mismatch/);
  f.state.devices[0].adb.agentId = "other";
  await assert.rejects(f.call("proof", f.proof()), /binding_mismatch/);
});

test("host must be original machine, exact process creation token and real task child", async () => {
  const f = fixture();
  await assert.rejects(f.call("host", { binding: f.binding, hosts: [{ ...f.hosts[0], creationToken: undefined }] }), /host_invalid/);
  await f.call("host", { binding: f.binding, hosts: f.hosts });
  await f.call("host", { binding: f.binding, hosts: f.hosts });
  await assert.rejects(f.call("host", { binding: f.binding, hosts: [{ ...f.hosts[0], creationToken: "0x1.aba0634000000p+30" }] }), /binding_mismatch/);
  await assert.rejects(f.call("host-closed", { binding: f.binding, hosts: f.hosts, observedAt: f.step(), exited: true, observerMachineId: "b".repeat(64) }), /host_unconfirmed/);
});

test("failed persistence restores exact proof state and keeps physical fence", async () => {
  const f = fixture(); await f.ready(); const proof = f.proof(), before = JSON.stringify(f.state);
  f.failStorage(true); await assert.rejects(f.call("proof", proof), /storage_unavailable/);
  assert.equal(JSON.stringify(f.state), before); assert.ok(f.service.pending("adb:fixture"));
  f.failStorage(false); await f.call("proof", proof); assert.equal(f.service.pending("adb:fixture"), null);
});

test("archive and restored JSON retain obligation and allow independently bound late proof", async () => {
  const f = fixture(); await f.ready(); f.state.automationJobs = []; f.state.windowsTasks = f.state.windowsTasks.filter(t => t.type === "wecom_cleanup_verify");
  const restored = JSON.parse(JSON.stringify(f.state));
  assert.ok(isWecomCleanupPending(restored.deviceLocks[0]));
  const service = createWecomCleanupService({ state: restored, now: () => Date.parse("2026-11-02T05:00:01Z"), persist: async () => {} });
  await service.handle("fixture-agent", f.lock.lockId, "proof", f.proof());
  assert.equal(service.pending("adb:fixture"), null);
});

test("expired verify issues fresh generation; late old proof cannot clear it", async () => {
  const f = fixture(); const oldTask = await f.ready(), oldProof = f.proof(); f.step(120001);
  const next = await f.call("verify", { binding: f.binding });
  assert.notEqual(next.taskId, oldTask.taskId); assert.equal(oldTask.status, "expired");
  await assert.rejects(f.call("proof", oldProof), /proof_invalid/);
  assert.ok(f.service.pending("adb:fixture"));
});

test("conflicting phone activity blocks verify, but not another physical phone", async () => {
  const f = fixture(); await f.ready(); f.block(true);
  await assert.rejects(f.call("proof", f.proof()), /device_busy/);
  assert.equal(f.service.canPick({ deviceId: "adb:other", type: "xhs_data_collect" }), true);
});

test("reconcile survives lost verify request, deduplicates, never loops a failed generation", async () => {
  const f = fixture(); await f.call("host", { binding: f.binding, hosts: f.hosts });
  await f.call("host-closed", { binding: f.binding, hosts: f.hosts, observedAt: f.step(), exited: true, observerMachineId: f.hosts[0].machineId });
  assert.equal(await f.service.reconcile("fixture-agent"), null);
  f.task.status = f.job.status = "failed";
  const [a,b] = await Promise.all([f.service.reconcile("fixture-agent"), f.service.reconcile("fixture-agent")]);
  assert.equal(a.taskId,b.taskId); assert.equal(f.state.windowsTasks.filter(t => t.type === "wecom_cleanup_verify").length,1);
  const t = f.state.windowsTasks[0]; t.status = "running"; t.pickedAt = f.step(); f.service.picked(t);
  await f.service.status(t,{status:"failed",result:{errorCode:"fixture_missing_forward_read"}});
  assert.equal(await f.service.reconcile("fixture-agent"),null); assert.ok(f.service.pending(f.task.deviceId));
});

test("proof commits only exact original lock, rolls all three records back, ignores late failure", async () => {
  const f = fixture(); const task = await f.ready();
  const old = { lockId: f.job.lockId,taskId:f.job.jobId,deviceId:f.task.deviceId,lockType:"wecom_customer_preview",status:"active" };
  const unrelated = { ...old, lockId:"other-lock",taskId:"other-job" };
  f.state.deviceLocks.push(old,unrelated); f.failStorage(true);
  await assert.rejects(f.call("proof",f.proof()),/storage_unavailable/);
  assert.equal(old.status,"active"); assert.equal(task.status,"running");
  f.failStorage(false); await f.call("proof",f.proof());
  assert.equal(old.status,"released"); assert.equal(unrelated.status,"active");
  assert.equal(f.writes().at(-1).deviceLocks[0].lockId,old.lockId);
  await f.service.status(task,{status:"failed"}); assert.equal(task.status,"succeeded");
});

test("mismatched original lock cannot release any hold", async () => {
  const f=fixture(); await f.ready();
  f.state.deviceLocks.push({lockId:f.job.lockId,taskId:"another-job",deviceId:f.task.deviceId,lockType:"wecom_customer_preview",status:"active"});
  await assert.rejects(f.call("proof",f.proof()),/original_lock_mismatch/);
  assert.ok(f.service.pending(f.task.deviceId));
});

test("serial-only dispatch stays blocked while release write is unresolved", async () => {
  const f=fixture(); await f.ready(); const proof=f.proof(); let release;
  const service=createWecomCleanupService({state:f.state,now:()=>Date.parse(f.step()),persist:()=>new Promise(r=>{release=r;})});
  const done=service.handle("fixture-agent",f.lock.lockId,"proof",proof);
  await new Promise(r=>setImmediate(r));
  assert.equal(service.canPick({adbSerial:"fixture",type:"xhs_publish"}),false);
  assert.equal(service.canPick({adbSerial:"another",type:"xhs_publish"}),true);
  assert.equal(service.checkpoint(f.state).deviceLocks.find(l=>l.lockId===f.lock.lockId).status,"cleanup_pending","unrelated checkpoint cannot save staged release");
  assert.equal(service.checkpoint(f.state).windowsTasks.find(t=>t.taskId===proof.verificationTaskId).status,"running");
  release(); await done; assert.equal(service.canPick({adbSerial:"fixture",type:"xhs_publish"}),true);
});

test("legacy picked task creates a non-expiring maintenance hold without fabricated identity",()=>{
  const f=fixture(); f.state.deviceLocks=[]; delete f.task.payload.physicalCleanup;
  const hold=f.service.ensureLegacy(f.task,f.job); assert.equal(hold.physicalCleanup.phase,"maintenance");
  assert.equal(hold.physicalCleanup.binding,undefined); assert.equal(hold.expiresAt,"");
  assert.equal(f.service.ensureLegacy(f.task,f.job),hold); assert.equal(f.service.canPick({deviceId:f.task.deviceId}),false);
  assert.equal(f.service.canPick({deviceId:"",adbSerial:"fixture",type:"adb_collect_diagnostics"}),false);
  assert.equal(hold.physicalCleanup.legacySerial,"fixture");
  assert.equal(f.service.canPick({adbSerial:"FIXTURE",type:"adb_collect_diagnostics"}),false);
});


test("picked legacy task without archived business still retains a maintenance fence",()=>{
  const f=fixture(); f.state.deviceLocks=[]; f.state.automationJobs=[];
  const hold=f.service.ensureLegacy(f.task,null);
  assert.equal(hold.physicalCleanup.originalJobId,f.task.payload.automationJobId);
  assert.equal(f.service.canPick({adbSerial:"fixture",type:"adb_collect_diagnostics"}),false);
});


test("terminal missing host evidence is maintenance, not an endlessly automatic stage",async()=>{
  const f=fixture(); assert.equal(publicWecomCleanupState(f.lock).phase,"awaiting_host");
  f.task.status=f.job.status="failed"; f.service.noteTerminal(f.task,f.job);
  assert.deepEqual(publicWecomCleanupState(f.lock),{phase:"maintenance",label:"企微清理待确认 · 需单机维护",reason:"host_evidence_missing"});
  const g=fixture(); await g.call("host",{binding:g.binding,hosts:g.hosts});
  g.task.status=g.job.status="failed"; g.service.noteTerminal(g.task,g.job);
  assert.equal(publicWecomCleanupState(g.lock).reason,"host_close_unconfirmed");
  await g.call("host-closed",{binding:g.binding,hosts:g.hosts,observedAt:g.step(),exited:true,observerMachineId:g.hosts[0].machineId});
  assert.equal(publicWecomCleanupState(g.lock).phase,"awaiting_verification");
});
