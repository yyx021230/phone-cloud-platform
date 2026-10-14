const TASK_TYPES_WITHOUT_DEVICE_INVENTORY_CHANGES = new Set([
  "xhs_data_collect",
  "alipay_name_start",
  "alipay_name_query",
  "alipay_name_switch",
  "alipay_name_stop",
  "kuaishou_lead"
]);

export function shouldRunPostTaskDeviceScan(taskType) {
  return !TASK_TYPES_WITHOUT_DEVICE_INVENTORY_CHANGES.has(String(taskType || "").trim());
}
