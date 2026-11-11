import assert from "node:assert/strict";
import test from "node:test";

import { applyStructuredOverlay, createPostgresRepositories } from "./postgres-repositories.mjs";

test("persists an SMS batch with conflict-safe insert and canonical update statements", async () => {
  const database = fakeDatabase();
  const repos = createPostgresRepositories({ getPool: async () => database.pool });

  await repos.persistSmsBatch({
    device: { deviceId: "device-1", updatedAt: "2026-07-17T00:00:00.000Z" },
    messages: [
      { messageId: "sms-1", messageKey: "sms:1", deviceId: "device-1", messageAt: "2026-07-17T00:00:00.000Z" },
      { messageId: "sms-2", messageKey: "sms:2", deviceId: "device-1", messageAt: "2026-07-17T00:00:01.000Z" }
    ],
    audit: { auditId: "audit-1", createdAt: "2026-07-17T00:00:02.000Z" }
  });

  assert.equal(database.calls[0].sql, "begin");
  assert.match(database.calls[1].sql, /insert into phone_cloud_devices/);
  assert.match(database.calls[2].sql, /jsonb_to_recordset/);
  const rows = JSON.parse(database.calls[2].params[0]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.message_key), ["sms:1", "sms:2"]);
  assert.match(database.calls[2].sql, /on conflict do nothing/);
  assert.match(database.calls[3].sql, /with incoming as/);
  assert.match(database.calls[3].sql, /target\.message_id = incoming\.message_id/);
  assert.match(database.calls[3].sql, /target\.device_id = incoming\.device_id/);
  assert.match(database.calls[3].sql, /conflict\.message_id <> target\.message_id/);
  assert.match(database.calls[3].sql, /matched\.canonical_message_id/);
  assert.match(database.calls[4].sql, /insert into phone_cloud_audit_events/);
  assert.equal(database.calls[5].sql, "commit");
  assert.equal(database.released, 1);
});

test("persists a device edit and its audit without touching unrelated state", async () => {
  const database = fakeDatabase();
  const repos = createPostgresRepositories({ getPool: async () => database.pool });

  await repos.persistDeviceMutation({
    device: { deviceId: "device-1", deviceName: "35" },
    audit: { auditId: "audit-device-1", createdAt: "2026-07-17T00:00:00.000Z" }
  });

  assert.deepEqual(database.calls.map((call) => call.sql === "begin" || call.sql === "commit" ? call.sql : call.sql.match(/insert into ([a-z_]+)/)?.[1]), [
    "begin",
    "phone_cloud_devices",
    "phone_cloud_audit_events",
    "commit"
  ]);
});

test("persists a batch of device listing changes in one transaction", async () => {
  const database = fakeDatabase();
  const repos = createPostgresRepositories({ getPool: async () => database.pool });

  await repos.persistDeviceBatch({
    devices: [{ deviceId: "device-1" }, { deviceId: "device-2" }]
  });

  assert.equal(database.calls.filter(({ sql }) => sql.includes("insert into phone_cloud_devices")).length, 2);
  assert.equal(database.calls[0].sql, "begin");
  assert.equal(database.calls.at(-1).sql, "commit");
});

test("persists authentication state without storing the plaintext session token", async () => {
  const database = fakeDatabase();
  const repos = createPostgresRepositories({ getPool: async () => database.pool });

  await repos.persistAuthMutation({
    user: { userId: "user-1", username: "admin", role: "admin", enabled: true },
    sessions: [{ sessionId: "session-1", userId: "user-1", tokenHash: "hash", token: "plaintext-secret" }]
  });

  const sessionInsert = database.calls.find(({ sql }) => sql.includes("insert into phone_cloud_sessions"));
  assert.ok(sessionInsert);
  assert.doesNotMatch(sessionInsert.params.at(-1), /plaintext-secret/);
});

test("persists linked task state and an event atomically", async () => {
  const database = fakeDatabase();
  const repos = createPostgresRepositories({ getPool: async () => database.pool });

  await repos.persistTaskMutation({
    windowsTask: { taskId: "windows-1", agentId: "agent-1", adbSerial: "serial-1", status: "running", events: [] },
    xhsTask: { taskId: "xhs-1", deviceId: "device-1", userId: "user-1", status: "running", events: [] },
    events: [{ event: { eventId: "event-1", createdAt: "2026-07-17T00:00:00.000Z" }, taskId: "windows-1", source: "windows" }]
  });

  assert.deepEqual(database.calls.map((call) => call.sql === "begin" || call.sql === "commit" ? call.sql : call.sql.match(/insert into ([a-z_]+)/)?.[1]), [
    "begin",
    "phone_cloud_windows_tasks",
    "phone_cloud_xhs_tasks",
    "phone_cloud_task_events",
    "commit"
  ]);
});

