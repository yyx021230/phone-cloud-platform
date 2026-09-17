const DEFAULT_CONTROL_TIMEOUT_MS = 2_500;

export function createScreenControlQueue({
  execute,
  acknowledge = () => {},
  now = Date.now,
  timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  onTimeout = () => {}
}) {
  if (typeof execute !== "function") throw new Error("invalid_screen_control_executor");
  let tail = Promise.resolve();
  let pendingMove = null;
  let moveQueued = false;
  let closedReason = "";

  const actionName = (message) => {
    if (message?.type === "key") return `key:${message.key || "unknown"}`;
    if (message?.type === "text") return "text";
    return String(message?.action || "unknown");
  };
  const rejectClosed = (message) => {
    acknowledge(message, {
      status: "failed",
      action: actionName(message),
      agentElapsedMs: 0,
      error: closedReason || "screen_control_queue_closed"
    });
  };
  const run = async (message) => {
    if (closedReason) {
      rejectClosed(message);
      return;
    }
    const startedAt = now();
    try {
      await withTimeout(
        () => execute(message),
        typeof timeoutMs === "function" ? timeoutMs(message) : timeoutMs
      );
      acknowledge(message, { status: "injected", action: actionName(message), agentElapsedMs: Math.max(0, now() - startedAt) });
    } catch (error) {
      const errorMessage = error?.message || String(error);
      acknowledge(message, {
        status: "failed",
        action: actionName(message),
        agentElapsedMs: Math.max(0, now() - startedAt),
        error: errorMessage
      });
      if (errorMessage === "screen_control_timeout") {
        closedReason = errorMessage;
        try {
          Promise.resolve(onTimeout(message, error)).catch(() => {});
        } catch {}
      }
    }
  };
  const append = (operation) => {
    tail = tail.then(operation, operation);
  };
  const scheduleMove = () => {
    if (moveQueued) return;
    moveQueued = true;
    append(async () => {
      const message = pendingMove;
      pendingMove = null;
      moveQueued = false;
      if (message) await run(message);
      if (pendingMove) scheduleMove();
    });
  };

  return {
    enqueue(message) {
      if (closedReason) {
        append(() => rejectClosed(message));
        return;
      }
      if (message?.type === "touch" && message.action === "move") {
        if (pendingMove) acknowledge(pendingMove, { status: "coalesced", action: "move", agentElapsedMs: 0 });
        pendingMove = message;
        scheduleMove();
        return;
      }
      append(() => run(message));
    },
    close(reason = "screen_control_queue_closed") {
      closedReason = String(reason || "screen_control_queue_closed");
      if (pendingMove) rejectClosed(pendingMove);
      pendingMove = null;
    },
    async drain() {
      let observed;
      do {
        observed = tail;
        await observed;
      } while (observed !== tail);
    }
  };
}

async function withTimeout(operation, timeoutMs) {
  const duration = Math.max(1, Number(timeoutMs || DEFAULT_CONTROL_TIMEOUT_MS));
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("screen_control_timeout")), duration);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
