import {isWecomCleanupPending} from './wecom-physical-cleanup.mjs';

// A pending physical obligation outlives terminal history. Keep only its exact
// references; never extend unrelated task retention or fabricate missing rows.
export function pendingWecomContext(locks = []) {
  const tasks = new Set(), jobs = new Set(), originals = new Set();
  const add = (set, value) => {
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)) set.add(value);
  };
  for (const lock of locks) {
    if (!isWecomCleanupPending(lock)) continue;
    const duty = lock.physicalCleanup;
    add(tasks, duty?.binding?.originalTaskId);
    add(tasks, duty?.verification?.verificationTaskId);
    add(tasks, duty?.recovery?.verificationTaskId);
    add(jobs, duty?.originalJobId);
    add(originals, duty?.originalLockId);
  }
  return {tasks, jobs, locks: originals};
}
