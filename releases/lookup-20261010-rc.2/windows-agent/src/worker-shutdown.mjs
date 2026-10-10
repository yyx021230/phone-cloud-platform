export async function waitForWorkerExit(worker, timeoutMs, pollMs = 50) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (!worker?.exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return Boolean(worker?.exited);
}

export function pocoForwardLocals(forwardList, serial) {
  const target = String(serial || "").trim();
  if (!target) return [];
  return [...new Set(String(forwardList || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0] === target && /^tcp:1008[01]$/.test(parts[2] || ""))
    .map((parts) => parts[1])
    .filter(Boolean))];
}

export function stopWorkerWithFallback(worker, options = {}) {
  if (!worker || worker.exited) {
    return Promise.resolve({ exited: true, forced: false });
  }
  if (worker.stopPromise) return worker.stopPromise;

  worker.stopping = true;
  worker.stopPromise = (async () => {
    try {
      await options.requestStop?.();
    } catch {}

    const graceful = await waitForWorkerExit(
      worker,
      options.gracefulTimeoutMs ?? 8_000,
      options.pollMs ?? 50
    );
    if (graceful) return { exited: true, forced: false };

    try {
      await options.forceStop?.();
    } catch {}
    const exited = await waitForWorkerExit(
      worker,
      options.forcedTimeoutMs ?? 2_000,
      options.pollMs ?? 50
    );
    return { exited, forced: true };
  })();
  return worker.stopPromise;
}
