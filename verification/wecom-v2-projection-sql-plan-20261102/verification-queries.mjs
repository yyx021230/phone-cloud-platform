// UNEXECUTED verification text only. No imports, SQL execution or permission.
// Negative statements must never be used by the app or against production.
const jobs="job_id,device_id,user_id,kind,status,created_at,updated_at,data";
const locks="lock_id,device_id,status,expires_at,data";
const tasks="task_id,agent_id,adb_serial,status,created_at,updated_at,data";
export const projectionSql=Object.freeze({
  unsafeJobUpsert:`INSERT INTO phone_cloud_automation_jobs AS j (${jobs}) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT(job_id) DO UPDATE SET device_id=excluded.device_id,user_id=excluded.user_id,kind=excluded.kind,status=excluded.status,updated_at=excluded.updated_at,data=excluded.data
    WHERE j.updated_at IS NULL OR excluded.updated_at IS NULL OR excluded.updated_at>=j.updated_at RETURNING ${jobs}`,
  unsafeHoldUpsert:`INSERT INTO phone_cloud_device_locks AS l (${locks}) VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(lock_id) DO UPDATE SET device_id=excluded.device_id,status=excluded.status,expires_at=excluded.expires_at,data=excluded.data
    WHERE coalesce(l.data->>'updatedAt','')<=coalesce(excluded.data->>'updatedAt','') RETURNING ${locks}`,
  // Same generic marker guard cannot protect the unmodified original lock:
  // M3 does NOT add wecomV2Claim to it. This is an explicit negative control.
  insufficientOriginalBusinessGuard:`UPDATE phone_cloud_device_locks AS l SET status=$2,expires_at=$3,data=$4::jsonb
    WHERE l.lock_id=$1 AND NOT(l.data ? 'wecomV2Claim') RETURNING ${locks}`,
  // Actual custom delivery JSON path behavior, with RETURNING added only for
  // verification. It preserves unrelated current fields; do not claim it
  // erases the claim marker. It presently lacks a claim/execution CAS.
  originalDeliveryUpdate:`UPDATE phone_cloud_windows_tasks SET updated_at=$2,
    data=jsonb_set(jsonb_set(jsonb_set(data,'{delivery}',$3::jsonb,true),'{deliveryAttempts}',to_jsonb($4::integer),true),'{updatedAt}',to_jsonb($5::text),true)
    WHERE task_id=$1 RETURNING ${tasks}`,
  // These CAS strings are fixtures for a FUTURE authorized owner transaction,
  // not production handlers. Requires same transaction anchor + full tuple,
  // immutable proposal validation and real caller/host/journal capability.
  // Claim existence alone cannot reconcile a later progress operation: its
  // distinct stable operation receipt contract is still undefined/unbuilt.
  ownerBusinessStatusCas:`UPDATE phone_cloud_device_locks AS l SET status=$2,expires_at=$3,data=$4::jsonb
    WHERE l.lock_id=$1 AND l.device_id=$5 AND l.data=$6::jsonb RETURNING ${locks}`,
  ownerTaskProgressCas:`UPDATE phone_cloud_windows_tasks AS t SET status=$2,updated_at=$3,data=$4::jsonb
    WHERE t.task_id=$1 AND t.agent_id=$5 AND t.adb_serial=$6 AND t.data=$7::jsonb
      AND t.data->'wecomV2Claim'=$8::jsonb RETURNING ${tasks}`,
  ownerJobProgressCas:`UPDATE phone_cloud_automation_jobs AS j SET status=$2,updated_at=$3,data=$4::jsonb
    WHERE j.job_id=$1 AND j.device_id=$5 AND j.user_id=$6 AND j.data=$7::jsonb
      AND j.data->'wecomV2Claim'=$8::jsonb RETURNING ${jobs}`,
  ownerDeliveryCas:`UPDATE phone_cloud_windows_tasks AS t SET updated_at=$2,
    data=jsonb_set(jsonb_set(jsonb_set(t.data,'{delivery}',$3::jsonb,true),'{deliveryAttempts}',to_jsonb($4::integer),true),'{updatedAt}',to_jsonb($5::text),true)
    WHERE t.task_id=$1 AND t.agent_id=$6 AND t.adb_serial=$7 AND t.data=$8::jsonb
      AND t.data->'wecomV2Claim'=$9::jsonb RETURNING ${tasks}`
});
