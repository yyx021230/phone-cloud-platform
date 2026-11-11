const countKeys = ['readerRebuildAttempts', 'appRestartAttempts', 'resultResumeAttempts'];
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

// Old failure durations were coerced from null to zero. Do not fabricate a
// duration from job.createdAt (which includes the Windows dispatch queue).
export function lookupExecutionMetrics(result = {}) {
  const m = result?.diagnostic?.lookupExecution;
  if (m?.version === 1 && m.scope === 'agent_command' && valid(m.durationMs)
      && countKeys.every(k => valid(m[k]) && Number.isSafeInteger(m[k]))) {
    return { version: 1, scope: m.scope, durationMs: m.durationMs,
      ...Object.fromEntries(countKeys.map(k => [k, m[k]])) };
  }
  return null;
}

export function lookupExecutionDuration(result = {}) {
  return lookupExecutionMetrics(result)?.durationMs
    ?? (valid(result?.durationMs) && result.durationMs > 0 ? result.durationMs : null);
}

// Derived from retained jobs, never infer internal retries from the legacy
// recoveryAttempts field. Each job is counted once even if listed twice.
export function lookupRecoverySummary(jobs, attempts = []) {
  const unique = [...new Map(jobs.map(j => [j.jobId, j])).values()];
  const measured = unique.map(j => lookupExecutionMetrics(j.result)).filter(Boolean);
  const automatic = new Set(['page', 'state', 'device', 'network', 'automatic']);
  const resumed = unique.filter(j => j.resumeAfterHumanVerification === true);
  let handoffs = 0;
  for (let i = 1; i < attempts.length; i++) {
    if (attempts[i - 1].deviceId && attempts[i].deviceId && attempts[i - 1].deviceId !== attempts[i].deviceId) handoffs++;
  }
  return { scope: 'retained_jobs', retainedJobs: unique.length, measuredJobs: measured.length,
    unmeasuredJobs: unique.length - measured.length,
    ...Object.fromEntries(countKeys.map(k => [k, measured.reduce((sum, m) => sum + m[k], 0)])),
    automaticRecoveryTasks: resumed.filter(j => automatic.has(j.recoveryOrigin)).length,
    humanResumeTasks: resumed.filter(j => j.recoveryOrigin === 'human').length,
    unknownResumeTasks: resumed.filter(j => !automatic.has(j.recoveryOrigin) && j.recoveryOrigin !== 'human').length,
    crossDeviceHandoffs: handoffs };
}
