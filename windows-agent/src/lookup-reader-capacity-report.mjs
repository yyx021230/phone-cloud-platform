import {isAirtestWorkerEvictable} from './airtest-worker-lifecycle.mjs';

// Memory-only observation. Does not probe, evict, stop or start any reader.
export function buildLookupReaderCapacityReport({runtimeId,limit,workers,
  activeSerials,screenControlledSerials,preflightSerials} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16 || !(workers instanceof Map)) return null;
  const pinnedSerials = [];
  for (const [serial,worker] of workers) {
    if (!worker || worker.exited) continue;
    if (!isAirtestWorkerEvictable({serial,worker,activeSerials,screenControlledSerials,preflightSerials})) pinnedSerials.push(serial);
  }
  if (pinnedSerials.length > limit) return null;
  return {version:1,runtimeId,limit,pinnedSerials};
}
