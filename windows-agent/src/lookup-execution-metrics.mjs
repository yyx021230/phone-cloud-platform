import { performance } from 'node:perf_hooks';

// One accepted Agent command, including its account-policy substeps. Excludes
// cloud queueing, evidence capture, result delivery and time between commands.
// Counts are attempts, including failed cleanup; they do not prove recovery.
export async function measureLookupExecution(execute, now = () => performance.now()) {
  const started = now();
  const counts = { readerRebuildAttempts: 0, appRestartAttempts: 0, resultResumeAttempts: 0 };
  const finish = () => ({ version: 1, scope: 'agent_command',
    durationMs: Math.max(0, Math.round(now() - started)), ...counts });
  try {
    const result = await execute(counts);
    const measurement = finish();
    return { ...result, durationMs: measurement.durationMs,
      diagnostic: { ...result?.diagnostic, lookupExecution: measurement } };
  } catch (error) {
    error.diagnostic = { ...error.diagnostic, lookupExecution: finish() };
    throw error;
  }
}
