export function createAdbServerRecovery(options = {}) {
  const now = options.now || Date.now;
  const recoverAfterFailures = Math.max(1, Number(options.recoverAfterFailures || 2));
  const hardRecoverAfterFailures = Math.max(recoverAfterFailures + 1, Number(options.hardRecoverAfterFailures || 3));
  const cooldownMs = Math.max(1, Number(options.cooldownMs || 120_000));
  let consecutiveFailures = 0;
  let lastRecoveryAt = 0;

  return {
    recordSuccess() {
      consecutiveFailures = 0;
    },
    async recover({ startServer, restartServer, busy = false, cause = "" } = {}) {
      consecutiveFailures += 1;
      const at = now();
      if (consecutiveFailures < recoverAfterFailures) {
        return { attempted: false, action: "wait", consecutiveFailures, cause };
      }
      if (at - lastRecoveryAt < cooldownMs) {
        return { attempted: false, action: "cooldown", consecutiveFailures, cause };
      }
      if (consecutiveFailures < hardRecoverAfterFailures) {
        lastRecoveryAt = at;
        await startServer();
        return { attempted: true, action: "start_server", consecutiveFailures, cause };
      }
      if (busy) return { attempted: false, action: "deferred_busy", consecutiveFailures, cause };
      lastRecoveryAt = at;
      await restartServer();
      return { attempted: true, action: "restart_server", consecutiveFailures, cause };
    },
    health() {
      return {
        consecutiveFailures,
        lastRecoveryAt: lastRecoveryAt ? new Date(lastRecoveryAt).toISOString() : ""
      };
    }
  };
}
