export const DEFAULT_SMS_ORDER_PROBE_INTERVAL_MS = 2_500;

const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "stalled"]);
const SMS_COLLECTION_TASK_TYPES = new Set(["sms_code_probe", "sms_sync_now"]);

export function smsOrderProbeDecision({
  order,
  device,
  tasks = [],
  nowMs = Date.now(),
  intervalMs = DEFAULT_SMS_ORDER_PROBE_INTERVAL_MS,
  force = false
} = {}) {
  if (!order || order.status !== "waiting") return { queue: false, reason: "order_not_waiting" };
  if (!device) return { queue: false, reason: "device_not_found" };
  const agentId = String(device?.adb?.agentId || "");
  const adbSerial = String(device?.adb?.serial || "");
  if (!agentId || !adbSerial || device?.adb?.state !== "device") {
    return { queue: false, reason: "device_not_adb_online" };
  }

  const activeTask = (Array.isArray(tasks) ? tasks : []).find((task) => (
    task?.agentId === agentId
    && String(task?.adbSerial || "") === adbSerial
    && SMS_COLLECTION_TASK_TYPES.has(String(task?.type || ""))
    && ACTIVE_TASK_STATUSES.has(String(task?.status || ""))
  ));
  if (activeTask) return { queue: false, reason: "collection_already_active", activeTask };

  const previousAt = Date.parse(String(order.smsProbeLastQueuedAt || ""));
  const minimumIntervalMs = Math.max(500, Number(intervalMs) || DEFAULT_SMS_ORDER_PROBE_INTERVAL_MS);
  if (!force && Number.isFinite(previousAt) && nowMs - previousAt < minimumIntervalMs) {
    return {
      queue: false,
      reason: "probe_cooldown",
      retryAfterMs: Math.max(0, minimumIntervalMs - (nowMs - previousAt))
    };
  }

  return { queue: true, reason: "due", agentId, adbSerial };
}
