const dailyFilter = "starts_with(record_key, 'run/') and data->>'requestId' ~ '^daily:[0-9]{4}-[0-9]{2}-[0-9]{2}$' and data->>'scheduledAt' is not null";
const itemStatuses = new Set(["succeeded", "failed", "skipped", "queued", "submitting", "running", "unknown"]);
const batchReasons = new Set([
  "device_offline", "device_not_listed", "device_busy_waiting", "device_busy_window_expired",
  "dispatch_window_expired", "batch_stopped", "target_removed_from_allowlist", "binding_changed_or_missing",
  "agent_update_required", "invalid_collection_result", "task_status_unavailable", "job_identity_mismatch",
  "submission_interrupted_no_replay", "submission_outcome_unknown_no_replay",
  "reconciled_existing_job", "submission_recovered", "device_busy", "cancelled", "expired",
]);
const LOGGED_OUT = "Xiaohongshu account is logged out; manual login is required";

export function summarizeDailyBatch(run) {
  const counts = { total: 0, succeeded: 0, failed: 0, skipped: 0, pending: 0 };
  for (const item of run.items ?? []) {
    counts.total++;
    if (["succeeded", "failed", "skipped"].includes(item.status)) counts[item.status]++;
    else counts.pending++;
  }
  return {
    runId: run.runId, day: run.requestId.slice("daily:".length), status: run.status,
    scheduledAt: run.scheduledAt, completedAt: run.completedAt ?? null,
    counts,
  };
}

export async function listDailyBatches(db, { offset = 0, limit = 20, clientId = null, from = null } = {}) {
  const { rows } = await db.query(`
    select data from phone_cloud_xhs_batch_records
    where ${dailyFilter}
      and ($1::text is null or data->>'clientId' = $1)
      and ($2::text is null or data->>'scheduledAt' >= $2)
    order by data->>'scheduledAt' desc, record_key
    limit $3 offset $4`, [clientId, from, limit + 1, offset]);
  return {
    batches: rows.slice(0, limit).map(({ data }) => summarizeDailyBatch(data)),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

function diagnosticError(job) {
  try {
    const { error } = JSON.parse(job.runner_reason);
    return typeof error === "string" ? error.trim() : "";
  } catch {
    return "";
  }
}

function reasonFor(item, job) {
  if (item.status === "succeeded") return "complete";
  const batchReason = batchReasons.has(item.reason) ? item.reason : null;
  if (item.status !== "failed") return batchReason;
  if (item.jobId && !job) return "task_details_unavailable";
  const message = job ? diagnosticError(job) : "";
  // Report logout only when the collector explicitly confirmed it on this task.
  if (job?.status === "failed" && message === LOGGED_OUT) return "confirmed_logged_out";
  if (/loading timed out; UI elements|loading remained empty after bounded wait/.test(message)) return "element_loading_timeout";
  if (/native root missing|UI elements unavailable after fresh hierarchy reads/.test(message)) return "native_elements_unavailable";
  if (/timed out after \d+ seconds/.test(message)) return "device_command_timeout";
  if (/identity (?:mismatch|unproven)|visible public ID/.test(message)) return "account_identity_unproven";
  if (/device still authorizing|device unauthorized/.test(message)) return "adb_authorization";
  if (/not installed in the requested clone profile/.test(message)) return "clone_missing";
  if (/privacy agreement requires manual acceptance|first-use privacy agreement/.test(message)) return "privacy_agreement";
  return batchReason || "collection_failed";
}

export async function readDailyBatch(db, runId, { clientId = null } = {}) {
  if (!/^[a-f0-9]{64}$/.test(runId)) return null;
  const { rows } = await db.query(`
    select data from phone_cloud_xhs_batch_records
    where record_key = $1 and ${dailyFilter} and ($2::text is null or data->>'clientId' = $2)`,
    [`run/${runId}`, clientId]);
  const run = rows[0]?.data;
  if (!run || run.runId !== runId) return null;

  const ids = [...new Set(run.items.filter(item => item.status === "failed" && item.jobId).map(item => item.jobId))];
  const jobs = ids.length ? (await db.query(`
    select job_id, device_id, status, data->>'xhsAppSlot' as app_slot,
           data->>'xhsAccountId' as account_id, data->>'clientRequestId' as request_id,
           data#>>'{result,diagnostic,runnerReason}' as runner_reason
    from phone_cloud_automation_jobs
    where kind = 'xhs_data_collect' and job_id = any($1::text[])`, [ids])).rows : [];
  const byId = new Map(jobs.map(job => [job.job_id, job]));
  return {
    ...summarizeDailyBatch(run),
    items: run.items.map(item => {
      const job = byId.get(item.jobId);
      const matched = job && job.device_id === item.deviceId && job.app_slot === item.appSlot
        && job.account_id === item.xhsId && (!item.clientRequestId || job.request_id === item.clientRequestId);
      return {
        itemId: item.itemId, deviceName: item.deviceName, appSlot: item.appSlot, accountName: item.accountName,
        status: itemStatuses.has(item.status) ? item.status : "unknown",
        reason: reasonFor(item, matched ? job : null),
        submittedAt: item.submittedAt ?? null, completedAt: item.completedAt ?? null,
        deferredAttempts: Array.isArray(item.deferredAttempts) ? item.deferredAttempts.length : 0,
      };
    }),
  };
}