test("persists the active device lock with linked tasks", async () => {
  const database = fakeDatabase();
  const repos = createPostgresRepositories({ getPool: async () => database.pool });

  await repos.persistTaskMutation({
    windowsTask: { taskId: "windows-1", agentId: "agent-1", adbSerial: "serial-1", status: "queued" },
    xhsTask: { taskId: "xhs-1", deviceId: "device-1", userId: "user-1", status: "queued" },
    deviceLock: { lockId: "lock-1", deviceId: "device-1", status: "active", expiresAt: "2026-07-17T00:10:00.000Z" }
  });

  assert.ok(database.calls.some(({ sql }) => sql.includes("insert into phone_cloud_device_locks")));
});

test("rolls back and releases the client when a structured write fails", async () => {
  const database = fakeDatabase({ failOn: "phone_cloud_sms_messages" });
  const repos = createPostgresRepositories({ getPool: async () => database.pool });

  await assert.rejects(repos.persistSmsBatch({
    device: { deviceId: "device-1" },
    messages: [{ messageId: "sms-1", deviceId: "device-1" }]
  }), /structured_write_failed/);

  assert.equal(database.calls.at(-1).sql, "rollback");
  assert.equal(database.released, 1);
});

test("merges structured rows over an older snapshot without deleting legacy rows", () => {
  const state = {
    devices: [{ deviceId: "device-1", deviceName: "old" }, { deviceId: "device-2", deviceName: "legacy" }],
    smsMessages: [{ messageId: "sms-old", body: "old" }],
    windowsTasks: [{ taskId: "windows-1", status: "queued" }],
    xhsQrTasks: [],
    deviceLocks: [],
    audit: []
  };

  applyStructuredOverlay(state, {
    devices: [{ deviceId: "device-1", deviceName: "new" }],
    smsMessages: [{ messageId: "sms-new", body: "new" }],
    windowsTasks: [{ taskId: "windows-1", status: "running" }],
    xhsTasks: [{ taskId: "xhs-1", status: "running" }],
    deviceLocks: [],
    auditEvents: []
  });

  assert.deepEqual(state.devices, [{ deviceId: "device-1", deviceName: "new" }, { deviceId: "device-2", deviceName: "legacy" }]);
  assert.deepEqual(state.smsMessages.map((item) => item.messageId), ["sms-new", "sms-old"]);
  assert.equal(state.windowsTasks[0].status, "running");
  assert.equal(state.xhsQrTasks[0].taskId, "xhs-1");
});

test("merges SMS overlay rows by device and business key instead of random message id", () => {
  const state = {
    devices: [],
    users: [],
    sessions: [],
    smsMessages: [
      { messageId: "snapshot-random", deviceId: "device-1", messageKey: "sms:42", body: "old" },
      { messageId: "snapshot-other", deviceId: "device-1", messageKey: "sms:43", body: "keep" }
    ],
    windowsTasks: [],
    xhsQrTasks: [],
    deviceLocks: [],
    audit: []
  };

  applyStructuredOverlay(state, {
    smsMessages: [{ messageId: "database-canonical", deviceId: "device-1", messageKey: "sms:42", body: "new" }]
  });

  assert.deepEqual(state.smsMessages, [
    { messageId: "database-canonical", deviceId: "device-1", messageKey: "sms:42", body: "new" },
    { messageId: "snapshot-other", deviceId: "device-1", messageKey: "sms:43", body: "keep" }
  ]);
});

test("ignores malformed device rows without a device id", () => {
  const state = {
    devices: [{ deviceId: "adb:valid", deviceName: "94", model: "V2357A" }],
    users: [],
    sessions: [],
    smsMessages: [],
    windowsTasks: [],
    xhsQrTasks: [],
    deviceLocks: [],
    audit: []
  };

  applyStructuredOverlay(state, {
    devices: [{}, { deviceName: "broken-device" }, { deviceId: "adb:valid", deviceName: "94", model: "V2357A" }]
  });

  assert.deepEqual(state.devices, [{ deviceId: "adb:valid", deviceName: "94", model: "V2357A" }]);
});

function fakeDatabase({ failOn = "" } = {}) {
  const calls = [];
  const database = {
    calls,
    released: 0,
    pool: {
      async connect() {
        return {
          async query(sql, params = []) {
            const normalized = String(sql).trim().replace(/\s+/g, " ");
            calls.push({ sql: normalized, params });
            if (failOn && normalized.includes(failOn)) throw new Error("structured_write_failed");
            return { rows: [] };
          },
          release() { database.released += 1; }
        };
      }
    }
  };
  return database;
}

