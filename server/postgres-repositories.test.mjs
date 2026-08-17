import assert from "node:assert/strict";
import test from "node:test";

import { applyStructuredOverlay, createPostgresRepositories } from "./postgres-repositories.mjs";

test("persists an SMS batch in one transaction and one set-based statement", async () => {
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
  assert.match(database.calls[2].sql, /on conflict \(device_id, message_key\) do update/);
  assert.match(database.calls[2].sql, /phone_cloud_sms_messages\.message_id/);
  assert.match(database.calls[3].sql, /insert into phone_cloud_audit_events/);
  assert.equal(database.calls[4].sql, "commit");
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
