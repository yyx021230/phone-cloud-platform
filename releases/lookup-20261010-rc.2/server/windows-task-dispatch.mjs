const CONTINUATION_PRIORITY = new Map([
  ["alipay_name_stop", 300],
  ["alipay_name_query", 200],
  ["alipay_name_switch", 200]
]);

export function windowsTaskDispatchPriority(task = {}) {
  return CONTINUATION_PRIORITY.get(String(task.type || "")) || 100;
}

export function sortWindowsTasksForDispatch(tasks = []) {
  return [...tasks].sort((left, right) => {
    const priorityDelta = windowsTaskDispatchPriority(right) - windowsTaskDispatchPriority(left);
    if (priorityDelta) return priorityDelta;
    const createdDelta = Date.parse(left?.createdAt || 0) - Date.parse(right?.createdAt || 0);
    if (Number.isFinite(createdDelta) && createdDelta) return createdDelta;
    return String(left?.taskId || "").localeCompare(String(right?.taskId || ""));
  });
}
