// Executor saturation belongs to the Agent, not to a phone/account. Keep this
// separate from readiness proofs and persistent device failure counters.
export const READER_CAPACITY_WAIT_MS = 30000;
const groupFor = (adapter, id) => adapter.readerCapacityGroup?.(id) || `device:${id}`;
export function readerCapacityWaiting(s, adapter, deviceId, now) {
  const group = groupFor(adapter, deviceId);
  return (s.readerCapacityBackoffs || []).some(row => row.group === group && row.until > now);
}
export function deferReaderCapacity(s, adapter, c, evidence, now) {
  s.readerCapacityBackoffs = (s.readerCapacityBackoffs || []).filter(row => row.until > now);
  const group = groupFor(adapter, c.deviceId);
  const row = s.readerCapacityBackoffs.find(row => row.group === group);
  // A repeated observation of one terminal task never renews its deadline.
  if (row?.jobId === evidence.jobId) return;
  const next = {group, jobId:evidence.jobId, until:now + READER_CAPACITY_WAIT_MS};
  if (row) Object.assign(row, next); else s.readerCapacityBackoffs.push(next);
  const d = s.devices.find(d => d.deviceId === c.deviceId);
  if (d) d.lastCapacityFailure = {jobId:evidence.jobId, at:now, retryAt:next.until};
}
