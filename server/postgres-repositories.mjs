export function createPostgresRepositories({ getPool, stringify = JSON.stringify } = {}) {
  if (typeof getPool !== "function") throw new TypeError("getPool is required");

  const inTransaction = async (operation) => {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const upsertDevice = (client, device) => client.query(
    `insert into phone_cloud_devices (device_id, data, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (device_id) do update
       set data = excluded.data, updated_at = now()`,
    [requiredId(device?.deviceId, "device.deviceId"), stringify(device)]
  );

  const upsertUser = (client, user) => client.query(
    `insert into phone_cloud_users
       (user_id, username, role, enabled, updated_at, data)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (user_id) do update
       set username = excluded.username,
           role = excluded.role,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           data = excluded.data`,
    [
      requiredId(user?.userId, "user.userId"),
      user.username || "",
      user.role || "user",
      user.enabled !== false,
      pgDate(user.updatedAt || user.lastLoginAt || user.createdAt),
      stringify(user)
    ]
  );

  const upsertSession = (client, session) => {
    const { token: _plaintextToken, ...persistedSession } = session || {};
    return client.query(
      `insert into phone_cloud_sessions
         (session_id, user_id, expires_at, revoked_at, data)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (session_id) do update
         set user_id = excluded.user_id,
             expires_at = excluded.expires_at,
             revoked_at = excluded.revoked_at,
             data = excluded.data`,
      [
        requiredId(persistedSession.sessionId, "session.sessionId"),
        persistedSession.userId || "",
        pgDate(persistedSession.expiresAt),
        pgDate(persistedSession.revokedAt),
        stringify(persistedSession)
      ]
    );
  };

  const upsertWindowsTask = (client, task) => client.query(
    `insert into phone_cloud_windows_tasks
       (task_id, agent_id, adb_serial, status, created_at, updated_at, data)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (task_id) do update
       set agent_id = excluded.agent_id,
           adb_serial = excluded.adb_serial,
           status = excluded.status,
           updated_at = excluded.updated_at,
           data = excluded.data`,
    [
      requiredId(task?.taskId, "windowsTask.taskId"),
      task.agentId || "",
      task.adbSerial || "",
      task.status || "",
      pgDate(task.createdAt),
      pgDate(task.updatedAt),
      stringify(task)
    ]
  );

  const upsertXhsTask = (client, task) => client.query(
    `insert into phone_cloud_xhs_tasks
       (task_id, device_id, user_id, status, created_at, updated_at, data)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (task_id) do update
       set device_id = excluded.device_id,
           user_id = excluded.user_id,
           status = excluded.status,
           updated_at = excluded.updated_at,
           data = excluded.data`,
    [
      requiredId(task?.taskId, "xhsTask.taskId"),
      task.deviceId || "",
      task.userId || "",
      task.status || "",
      pgDate(task.createdAt),
      pgDate(task.updatedAt),
      stringify(task)
    ]
  );

  const upsertDeviceLock = (client, lock) => client.query(
    `insert into phone_cloud_device_locks
       (lock_id, device_id, status, expires_at, data)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (lock_id) do update
       set device_id = excluded.device_id,
           status = excluded.status,
           expires_at = excluded.expires_at,
           data = excluded.data`,
    [
      requiredId(lock?.lockId, "deviceLock.lockId"),
      lock.deviceId || "",
      lock.status || "",
      pgDate(lock.expiresAt),
      stringify(lock)
    ]
  );

  const insertTaskEvents = (client, events) => {
    if (!events?.length) return Promise.resolve();
    const rows = events.map((item) => ({
      eventId: requiredId(item.event?.eventId || item.event?.id, "event.eventId"),
      taskId: requiredId(item.taskId, "event.taskId"),
      source: item.source || "",
      createdAt: pgDate(item.event?.createdAt || item.event?.at),
      data: item.event
    }));
    return client.query(
      `insert into phone_cloud_task_events
         (event_id, task_id, source, created_at, data)
       select row.event_id, row.task_id, row.source,
              row.created_at::timestamptz, row.data
       from jsonb_to_recordset($1::jsonb) as row(
         event_id text, task_id text, source text, created_at text, data jsonb
       )
       on conflict (event_id) do update
         set task_id = excluded.task_id,
             source = excluded.source,
             created_at = excluded.created_at,
             data = excluded.data`,
      [stringify(rows.map(toSnakeCaseRow))]
    );
  };

  const insertAudit = (client, audit) => {
    if (!audit) return Promise.resolve();
    return client.query(
      `insert into phone_cloud_audit_events (audit_id, created_at, data)
       values ($1, $2, $3::jsonb)
       on conflict (audit_id) do update
         set created_at = excluded.created_at, data = excluded.data`,
      [requiredId(audit.auditId, "audit.auditId"), pgDate(audit.createdAt), stringify(audit)]
    );
  };

  return {
    async persistAuthMutation({ user = null, sessions = [], audit = null } = {}) {
      return inTransaction(async (client) => {
        if (user) await upsertUser(client, user);
        for (const session of sessions) await upsertSession(client, session);
        await insertAudit(client, audit);
      });
    },

    async persistDeviceMutation({ device, audit = null } = {}) {
      return inTransaction(async (client) => {
        await upsertDevice(client, device);
        await insertAudit(client, audit);
      });
    },

    async persistDeviceBatch({ devices = [], audit = null } = {}) {
      return inTransaction(async (client) => {
        for (const device of devices) await upsertDevice(client, device);
        await insertAudit(client, audit);
      });
    },

    async persistSmsBatch({ device, messages = [], audit = null } = {}) {
      return inTransaction(async (client) => {
        await upsertDevice(client, device);
        if (messages.length) {
          const rows = messages.map((message) => ({
            message_id: requiredId(message.messageId, "message.messageId"),
            device_id: requiredId(message.deviceId || device.deviceId, "message.deviceId"),
            message_at: pgDate(message.messageAt || message.receivedAt || message.createdAt),
            data: message
          }));
          await client.query(
            `insert into phone_cloud_sms_messages
               (message_id, device_id, message_at, data, updated_at)
             select row.message_id, row.device_id,
                    row.message_at::timestamptz, row.data, now()
             from jsonb_to_recordset($1::jsonb) as row(
               message_id text, device_id text, message_at text, data jsonb
             )
             on conflict (message_id) do update
               set device_id = excluded.device_id,
                   message_at = excluded.message_at,
                   data = excluded.data,
                   updated_at = now()`,
            [stringify(rows)]
          );
        }
        await insertAudit(client, audit);
      });
    },

    async persistTaskMutation({ windowsTask = null, xhsTask = null, deviceLock = null, events = [], audit = null } = {}) {
      return inTransaction(async (client) => {
        if (windowsTask) await upsertWindowsTask(client, windowsTask);
        if (xhsTask) await upsertXhsTask(client, xhsTask);
        if (deviceLock) await upsertDeviceLock(client, deviceLock);
        await insertTaskEvents(client, events);
        await insertAudit(client, audit);
      });
    },

    async loadOverlay() {
      const pool = await getPool();
      const [users, sessions, devices, smsMessages, windowsTasks, xhsTasks, deviceLocks, auditEvents] = await Promise.all([
        loadDataRows(pool, "phone_cloud_users", "updated_at"),
        loadDataRows(pool, "phone_cloud_sessions", "expires_at"),
        loadDataRows(pool, "phone_cloud_devices", "updated_at"),
        loadDataRows(pool, "phone_cloud_sms_messages", "message_at"),
        loadDataRows(pool, "phone_cloud_windows_tasks", "updated_at"),
        loadDataRows(pool, "phone_cloud_xhs_tasks", "updated_at"),
        loadDataRows(pool, "phone_cloud_device_locks", "expires_at"),
        loadDataRows(pool, "phone_cloud_audit_events", "created_at")
      ]);
      return { users, sessions, devices, smsMessages, windowsTasks, xhsTasks, deviceLocks, auditEvents };
    }
  };
}

export function applyStructuredOverlay(state, overlay = {}) {
  state.users = mergeByKey(overlay.users, state.users, "userId");
  state.sessions = mergeByKey(overlay.sessions, state.sessions, "sessionId");
  state.devices = mergeByKey(overlay.devices, state.devices, "deviceId");
  state.smsMessages = mergeByKey(overlay.smsMessages, state.smsMessages, "messageId");
  state.windowsTasks = mergeByKey(overlay.windowsTasks, state.windowsTasks, "taskId");
  state.xhsQrTasks = mergeByKey(overlay.xhsTasks, state.xhsQrTasks, "taskId");
  state.deviceLocks = mergeByKey(overlay.deviceLocks, state.deviceLocks, "lockId");
  state.audit = mergeByKey(overlay.auditEvents, state.audit, "auditId");
  return state;
}

async function loadDataRows(pool, table, orderColumn) {
  const result = await pool.query(`select data from ${table} order by ${orderColumn} desc nulls last`);
  return result.rows.map((row) => row.data).filter(Boolean);
}

function mergeByKey(preferred = [], fallback = [], key) {
  const result = [];
  const seen = new Set();
  for (const item of [...(preferred || []), ...(fallback || [])]) {
    if (!item || typeof item !== "object") continue;
    const id = String(item[key] || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function requiredId(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function pgDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toSnakeCaseRow(row) {
  return {
    event_id: row.eventId,
    task_id: row.taskId,
    source: row.source,
    created_at: row.createdAt,
    data: row.data
  };
}
