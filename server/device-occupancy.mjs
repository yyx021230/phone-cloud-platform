function occupancyLabel(lockType, appSlot) {
  if (lockType === "screen_control") return "实时控制";
  if (lockType === "sms_wait") return "等待短信";
  if (lockType === "xhs_qr") return `${appSlot === "app2" ? "小红书 2" : "小红书 1"} 扫码`;
  return "设备任务";
}

function resolveOwner(ownerUserId, viewer, users) {
  if (viewer?.role === "user" && viewer.userId === ownerUserId) return { label: "你", visible: true };
  if (viewer?.role !== "admin") return { label: "其他用户", visible: false };
  if (String(ownerUserId || "").startsWith("admin:")) return { label: "管理员", visible: true };
  const owner = users.find((user) => user.userId === ownerUserId);
  return { label: owner?.displayName || owner?.username || "未知用户", visible: true };
}

export function buildDeviceOccupancy({ lock, viewer = null, users = [] } = {}) {
  if (!lock) return null;
  const appSlot = String(lock.appSlot || "");
  const owner = resolveOwner(String(lock.ownerUserId || ""), viewer, users);
  const isScreenControl = lock.lockType === "screen_control";
  return {
    kind: String(lock.lockType || "task"),
    label: occupancyLabel(lock.lockType, appSlot),
    ownerLabel: owner.label,
    ownerVisible: owner.visible,
    startedAt: String(lock.createdAt || ""),
    appSlot,
    taskId: isScreenControl ? "" : String(lock.taskId || ""),
    sessionId: isScreenControl ? String(lock.taskId || "") : ""
  };
}