test('archive lookup is one bounded parameterized read by exact primary key',async()=>{
 const calls=[];const repos=createPostgresRepositories({getPool:async()=>({query:async q=>{calls.push(q);return {rows:[{job:{jobId:'j'},task:{taskId:'t'}}]};}})});
 assert.equal((await repos.readLookupJob('j')).job.jobId,'j');assert.equal(calls.length,1);
 assert.deepEqual(calls[0].values,['j']);assert.match(calls[0].text,/where j.job_id = \$1 limit 1/);assert.equal(calls[0].query_timeout,5000);
 assert.equal(await repos.readLookupJob('../bad'),null);assert.equal(calls.length,1);
});

test("physical cleanup pending rows load independently of the recent 5000 lock window", async () => {
  const pending = { lockId: "old-duty", lockType: "wecom_physical_cleanup", status: "cleanup_pending", expiresAt: "" };
  const calls = [];
  const repos = createPostgresRepositories({ getPool: async () => ({ query: async sql => {
    calls.push(String(sql));
    return { rows: String(sql).includes("where data->>'lockType'") ? [{ data: pending }] : [] };
  } }) });
  const overlay = await repos.loadOverlay();
  assert.deepEqual(overlay.deviceLocks, [pending]);
  assert.ok(calls.some(sql => sql.includes("limit 5001") && !sql.includes("expires_at >")));
});

test("physical cleanup load overflow fails closed instead of dropping pending obligations", async () => {
  const repos = createPostgresRepositories({ getPool: async () => ({ query: async sql => ({ rows:
    String(sql).includes("where data->>'lockType'") ? Array.from({ length: 5001 }, (_, i) => ({ data: { lockId: `pending-${i}` } })) : []
  }) }) });
  await assert.rejects(repos.loadOverlay(), /wecom_cleanup_pending_load_overflow/);
});

test('pending context is loaded by exact primary keys outside recent history without writes or fabricated missing rows',async()=>{
 const pending={lockId:'duty',lockType:'wecom_physical_cleanup',status:'cleanup_pending',physicalCleanup:{binding:{originalTaskId:'old-task'},originalJobId:'old-job',originalLockId:'old-lock',verification:{verificationTaskId:'missing-verify'},recovery:{verificationTaskId:'old-recovery'}}};
 const rows={phone_cloud_windows_tasks:[{taskId:'old-task',status:'failed'},{taskId:'old-recovery',status:'failed'}],phone_cloud_automation_jobs:[{jobId:'old-job',status:'failed'}],phone_cloud_device_locks:[{lockId:'old-lock',status:'released'}]};
 const calls=[];const repos=createPostgresRepositories({getPool:async()=>({query:async(q)=>{
  const sql=typeof q==='string'?q:q.text;calls.push(q);assert.match(sql,/^select /i);
  if(sql.includes("where data->>'lockType'"))return{rows:[{data:pending}]};
  if(sql.includes('= any($1::text[])'))return{rows:rows[sql.match(/from (\w+)/)[1]].map(data=>({data}))};
  return{rows:[]};
 }})});
 const overlay=await repos.loadOverlay();assert.deepEqual(overlay.windowsTasks,rows.phone_cloud_windows_tasks);
 assert.deepEqual(overlay.automationJobs,rows.phone_cloud_automation_jobs);
 assert.deepEqual(overlay.deviceLocks,[pending,...rows.phone_cloud_device_locks]);
 const exact=calls.filter(q=>typeof q==='object');assert.equal(exact.length,3);
 assert.deepEqual(exact[0].values,[['old-task','missing-verify','old-recovery']]);
 for(const q of exact){assert.equal(q.query_timeout,5000);assert.doesNotMatch(q.text,/data->|order by|update|insert/i);}
 assert.equal(overlay.windowsTasks.some(t=>t.taskId==='missing-verify'),false);
});

test("new and ordinary locks persist with task in one transaction and rollback on hold failure", async () => {
  const db = fakeDatabase({ failOn: "insert into phone_cloud_device_locks" });
  const repos = createPostgresRepositories({ getPool: async () => db.pool });
  await assert.rejects(repos.persistTaskMutation({
    windowsTask: { taskId: "verify", status: "succeeded" },
    deviceLocks: [{ lockId: "duty", status: "released", lockType: "wecom_physical_cleanup" }]
  }), /structured_write_failed/);
  assert.ok(db.calls.some(c => c.sql.includes("phone_cloud_windows_tasks")));
  assert.equal(db.calls.at(-1).sql, "rollback");
  assert.ok(!db.calls.some(c => c.sql === "commit"));
});
