// UNEXECUTED VERIFICATION SQL ONLY. Importing performs no operation.
// These strings are NOT a persistence adapter or a production authorization.
// Negative variants may only run in a separately reviewed owned private DB.
const taskColumns="task_id,agent_id,adb_serial,status,created_at,updated_at,data";
const jobColumns="job_id,device_id,user_id,kind,status,created_at,updated_at,data";
const lockColumns="lock_id,device_id,status,expires_at,data";
export const comparisonQueries=Object.freeze({
  // Each writer must first lock an ALREADY provisioned physical anchor, then
  // read canonical owners with new statements. A missing row is not a lock.
  anchor:`SELECT physical_key,device_id,active_obligation_id,active_claim_operation_id,agent_id,mapping_revision,mapping_fingerprint,mapping_state
    FROM phone_cloud_wecom_v2_physical_anchors WHERE physical_key=$1 FOR UPDATE NOWAIT`,
  activeLedger:`SELECT obligation_id,server_epoch,revision,host_operation_id,close_operation_id,protocol_state,claim_data
    FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1 FOR UPDATE NOWAIT`,
  // Orphan/missing-anchor detection, not permission to seed/rebind anything.
  ledgerByPhysical:`SELECT obligation_id,server_epoch,revision,host_operation_id,close_operation_id,protocol_state,claim_data
    FROM phone_cloud_wecom_cleanup_v2
    WHERE claim_data IS NOT NULL AND lower(claim_data #>> '{binding,serial}')=$1
    ORDER BY obligation_id LIMIT 2`,
  // NEGATIVE control: a separate canonical table's statement snapshot alone
  // is not assumed to protect a target row after waiting for another writer.
  unsafeTaskNotExists:`UPDATE phone_cloud_windows_tasks AS t SET status=$2,updated_at=$3,data=$4::jsonb
    WHERE t.task_id=$1 AND NOT EXISTS(SELECT 1 FROM phone_cloud_wecom_cleanup_v2 AS v
      WHERE v.claim_data #>> '{binding,originalTaskId}'=t.task_id)
    RETURNING ${taskColumns}`,
  // Narrow current-row marker control, NOT a complete owner/admission gate.
  guardedTaskUpdate:`UPDATE phone_cloud_windows_tasks AS t SET status=$2,updated_at=$3,data=$4::jsonb
    WHERE t.task_id=$1 AND NOT(t.data ? 'wecomV2Claim')
      AND coalesce(t.data #>> '{payload,physicalCleanup,version}','')<>'2'
    RETURNING ${taskColumns}`,
  guardedTaskUpsert:`INSERT INTO phone_cloud_windows_tasks AS t (${taskColumns}) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT(task_id) DO UPDATE SET agent_id=excluded.agent_id,adb_serial=excluded.adb_serial,status=excluded.status,updated_at=excluded.updated_at,data=excluded.data
    WHERE (t.updated_at IS NULL OR excluded.updated_at IS NULL OR excluded.updated_at>=t.updated_at)
      AND NOT(t.data ? 'wecomV2Claim') AND coalesce(t.data #>> '{payload,physicalCleanup,version}','')<>'2'
    RETURNING ${taskColumns}`,
  guardedJobUpsert:`INSERT INTO phone_cloud_automation_jobs AS j (${jobColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT(job_id) DO UPDATE SET device_id=excluded.device_id,user_id=excluded.user_id,kind=excluded.kind,status=excluded.status,updated_at=excluded.updated_at,data=excluded.data
    WHERE (j.updated_at IS NULL OR excluded.updated_at IS NULL OR excluded.updated_at>=j.updated_at)
      AND NOT(j.data ? 'wecomV2Claim') RETURNING ${jobColumns}`,
  guardedHoldUpsert:`INSERT INTO phone_cloud_device_locks AS l (${lockColumns}) VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(lock_id) DO UPDATE SET device_id=excluded.device_id,status=excluded.status,expires_at=excluded.expires_at,data=excluded.data
    WHERE coalesce(l.data->>'updatedAt','')<=coalesce(excluded.data->>'updatedAt','')
      AND coalesce(l.data #>> '{physicalCleanup,binding,version}','')<>'2'
      AND NOT(l.data ? 'wecomV2Claim') RETURNING ${lockColumns}`,
  // ORIGINAL BUSINESS LOCK HAS NO V2 MARKER TODAY. This is a negative control,
  // not a proposed fix: it can still overwrite identity without anchor owner
  // serialization. Do not claim task/hold marker guards protect this row.
  unsafeBusinessLockUpdate:`UPDATE phone_cloud_device_locks AS l SET status=$2,expires_at=$3,data=$4::jsonb
    WHERE l.lock_id=$1 RETURNING ${lockColumns}`,
  // Dedicated future owner progress, not generic checkpoint. Requires its
  // anchor + full tuple + immutable validation before this exact JSONB CAS.
  controlledTaskCas:`UPDATE phone_cloud_windows_tasks AS t SET status=$2,updated_at=$3,data=$4::jsonb
    WHERE t.task_id=$1 AND t.agent_id=$5 AND t.adb_serial=$6 AND t.data=$7::jsonb
    RETURNING ${taskColumns}`,
  readTask:`SELECT ${taskColumns} FROM phone_cloud_windows_tasks WHERE task_id=$1 FOR UPDATE NOWAIT`,
  readJob:`SELECT ${jobColumns} FROM phone_cloud_automation_jobs WHERE job_id=$1 FOR UPDATE NOWAIT`,
  readHold:`SELECT ${lockColumns} FROM phone_cloud_device_locks WHERE lock_id=$1 FOR UPDATE NOWAIT`,
  observeBlocker:`SELECT pid,state,wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1`
});
