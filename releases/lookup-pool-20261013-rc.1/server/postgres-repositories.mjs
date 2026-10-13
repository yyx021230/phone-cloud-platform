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
           data = excluded.data
       where phone_cloud_windows_tasks.updated_at is null
          or excluded.updated_at is null
          or excluded.updated_at >= phone_cloud_windows_tasks.updated_at`,
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
           data = excluded.data
       where phone_cloud_xhs_tasks.updated_at is null
          or excluded.updated_at is null
          or excluded.updated_at >= phone_cloud_xhs_tasks.updated_at`,
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

  const upsertAutomationJob = (client, job) => client.query(
    `insert into phone_cloud_automation_jobs
       (job_id, device_id, user_id, kind, status, created_at, updated_at, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     on conflict (job_id) do update
       set device_id = excluded.device_id,
           user_id = excluded.user_id,
           kind = excluded.kind,
           status = excluded.status,
           updated_at = excluded.updated_at,
           data = excluded.data
       where phone_cloud_automation_jobs.updated_at is null
          or excluded.updated_at is null
          or excluded.updated_at >= phone_cloud_automation_jobs.updated_at`,
    [
      requiredId(job?.jobId, "automationJob.jobId"),
      job.deviceId || "",
      job.userId || "",
      job.kind || "",
      job.status || "",
      pgDate(job.createdAt),
      pgDate(job.updatedAt),
      stringify(job)
    ]
  );

  const upsertAutomationSession = (client, session) => client.query(
    `insert into phone_cloud_automation_sessions
       (session_id, device_id, user_id, status, created_at, updated_at, data)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (session_id) do update
       set device_id = excluded.device_id,
           user_id = excluded.user_id,
           status = excluded.status,
           updated_at = excluded.updated_at,
           data = excluded.data
       where phone_cloud_automation_sessions.updated_at is null
          or excluded.updated_at is null
          or excluded.updated_at >= phone_cloud_automation_sessions.updated_at`,
    [
      requiredId(session?.sessionId, "automationSession.sessionId"),
      session.deviceId || "",
      session.userId || "",
      session.status || "",
      pgDate(session.createdAt),
      pgDate(session.updatedAt),
      stringify(session)
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
           data = excluded.data
       where coalesce(phone_cloud_device_locks.data->>'updatedAt', '')
          <= coalesce(excluded.data->>'updatedAt', '')`,
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
            message_key: requiredId(message.messageKey || message.messageId, "message.messageKey"),
            message_at: pgDate(message.messageAt || message.receivedAt || message.createdAt),
            data: message
          }));
          const serializedRows = stringify(rows);
          await client.query(
            `insert into phone_cloud_sms_messages
               (message_id, device_id, message_key, message_at, data, updated_at)
             select row.message_id, row.device_id, row.message_key,
                    row.message_at::timestamptz, row.data, now()
             from jsonb_to_recordset($1::jsonb) as row(
               message_id text, device_id text, message_key text, message_at text, data jsonb
             )
             on conflict do nothing`,
            [serializedRows]
          );
          await client.query(
            `with incoming as (
               select row.message_id, row.device_id, row.message_key,
                      row.message_at::timestamptz as message_at, row.data
               from jsonb_to_recordset($1::jsonb) as row(
                 message_id text, device_id text, message_key text, message_at text, data jsonb
               )
             ), matched as (
               select target.message_id as canonical_message_id,
                      target.device_id as canonical_device_id,
                      target.message_key as current_message_key,
                      incoming.message_key as incoming_message_key,
                      incoming.message_at,
                      incoming.data,
                      case
                        when target.message_id = incoming.message_id
                         and not exists (
                           select 1
                           from phone_cloud_sms_messages conflict
                           where conflict.device_id = incoming.device_id
                             and conflict.message_key = incoming.message_key
                             and conflict.message_id <> target.message_id
                         )
                        then incoming.message_key
                        else target.message_key
                      end as canonical_message_key,
                      row_number() over (
                        partition by target.message_id
                        order by (target.message_id = incoming.message_id) desc,
                                 incoming.message_at desc nulls last
                      ) as match_rank
               from phone_cloud_sms_messages target
               join incoming
                 on target.message_id = incoming.message_id
                 or (
                   target.device_id = incoming.device_id
                   and target.message_key = incoming.message_key
                 )
             )
             update phone_cloud_sms_messages target
                set message_key = matched.canonical_message_key,
                    message_at = matched.message_at,
                    data = jsonb_set(
                      jsonb_set(matched.data, '{messageId}', to_jsonb(matched.canonical_message_id), true),
                      '{messageKey}', to_jsonb(matched.canonical_message_key), true
                    ),
                    updated_at = now()
               from matched
              where matched.match_rank = 1
                and target.message_id = matched.canonical_message_id`,
            [serializedRows]
          );
        }
        await insertAudit(client, audit);
      });
    },

    async persistTaskMutation({ windowsTask = null, windowsTasks = [], xhsTask = null, automationJob = null, automationJobs = [], automationSession = null, device = null, deviceLock = null, events = [], audit = null, transactionClient = null } = {}) {
      const transaction = transactionClient ? (fn) => fn(transactionClient) : inTransaction;
      return transaction(async (client) => {
        if (device) await upsertDevice(client, device);
        if (windowsTask) await upsertWindowsTask(client, windowsTask);
        for (const item of windowsTasks) await upsertWindowsTask(client, item);
        if (xhsTask) await upsertXhsTask(client, xhsTask);
        if (automationJob) await upsertAutomationJob(client, automationJob);
        for (const item of automationJobs) await upsertAutomationJob(client, item);
        if (automationSession) await upsertAutomationSession(client, automationSession);
        if (deviceLock) await upsertDeviceLock(client, deviceLock);
        await insertTaskEvents(client, events);
        await insertAudit(client, audit);
      });
    },

    async persistWindowsTaskDeliveryLease({ windowsTask, audit = null } = {}) {
      return inTransaction(async (client) => {
        await client.query(
          `update phone_cloud_windows_tasks
              set updated_at = $2,
                  data = jsonb_set(
                    jsonb_set(
                      jsonb_set(data, '{delivery}', $3::jsonb, true),
                      '{deliveryAttempts}', to_jsonb($4::integer), true
                    ),
                    '{updatedAt}', to_jsonb($5::text), true
                  )
            where task_id = $1`,
          [
            requiredId(windowsTask?.taskId, "windowsTask.taskId"),
            pgDate(windowsTask.updatedAt),
            stringify(windowsTask.delivery || {}),
            Math.max(0, Number(windowsTask.deliveryAttempts || 0)),
            String(windowsTask.updatedAt || "")
          ]
        );
        await insertAudit(client, audit);
      });
    },

    async loadOverlay() {
      const pool = await getPool();
      const [users, sessions, devices, smsMessages, windowsTasks, xhsTasks, automationJobs, automationSessions, deviceLocks, auditEvents] = await Promise.all([
        loadDataRows(pool, "phone_cloud_users", "updated_at", 5_000),
        loadDataRows(pool, "phone_cloud_sessions", "expires_at", 5_000),
        loadDataRows(pool, "phone_cloud_devices", "updated_at", 5_000),
        loadDataRows(pool, "phone_cloud_sms_messages", "message_at", 50_000),
        loadDataRows(pool, "phone_cloud_windows_tasks", "updated_at", 5_000),
        loadDataRows(pool, "phone_cloud_xhs_tasks", "updated_at", 5_000),
        loadDataRows(pool, "phone_cloud_automation_jobs", "updated_at", 5_000),
        loadDataRows(pool, "phone_cloud_automation_sessions", "updated_at", 1_000),
        loadDataRows(pool, "phone_cloud_device_locks", "expires_at", 5_000),
        loadDataRows(pool, "phone_cloud_audit_events", "created_at", 5_000)
      ]);
      return { users, sessions, devices, smsMessages, windowsTasks, xhsTasks, automationJobs, automationSessions, deviceLocks, auditEvents };
    }
  };
}

export function applyStructuredOverlay(state, overlay = {}) {
  state.users = mergeByKey(overlay.users, state.users, "userId");
  state.sessions = mergeByKey(overlay.sessions, state.sessions, "sessionId");
  state.devices = mergeByKey(overlay.devices, state.devices, "deviceId");
  state.smsMessages = mergeByComputedKey(overlay.smsMessages, state.smsMessages, smsMessageBusinessKey);
  state.windowsTasks = mergeByKey(overlay.windowsTasks, state.windowsTasks, "taskId");
  state.xhsQrTasks = mergeByKey(overlay.xhsTasks, state.xhsQrTasks, "taskId");
  state.automationJobs = mergeByKey(overlay.automationJobs, state.automationJobs, "jobId");
  state.automationSessions = mergeByKey(overlay.automationSessions, state.automationSessions, "sessionId");
  state.deviceLocks = mergeByKey(overlay.deviceLocks, state.deviceLocks, "lockId");
  state.audit = mergeByKey(overlay.auditEvents, state.audit, "auditId");
  return state;
}

async function loadDataRows(pool, table, orderColumn, limit) {
  const result = await pool.query(
    `select data from ${table} order by ${orderColumn} desc nulls last limit $1`,
    [Math.max(1, Number(limit) || 1)]
  );
  return result.rows.map((row) => row.data).filter(Boolean);
}

function mergeByKey(preferred = [], fallback = [], key) {
  return mergeByComputedKey(preferred, fallback, (item) => item?.[key]);
}

function mergeByComputedKey(preferred = [], fallback = [], keyForItem) {
  const result = [];
  const seen = new Set();
  for (const item of [...(preferred || []), ...(fallback || [])]) {
    if (!item || typeof item !== "object") continue;
    const id = String(keyForItem(item) || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function smsMessageBusinessKey(message = {}) {
  const deviceId = String(message.deviceId || "").trim();
  const messageKey = String(message.messageKey || message.messageId || "").trim();
  return deviceId && messageKey ? `${deviceId}\u0000${messageKey}` : String(message.messageId || "").trim();
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
