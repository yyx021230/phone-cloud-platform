import { performance } from "node:perf_hooks";
import { setImmediate as yieldToIo } from "node:timers/promises";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);

// Runtime maintenance must never serialize historical events/results. External
// data is normalized at ingress; older snapshots are normalized before listen.
export function compactTaskPayload(task) {
  if (!task || !TERMINAL_STATUSES.has(task.status)) return;
  delete task.delivery;
  delete task.deliveryAttempts;
  delete task.qrImageDataUrl;
  delete task.imageDataUrls;
  if (task.payload && typeof task.payload === "object") {
    delete task.payload.qrImageDataUrl;
    delete task.payload.imageDataUrl;
    delete task.payload.imageDataUrls;
  }
}

export function trimTaskEventHistory(task, limit = 100) {
  if (!Array.isArray(task?.events) || task.events.length <= limit) return;
  // Keep the existing policy, including invalid-date and equal-time ordering.
  // Below the cap, preserve the array and all event identities without a scan.
  task.events = task.events.slice()
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, limit)
    .reverse();
}

function eventTime(event) {
  const time = new Date(event.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function maintainTaskHistory(tasks = []) {
  for (const task of Array.isArray(tasks) ? tasks : []) {
    compactTaskPayload(task);
    trimTaskEventHistory(task);
  }
}

// Call exactly once after loading snapshot + overlay, before exposing the HTTP
// server. Yield between records, never publish a partially normalized task to
// live request handlers. A single JSON event/result is an indivisible unit, so
// the budget bounds scheduling between units, not the cost of one huge record.
export async function normalizeLoadedTaskHistory(collections, options) {
  const {
    sanitizeEvent, sanitizeResult, now = () => performance.now(),
    yieldTurn = yieldToIo, budgetMs = 4, maxUnitsPerTurn = 100
  } = options;
  let sliceStartedAt = now();
  let units = 0;
  const due = () => ++units >= maxUnitsPerTurn || now() - sliceStartedAt >= budgetMs;
  const nextTurn = async () => {
    await yieldTurn();
    units = 0;
    sliceStartedAt = now();
  };
  for (const tasks of collections) {
    for (const task of Array.isArray(tasks) ? tasks : []) {
      compactTaskPayload(task);
      trimTaskEventHistory(task);
      if (TERMINAL_STATUSES.has(task.status) && task.result) {
        task.result = sanitizeResult(task.result);
        if (due()) await nextTurn();
      }
      if (Array.isArray(task.events)) {
        const normalized = [];
        for (const event of task.events) {
          normalized.push(sanitizeEvent(event));
          if (due()) await nextTurn();
        }
        task.events = normalized;
      }
      if (due()) await nextTurn();
    }
  }
}
