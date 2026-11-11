import {isManagedLookupTask, hasActiveScreenGalleryDelivery} from './managed-lookup-delivery.mjs';

export const LOOKUP_READER_REPORT_MAX_AGE_MS = 15_000;
// Matches the current Agent's configured upper bound, not an ADB task limit.
const MAX_READERS = 16;
const MAX_ACTIVE_IDS = 32;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const serial = value => typeof value === 'string'
  && /^[^\s\u0000-\u001f\u007f]{1,160}$/u.test(value);
const identity = value => value.toUpperCase();
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// receivedAt is stamped by the receiving server, never copied from Agent input.
// Call with the authenticated Agent's current lookupRuntimeId. Do not refresh
// receivedAt when reading a cached report or after a different runtime starts.
export function normalizeLookupReaderCapacity(input, {runtimeId, receivedAt} = {}) {
  if (!object(input) || input.version !== 1 || typeof runtimeId !== 'string' || !uuid.test(runtimeId)
      || input.runtimeId !== runtimeId || !timestamp(receivedAt)
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_READERS
      || !Array.isArray(input.pinnedSerials) || input.pinnedSerials.length > input.limit
      || !input.pinnedSerials.every(serial)) return null;
  // Multiple workers for differently cased versions of one serial must not
  // silently become one slot. An inconsistent report cannot authorize work.
  if (new Set(input.pinnedSerials.map(identity)).size !== input.pinnedSerials.length) return null;
  return {version: 1, runtimeId, limit: input.limit,
    pinnedSerials: [...input.pinnedSerials], receivedAt};
}

// Runtime recovery must never treat a truncated or malformed active-ID list as
// proof that an acknowledged task disappeared. This is observation, not cleanup.
export function normalizeLookupExecutionReport(report, encodedIds) {
  if (!normalizeLookupReaderCapacity(report, {runtimeId:report?.runtimeId, receivedAt:report?.receivedAt})
      || typeof encodedIds !== 'string' || encodedIds.length > 16384) return null;
  let ids;
  try { ids = encodedIds ? encodedIds.split(',').map(id => decodeURIComponent(id).trim()) : []; }
  catch { return null; }
  if (ids.length > MAX_ACTIVE_IDS || ids.some(id => !uuid.test(id))
      || new Set(ids).size !== ids.length) return null;
  return {runtimeId:report.runtimeId, receivedAt:report.receivedAt, activeTaskIds:ids};
}

const decision = (allowed, reason, used = null, limit = null) => ({allowed, reason, used, limit});

// Pure decision only. The caller must record issueScreenGalleryDelivery's
// lease synchronously before its first await, then persist/rollback normally.
// Existing per-serial, protocol, cancellation and generation fences still apply.
// This does not reserve physical workers or alter delivery of other workflows.
export function canAdmitLookupReader({task, agentId, report, now, tasks, activeTaskIds = []}) {
  if (!isManagedLookupTask(task)) return decision(true, 'not_managed_lookup');
  if (task.type === 'alipay_name_stop') return decision(true, 'lookup_stop_cleanup');
  if (typeof agentId !== 'string' || !agentId || task.agentId !== agentId) {
    return decision(false, 'lookup_reader_agent_mismatch');
  }
  if (!serial(task.adbSerial)) return decision(false, 'lookup_reader_serial_invalid');
  const capacity = normalizeLookupReaderCapacity(report, {
    runtimeId: report?.runtimeId, receivedAt: report?.receivedAt
  });
  if (!capacity || !timestamp(now)) return decision(false, 'lookup_reader_report_invalid');
  if (now < capacity.receivedAt || now - capacity.receivedAt >= LOOKUP_READER_REPORT_MAX_AGE_MS) {
    return decision(false, 'lookup_reader_report_stale', null, capacity.limit);
  }
  if (!Array.isArray(tasks) || !(Array.isArray(activeTaskIds) || activeTaskIds instanceof Set)) {
    return decision(false, 'lookup_reader_task_state_invalid', null, capacity.limit);
  }
  const ids = [...activeTaskIds];
  if (ids.length > MAX_ACTIVE_IDS || ids.some(id => typeof id !== 'string'
      || id.length === 0 || id.length > 160 || /\s|[\u0000-\u001f\u007f]/u.test(id))) {
    return decision(false, 'lookup_reader_task_state_invalid', null, capacity.limit);
  }
  const active = new Set(ids), seen = new Set();
  const used = new Set(capacity.pinnedSerials.map(identity));
  for (const other of tasks) {
    if (!object(other) || other.agentId !== agentId) continue;
    if (active.has(other.taskId)) seen.add(other.taskId);
    // All same-Agent active task serials are conservative claims: this gate
    // may defer lookup, but never changes a non-lookup task's admission policy.
    // A stalled task is uncertain, not proof that its worker stopped.
    if (other.status !== 'running' && other.status !== 'stalled'
        && !active.has(other.taskId) && !hasActiveScreenGalleryDelivery(other, now)) continue;
    if (serial(other.adbSerial)) used.add(identity(other.adbSerial));
    else if (isManagedLookupTask(other)) {
      return decision(false, 'lookup_reader_task_state_invalid', used.size, capacity.limit);
    }
  }
  // The Agent can still be executing or retrying an outbox report for a task
  // no longer retained here. Do not interpret an unresolvable active ID as free.
  if ([...active].some(id => !seen.has(id))) {
    return decision(false, 'lookup_reader_active_task_unknown', used.size, capacity.limit);
  }
  const allowed = used.has(identity(task.adbSerial)) || used.size < capacity.limit;
  return decision(allowed, allowed ? 'lookup_reader_capacity_available' : 'lookup_reader_capacity_full',
    used.size, capacity.limit);
}
