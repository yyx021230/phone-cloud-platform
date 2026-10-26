import test from "node:test";
import assert from "node:assert/strict";
import { BatchEngine, validateClients } from "./engine.mjs";
import { memoryStore } from "./fixtures.mjs";

function fixture(count = 8) {
  let now = Date.parse("2026-10-26T02:00:00+08:00");
  const targets = Array.from({ length: count }, (_, i) => ({ deviceId: `d${Math.floor(i / 2)}`, appSlot: i % 2 ? "app2" : "app1", xhsId: `x${i}`, accountName: `Name${i}` }));
  const clients = validateClients([{ clientId: "test", username: "fixture", password: "fixture", secret: "s".repeat(32), targets }]);
  const devices = [...new Set(targets.map(t => t.deviceId))].map(deviceId => ({ deviceId, adbOnline: true, xhsDataCollectionReady: true,
    xhsAccounts: targets.filter(t => t.deviceId === deviceId) }));
  const jobs = new Map(), posts = [];
  const platform = { devices: async () => structuredClone(devices), job: async id => structuredClone(jobs.get(id)), submit: async item => {
    posts.push(item.deviceId); const job = { jobId: `j${posts.length}`, kind: "xhs_data_collect", deviceId: item.deviceId,
      xhsAppSlot: item.appSlot, xhsAccountId: item.xhsId, xhsAccountName: item.accountName,
      accountIdentitySource: "platform_binding_snapshot", status: "running", createdAt: new Date(now).toISOString() };
    jobs.set(job.jobId, job); return job;
  } };
  const store = memoryStore(), platforms = new Map([["test", platform]]);
  const makeEngine = () => new BatchEngine({ store, clients, platforms, clock: () => now });
  const finish = () => { for (const job of jobs.values()) Object.assign(job, { status: "succeeded", result: { collection: {
    schema_version: 3, window_days: 30, window_start_date: "2026-09-27", window_end_date: "2026-10-26",
    app_slot: job.xhsAppSlot, complete: true, stop_reason: "list_end_visible", notes: []
  } } }); };
  return { engine: makeEngine(), makeEngine, store, clients, platform, platforms, devices, jobs, posts, finish, advance: ms => { now += ms; } };
}

test("five physical phones maximum, two slots serial, complete zero is real data", async () => {
  const f = fixture(14), run = await f.engine.create("test", "manual-001");
  await Promise.all([f.engine.tick(), f.engine.tick()]);
  assert.equal(f.posts.length, 5); assert.equal(new Set(f.posts).size, 5);
  f.finish(); await f.engine.tick(); assert.equal(f.posts.length, 10);
  f.finish(); await f.engine.tick(); f.finish(); await f.engine.tick(); f.finish(); await f.engine.tick();
  const result = await f.engine.results("test", run.runId, 0, 20);
  assert.equal(result.counts.succeeded, 14); assert.equal(result.complete, true);
  assert.deepEqual(result.items[0].data.notes, []); assert.equal(result.items[0].data.totals.list_view_count, 0);
  assert.equal(result.items[0].xhsId, "x0");
});

test("busy phone waits, then dispatches when idle; deadline skips without a POST", async () => {
  const f = fixture(2); f.devices[0].busy = true;
  await f.engine.create("test", "manual-001"); await f.engine.tick(); assert.equal(f.posts.length, 0);
  f.devices[0].busy = false; await f.engine.tick(); assert.equal(f.posts.length, 1);
  f.finish(); f.advance(5 * 3600_000); await f.engine.tick();
  const [run] = await f.store.runs(); assert.equal(run.items[1].status, "skipped"); assert.equal(f.posts.length, 1);
});

test("only exact bound slot/ID is dispatched; offline and changed bindings are skipped", async () => {
  const f = fixture(6);
  f.devices[0].xhsAccounts[0].xhsId = "changed";
  f.devices[1].xhsAccounts = []; f.devices[2].adbOnline = false;
  const run = await f.engine.create("test", "manual-001"); await f.engine.tick();
  const result = await f.engine.results("test", run.runId);
  assert.equal(f.posts.length, 1); assert.equal(result.items[0].reason, "binding_changed_or_missing");
  assert.equal(result.items[4].reason, "device_offline");
});

test("unknown POST never replayed after restart and blocks the other slot and next batch", async () => {
  const f = fixture(2); let calls = 0;
  f.platform.submit = async () => { calls++; throw new Error("network reset after server accepted"); };
  const run = await f.engine.create("test", "manual-001"); await f.engine.tick();
  f.engine = f.makeEngine(); await f.engine.tick(); f.advance(5 * 3600_000); await f.engine.tick();
  assert.equal(calls, 1); assert.equal((await f.engine.results("test", run.runId)).status, "needs_attention");
  await assert.rejects(f.engine.create("test", "manual-002"), /batch_already_active/);
  assert.equal((await f.engine.create("test", "manual-001")).runId, run.runId);
});

