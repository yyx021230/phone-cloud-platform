import pg from "pg";
import { syntheticHostTime } from "./wecom-cleanup-fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WECOM_PREVIEW_DEVICES } from "./wecom-preview.mjs";
import { WECOM_PACKAGES } from "./wecom-physical-cleanup.mjs";

const pause = ms => new Promise(r => setTimeout(r, ms));
test("actual HTTP: unknown cleanup blocks same phone, survives restart/archive, proof commits before release", { timeout: 45_000 }, async t => {
  const root = process.env.WECOM_CLEANUP_BASELINE_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const databaseUrl = process.env.WECOM_CLEANUP_TEST_DATABASE_URL || "";
  if (databaseUrl) { const u = new URL(databaseUrl); assert.ok(["127.0.0.1", "localhost"].includes(u.hostname) && u.pathname === "/wecom_cleanup_fixture" && !u.password, "isolated credential-free fixture database only"); }
  const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "pc-wecom-cleanup-http-"));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const base = `http://127.0.0.1:${port}`; let server, output = "";
  const stop = async () => { if (server && server.exitCode === null) { server.kill(); await once(server, "exit"); } };
  t.after(async () => { await stop(); await pool?.end(); await fs.rm(data, { recursive: true, force: true }); });
  async function start() {
    server = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: data,
      STORAGE_BACKEND: databaseUrl ? "postgres" : "json", STRUCTURED_WRITES: process.env.WECOM_CLEANUP_TEST_SNAPSHOT_ONLY === "1" ? "false" : "true", STRUCTURED_TABLE_SYNC: process.env.WECOM_CLEANUP_TEST_TABLE_SYNC === "1" ? "true" : "false", DATABASE_URL: databaseUrl, REDIS_URL: "", ADMIN_USERNAME: "fixture_admin",
      ADMIN_PASSWORD: "fixture-only-password", SCREEN_MEDIA_AUTH_SECRET: "fixture-cleanup-secret", PUBLIC_BASE_URL: base,
      WINDOWS_AGENT_ONLINE_SECONDS: "300", MANAGED_NAME_LOOKUP_ENABLED: "false", LOOKUP_AI_VISION_ENABLED: "false"
    }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", c => { output += c; }); server.stderr.on("data", c => { output += c; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/healthz")).ok) return; } catch {}
      if (server.exitCode !== null) throw new Error(output.slice(-1500)); await pause(30);
    }
    throw new Error("fixture_start_failed " + output.slice(-1500));
  }
  async function req(method, route, token, body, expected = 200) {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${json.error || response.status}`); return json;
  }
  const readSnapshot = async () => {
    if (!pool) return JSON.parse(await fs.readFile(path.join(data, "state.json"), "utf8"));
    const value = (await pool.query("select data from phone_cloud_state limit 1")).rows[0].data;
    return typeof value === "string" ? JSON.parse(value) : value;
  };
  await start();
  const admin = (await req("POST", "/api/v1/auth/login", "", { username: "fixture_admin", password: "fixture-only-password" })).session.token;
  const agent = (await req("POST", "/api/v1/windows-agents", admin, { agentId: "fixture-agent", agentName: "Fixture" }, 201)).token;
  const otherAgent = (await req("POST", "/api/v1/windows-agents", admin, { agentId: "other-agent", agentName: "Other" }, 201)).token;
  const serial = WECOM_PREVIEW_DEVICES["155"].serial, otherSerial = WECOM_PREVIEW_DEVICES["59"].serial;
  const deviceId = "adb:" + serial;
  await req("POST", "/api/v1/windows-agents/fixture-agent/devices/sync", agent, {
    agent: { agentId: "fixture-agent" }, devices: [serial, otherSerial].map(adbSerial => ({ adbSerial, state: "device", model: "Fixture" }))
  });
  for (const [phone, number] of [[serial, "155"], [otherSerial, "59"]]) await req("PUT", `/api/v1/devices/${encodeURIComponent("adb:" + phone)}`, admin, { listingStatus: "listed", deviceName: number });
  const route = "/api/v1/user/automation/wecom-preview-tasks";
  const input = { deviceId, appSlot: "main", phoneNumber: "13900000000", requestId: "fixture_original_001" };
  const first = await req("POST", route, admin, input, 201);
  const next = "/api/v1/windows-agents/fixture-agent/tasks/next?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1";
  const task = (await req("GET", next, agent)).task; assert.equal(task.payload.automationJobId, first.task.jobId);
  const binding = task.payload.physicalCleanup;
  if (!binding) {
    // The same fixture executes against the immutable old source to establish
    // the user-visible red case, without weakening the new assertion.
    await req("POST", `/api/v1/windows-agent-tasks/${task.taskId}/status`, agent, { status: "failed", result: { previewStatus: "blocked", previewCode: "preview_cleanup_unconfirmed", diagnostic: { wecomExecution: { cleanupConfirmed: false } } } });
    await req("POST", route, admin, { ...input, requestId: "fixture_after_failure" }, 409);
    assert.fail("baseline lacks persisted obligation");
  }
  const cleanup = `/api/v1/windows-agents/fixture-agent/wecom-cleanup/${binding.obligationId}/`;
  await pause(2);
  const hosts = [{ role: "reader", pid: 123, ...syntheticHostTime(), machineId: "a".repeat(64) }];
  assert.equal((await req("GET", `/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${task.taskId}/lease`, agent)).valid, false, "unregistered host has no phone permission");
  await req("POST", cleanup + "host", agent, { binding, hosts });
  await req("POST", cleanup + "host", agent, { binding, hosts });
  await req("POST", cleanup + "host", otherAgent, { binding, hosts }, 401);
  await req("POST", `/api/v1/windows-agent-tasks/${task.taskId}/status`, agent, { status: "failed", result: { previewStatus: "blocked", previewCode: "preview_cleanup_unconfirmed", diagnostic: { wecomExecution: { cleanupConfirmed: false } } } });
  const failedBusiness = (await req("GET", route + "/" + first.task.jobId, admin)).task;
  const blocked = { ...input, appSlot: "clone", requestId: "fixture_after_failure" };
  assert.equal((await req("POST", route, admin, blocked, 409)).error, "wecom_cleanup_pending");
  await req("POST", cleanup + "verify", agent, { binding }, 409);
  await req("POST", `/api/v1/device-locks/${binding.obligationId}/release`, admin, {}, 409);
  await req("POST", route, admin, { ...input, deviceId: "adb:" + otherSerial, requestId: "fixture_other_phone" }, 201);
  assert.equal((await req("GET", next, agent)).task.deviceId, "adb:" + otherSerial, "unrelated phone still dispatches");
  await pause(2);
  const closed = { binding, hosts, observedAt: new Date().toISOString(), exited: true, observerMachineId: "a".repeat(64) };
  await req("POST", cleanup + "host-closed", agent, { ...closed, observerMachineId: "b".repeat(64) }, 409);
  await req("POST", cleanup + "host-closed", agent, closed);
  await stop();
  // Age ordinary lock/task/job to exercise actual maintenance/retention after
  // a real server process restart; no production or simulated remote state.
  const file = path.join(data, "state.json"), saved = await readSnapshot();
  const old = "2020-01-01T00:00:00.000Z";
  for (const row of saved.deviceLocks.filter(l => l.deviceId === deviceId)) { row.expiresAt = old; row.updatedAt = old; row.createdAt = old; }
  for (const row of [...saved.windowsTasks, ...saved.automationJobs].filter(r => r.deviceId === deviceId)) { row.createdAt = row.updatedAt = row.completedAt = old; }
  if (pool) {
    await pool.query("update phone_cloud_state set data=$1", [JSON.stringify(saved)]);
    for (const row of saved.deviceLocks.filter(l => l.deviceId === deviceId)) await pool.query("update phone_cloud_device_locks set expires_at=$1,data=$2 where lock_id=$3", [old,JSON.stringify(row),row.lockId]);
    for (const row of saved.windowsTasks.filter(t => t.deviceId === deviceId)) await pool.query("update phone_cloud_windows_tasks set updated_at=$1,data=$2 where task_id=$3", [old,JSON.stringify(row),row.taskId]);
    for (const row of saved.automationJobs.filter(j => j.deviceId === deviceId)) await pool.query("update phone_cloud_automation_jobs set updated_at=$1,data=$2 where job_id=$3", [old,JSON.stringify(row),row.jobId]);
  } else await fs.writeFile(file, JSON.stringify(saved));
  await start();
  await req("GET", "/api/v1/device-locks", admin);
  await req("POST", "/api/v1/maintenance/prune", admin, { dryRun: false });
  assert.equal((await req("POST", route, admin, blocked, 409)).error, "wecom_cleanup_pending");
  const disk = await readSnapshot();
  assert.ok(disk.deviceLocks.some(l => l.lockId === binding.obligationId && l.status === "cleanup_pending"));
  assert.ok(!disk.automationJobs.some(j => j.jobId === first.task.jobId), "actual prune archived original job");
  const verifyTask = (await req("GET", next, agent)).task; // restart poll repairs the lost explicit verify request
  const requested = await req("POST", cleanup + "verify", agent, { binding });
  assert.equal((await req("POST", cleanup + "verify", agent, { binding })).taskId, requested.taskId);
  assert.equal(verifyTask.type, "wecom_cleanup_verify"); assert.equal(verifyTask.taskId, requested.taskId);
  const v = verifyTask.payload;
  const fields = { verificationId: v.verificationId, verificationNonce: v.verificationNonce, verificationTaskId: verifyTask.taskId };
  const leaseRoute = cleanup + "lease?" + new URLSearchParams(fields);
  assert.equal((await req("GET", leaseRoute, agent)).valid, true);
  async function freshProof() {
    const snapshots = [];
    for (let i = 0; i < 2; i++) { await pause(3); snapshots.push({ observedAt: new Date().toISOString(), packagesAbsent: true, packageNames: [...WECOM_PACKAGES], serialForwardCount: 0 }); }
    return { binding, ...fields, snapshots };
  }
  const wrong = await freshProof(); wrong.snapshots[1].serialForwardCount = 1;
  await req("POST", cleanup + "proof", agent, wrong, 409);
  await req("POST", `/api/v1/windows-agent-tasks/${verifyTask.taskId}/status`, agent, { status: "succeeded", result: { cleanupConfirmed: true } }, 409);
  // Real filesystem persistence failure, not just a mocked writer. Keep a copy
  // of this isolated server's state and restore it before the retry.
  if (pool) await pool.query(`create function fixture_reject_release() returns trigger language plpgsql as $$ begin
    if NEW.data->>'lockType' = 'wecom_physical_cleanup' and NEW.status = 'released' then raise exception 'fixture_rejected'; end if; return NEW; end $$;
    create trigger fixture_release_failure before insert or update on phone_cloud_device_locks for each row execute function fixture_reject_release()`);
  else { await fs.rename(file, file + ".before-failure"); await fs.mkdir(file); }
  try { await req("POST", cleanup + "proof", agent, await freshProof(), 503); }
  finally {
    if (pool) await pool.query("drop trigger fixture_release_failure on phone_cloud_device_locks; drop function fixture_reject_release()");
    else { await fs.rm(file, { recursive: true, force: true }); await fs.rename(file + ".before-failure", file); }
  }
  if (pool) {
    assert.equal((await pool.query("select data->>'status' as status from phone_cloud_windows_tasks where task_id=$1",[verifyTask.taskId])).rows[0].status,"running","Postgres rolled back task before failed lock release");
    assert.equal((await pool.query("select status from phone_cloud_device_locks where lock_id=$1",[binding.obligationId])).rows[0].status,"cleanup_pending");
  }
  assert.equal((await req("GET", leaseRoute, agent)).valid, true, "rollback kept verification running");
  assert.equal((await req("POST", route, admin, blocked, 409)).error, "wecom_cleanup_pending");
  const proof = await freshProof(); assert.equal((await req("POST", cleanup + "proof", agent, proof)).verified, true);
  assert.equal((await req("POST", cleanup + "proof", agent, proof)).reused, true);
  await req("POST", `/api/v1/windows-agent-tasks/${verifyTask.taskId}/status`, agent, { status: "failed", result: { errorCode: "late_response_loss" } });
  assert.equal((await req("GET", `/api/v1/windows-agent-tasks/${verifyTask.taskId}`, admin)).task.status,"succeeded");
  await req("POST", route, admin, blocked, 201);
  assert.equal(failedBusiness.status, "failed");
  const end = await readSnapshot();
  const verified = pool ? (await pool.query("select data from phone_cloud_device_locks where lock_id=$1",[binding.obligationId])).rows[0].data : end.deviceLocks.find(l => l.lockId === binding.obligationId);
  assert.equal(verified.status, "released"); assert.equal(verified.releaseReason, "wecom_physical_verified");
  assert.ok(!end.automationJobs.some(j => j.jobId === first.task.jobId), "proof did not resurrect archived business");
  if (pool) assert.equal((await pool.query("select data->>'status' as status from phone_cloud_automation_jobs where job_id=$1",[first.task.jobId])).rows[0].status,"failed");
  // A real restart of a pre-protocol in-flight fixture must conservatively
  // persist maintenance, even with structured snapshot dual-write disabled.
  const legacyTask = (await req("GET", next, agent)).task;
  assert.equal(legacyTask.type, "wecom_customer_preview");
  await stop(); const legacyState = await readSnapshot();
  const legacyRow = legacyState.windowsTasks.find(t => t.taskId === legacyTask.taskId);
  const obsoleteHoldId = legacyRow.payload.physicalCleanup.obligationId;
  delete legacyRow.payload.physicalCleanup;
  legacyState.deviceLocks = legacyState.deviceLocks.filter(l => l.lockId !== obsoleteHoldId);
  const legacyJob = legacyState.automationJobs.find(j => j.jobId === legacyRow.payload.automationJobId);
  legacyJob.createdAt = legacyJob.updatedAt = old;
  if (pool) {
    await pool.query("delete from phone_cloud_device_locks where lock_id=$1", [obsoleteHoldId]);
    await pool.query("update phone_cloud_windows_tasks set data=$1 where task_id=$2", [JSON.stringify(legacyRow), legacyRow.taskId]);
    await pool.query("update phone_cloud_automation_jobs set updated_at=$1,data=$2 where job_id=$3", [old,JSON.stringify(legacyJob),legacyJob.jobId]);
    await pool.query("update phone_cloud_state set data=$1", [JSON.stringify(legacyState)]);
  } else await fs.writeFile(file, JSON.stringify(legacyState));
  await start();
  const maintenance = (await req("GET", "/api/v1/device-locks", admin)).locks.find(l => l.deviceId === deviceId && l.cleanup?.phase === "maintenance");
  assert.ok(maintenance, "old picked task has durable maintenance hold before HTTP opens");
  if (pool) assert.equal((await pool.query("select status from phone_cloud_device_locks where lock_id=$1", [maintenance.lockId])).rows[0].status,"cleanup_pending");
  await req("GET", "/api/v1/user/automation/xhs-data-tasks/fixture_missing", admin, undefined, 404); // runs actual expiry reducer
  assert.equal((await req("GET", route + "/" + legacyJob.jobId, admin)).task.status,"expired");
  await stop(); await start();
  assert.equal((await req("POST", route, admin, { ...input, requestId:"fixture_after_legacy_expiry" },409)).error,"wecom_cleanup_pending");
  if (pool) {
    const persisted = (await pool.query("select data from phone_cloud_device_locks where lock_id=$1", [maintenance.lockId])).rows[0].data;
    assert.equal(persisted.physicalCleanup.phase,"maintenance"); assert.equal(persisted.physicalCleanup.binding,undefined);
    assert.equal(persisted.physicalCleanup.legacySerial,serial);
  }
  t.diagnostic(databaseUrl ? "actual isolated PostgreSQL: HTTP + process restart + archive + transaction rollback" : "actual JSON HTTP + process restart + archive + filesystem rollback");
});
