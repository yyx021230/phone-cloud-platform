export function createAdbPriorityQueue(options = {}) {
  const now = options.now || Date.now;
  const pending = [];
  let active = null;
  let sequence = 0;
  let closed = false;
  let lastOperation = "";
  let lastCompletedAt = 0;
  let lastFailure = "";

  const drain = () => {
    if (closed || active || !pending.length) return;
    pending.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    const item = pending.shift();
    if (item.signal?.aborted) {
      item.reject(abortError());
      queueMicrotask(drain);
      return;
    }
    active = item;
    const complete = () => {
      lastOperation = item.label;
      lastCompletedAt = now();
      item.cleanupAbort?.();
      active = null;
      queueMicrotask(drain);
    };
    let operationResult;
    try {
      operationResult = item.operation();
    } catch (error) {
      operationResult = Promise.reject(error);
    }
    Promise.resolve(operationResult)
      .then((result) => {
        complete();
        item.resolve(result);
      }, (error) => {
        lastFailure = String(error?.message || error || "operation_failed").slice(0, 300);
        complete();
        item.reject(error);
      });
  };

  return {
    enqueue(operation, enqueueOptions = {}) {
      if (typeof operation !== "function") return Promise.reject(new TypeError("operation is required"));
      if (closed) return Promise.reject(new Error("adb_priority_queue_closed"));
      if (enqueueOptions.signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const item = {
          operation,
          resolve,
          reject,
          priority: Number(enqueueOptions.priority || 0),
          label: String(enqueueOptions.label || "adb").slice(0, 80),
          signal: enqueueOptions.signal,
          sequence: sequence += 1,
          queuedAt: now(),
          cleanupAbort: null
        };
        if (item.signal) {
          const onAbort = () => {
            const index = pending.indexOf(item);
            if (index < 0) return;
            pending.splice(index, 1);
            reject(abortError());
          };
          item.signal.addEventListener("abort", onAbort, { once: true });
          item.cleanupAbort = () => item.signal.removeEventListener("abort", onAbort);
        }
        pending.push(item);
        drain();
      });
    },
    health() {
      return {
        queueDepth: pending.length,
        activeOperation: active?.label || "",
        activeForMs: active ? Math.max(0, now() - active.queuedAt) : 0,
        lastOperation,
        lastCompletedAt: lastCompletedAt ? new Date(lastCompletedAt).toISOString() : "",
        lastFailure
      };
    },
    close(reason = "adb_priority_queue_closed") {
      if (closed) return;
      closed = true;
      for (const item of pending.splice(0)) {
        item.cleanupAbort?.();
        item.reject(new Error(reason));
      }
    }
  };
}

function abortError() {
  const error = new Error("operation_aborted");
  error.name = "AbortError";
  return error;
}