test("persisted submit intent with missing reply is recovered as unknown, not a new task", async () => {
  const f = fixture(2), run = await f.engine.create("test", "manual-001");
  const saved = await f.store.get(`run/${run.runId}`); saved.items[0].status = "submitting";
  await f.store.set(`run/${run.runId}`, saved); await f.makeEngine().tick();
  assert.equal(f.posts.length, 0); assert.equal((await f.engine.results("test", run.runId)).items[0].status, "unknown");
});

test("failed intent durability prevents dispatch; engine fails closed", async () => {
  const f = fixture(2); await f.engine.create("test", "manual-001");
  const set = f.store.set;
  f.store.set = async (k, v) => { if (v.items?.some(i => i.status === "submitting")) throw new Error("disk unavailable"); return set(k, v); };
  await assert.rejects(f.engine.tick(), /disk unavailable/); assert.equal(f.posts.length, 0);
  await assert.rejects(f.engine.tick(), /restart_required/);
});

test("Shanghai schedule disabled by default, once/day across restart, no backfill outside window", async () => {
  const f = fixture(2); await f.engine.tick(); assert.equal((await f.store.runs()).length, 0);
  await f.engine.configure("test", { enabled: true, time: "02:00", windowMinutes: 60, concurrency: 1 });
  await f.engine.tick(); await f.makeEngine().tick(); assert.equal((await f.store.runs()).length, 1);
  f.finish(); await f.engine.tick(); f.finish(); await f.engine.tick();
  f.advance(25 * 3600_000); await f.engine.tick(); assert.equal((await f.store.runs()).length, 1);
  f.advance(23 * 3600_000); await f.engine.tick(); assert.equal((await f.store.runs()).length, 2);
});

test("partial data stays failed, wrong account data is never returned", async () => {
  const f = fixture(4), run = await f.engine.create("test", "manual-001"); await f.engine.tick(); f.finish();
  f.jobs.get("j1").result.collection.complete = false;
  f.jobs.get("j2").xhsAccountId = "different";
  await f.engine.tick(); const result = await f.engine.results("test", run.runId);
  assert.equal(result.items[0].status, "failed"); assert.equal(result.items[0].data.complete, false);
  assert.equal(result.items[2].reason, "job_identity_mismatch"); assert.equal(result.items[2].data, null);
  assert.equal(result.items[2].status, "unknown"); assert.equal(f.posts.filter(d => d === "d1").length, 1);
});

test("known-job polling outage never frees concurrency or resubmits", async () => {
  const f = fixture(2); await f.engine.create("test", "manual-001"); await f.engine.tick();
  f.platform.job = async () => { throw new Error("read outage"); };
  f.advance(3600_000); await f.engine.tick(); await f.makeEngine().tick(); assert.equal(f.posts.length, 1);
});

test("busy 409 is safe to retry; 500 outcome stays unknown", async () => {
  const f = fixture(2); let calls = 0;
  f.platform.submit = async () => { calls++; throw Object.assign(new Error(calls === 1 ? "device_busy" : "internal_error"), { status: calls === 1 ? 409 : 500 }); };
  const run = await f.engine.create("test", "manual-001"); await f.engine.tick(); await f.engine.tick();
  const result = await f.engine.results("test", run.runId); assert.equal(calls, 2); assert.equal(result.status, "needs_attention");
});

test("unknown outcome can only attach an existing job with exact account/slot/time", async () => {
  const f = fixture(2), original = f.platform.submit;
  f.platform.submit = async i => { await original(i); throw new Error("lost response"); };
  const run = await f.engine.create("test", "manual-001"); await f.engine.tick();
  await assert.rejects(f.engine.reconcile("test", run.runId, "0", "wrong"), /identity_mismatch/);
  await f.engine.reconcile("test", run.runId, "0", "j1"); f.finish(); await f.engine.tick();
  assert.equal((await f.engine.results("test", run.runId)).items[0].status, "succeeded");
});

test("client isolation, limits, duplicate account config and removed allowlist", async () => {
  const f = fixture(2), run = await f.engine.create("test", "manual-001");
  await assert.rejects(f.engine.results("other", run.runId), /not_found/);
  await assert.rejects(f.engine.results("test", run.runId, 0, 1000), /pagination/);
  await assert.rejects(f.engine.configure("test", { enabled: true, time: "25:00", concurrency: 6, windowMinutes: 60 }), /schedule/);
  assert.throws(() => validateClients([f.clients[0], f.clients[0]]), /invalid_batch_client/);
  f.clients[0].targets = []; await f.engine.tick(); assert.equal(f.posts.length, 0);
});

test("stop prevents remaining dispatch and retains an in-flight task until its actual terminal", async () => {
  const f = fixture(2), run = await f.engine.create("test", "manual-001"); await f.engine.tick();
  await f.engine.stop("test", run.runId); await f.engine.tick(); assert.equal(f.posts.length, 1);
  f.finish(); await f.engine.tick();
  const result = await f.engine.results("test", run.runId);
  assert.equal(result.status, "completed"); assert.equal(result.items[1].reason, "batch_stopped");
});
