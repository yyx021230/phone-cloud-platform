function occupancyLabel(lockType, appSlot) {
  if (lockType === "screen_control") return "实时控制";
  if (lockType === "sms_wait") return "等待短信";
  if (lockType === "xhs_qr") return `${appSlot === "app2" ? "小红书 2" : "小红书 1"} 扫码`;
  if (lockType === "xhs_data_collect") return `${appSlot === "app2" ? "小红书 2" : "小红书 1"} 数据采集`;
  if (lockType === "xhs_publish") return `${appSlot === "app2" ? "小红书 2" : "小红书 1"} 发布`;
  if (lockType === "alipay_name_lookup") return "支付宝查名字";
  return "设备任务";
}

function resolveOwner(ownerUserId, viewer, users) {
  if (viewer?.role === "user" && viewer.userId === ownerUserId) return { label: "你", visible: true };
  const normalizedOwnerUserId = String(ownerUserId || "").trim();
  if (normalizedOwnerUserId.startsWith("admin:")) return { label: "管理员", visible: true };
  if (normalizedOwnerUserId === "system" || normalizedOwnerUserId.startsWith("system:")) {
    return { label: "系统任务", visible: true };
  }
  const owner = users.find((user) => user.userId === ownerUserId);
  if (!owner) return { label: "未知用户", visible: false };
  if (owner.role === "admin") return { label: "管理员", visible: true };
  return { label: owner.displayName || owner.username || "未知用户", visible: true };
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
