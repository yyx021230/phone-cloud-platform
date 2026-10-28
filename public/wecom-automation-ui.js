const ROOT = "/api/v1/user/automation";
const ACTIVE = new Set(["queued", "running", "stalled"]);
export const wecomSlotLabel = slot => slot === "clone" ? "分身" : "主应用";
export const wecomStatusLabel = task => task.result?.status === "blocked" ? "已停止，请核对原因" : task.status === "succeeded" ? (task.result?.status === "ready_before_send" ? "已到发送前，未发送邀请" : "执行已结束，请核对结果") : ({ queued: "等待设备领取", running: "正在执行", stalled: "状态待核对", failed: "已停止", expired: "已超时" })[task.status] || task.status;
const localRejection = message => Object.assign(new Error(message), { definiteResponse: true });

// One pending submission per physical phone, across both slots. Storage contains
// request identities only, never the customer's phone or authentication token.
export function createWecomPanelModel({ request, storage } = {}) {
  let identity = "", credential = "", generation = 0, pending = {}, devices = [], tasks = [], loaded = false, loading = null;
  const persist = () => { storage?.setItem(`wecomPreviewPending:${identity}`, JSON.stringify(pending)); };
  const session = ctx => {
    const next = ctx?.role === "admin" && ctx.userId && ctx.token ? `${ctx.userId}` : "";
    if (identity === next && credential === (ctx?.token || "")) return;
    identity = next; credential = ctx?.token || ""; generation++; devices = []; tasks = []; loaded = false; loading = null; pending = {};
    if (identity) {
      try {
        const saved = JSON.parse(storage?.getItem(`wecomPreviewPending:${identity}`) || "{}");
        for (const [deviceId, value] of Object.entries(saved)) {
          if (deviceId.startsWith("adb:") && /^[A-Za-z0-9_-]{8,100}$/.test(value?.requestId) && ["main", "clone"].includes(value.appSlot)) pending[deviceId] = { requestId: value.requestId, appSlot: value.appSlot };
        }
      } catch { /* Invalid storage never grants a device or application slot. */ }
    }
  };
  const snapshot = () => ({ devices, tasks, pending: { ...pending }, loaded });
  const refresh = async ctx => {
    session(ctx); if (!identity) return;
    if (loading) return loading;
    const current = generation;
    const work = (async () => {
      try {
        const [inventory, history] = await Promise.all([request(ctx, "/wecom-preview-devices"), request(ctx, "/wecom-preview-tasks")]);
        if (current !== generation) return;
        if (!Array.isArray(inventory.devices) || !Array.isArray(history.tasks)) throw new Error("invalid_wecom_response");
        devices = inventory.devices; tasks = history.tasks; loaded = true;
        for (const [deviceId, value] of Object.entries(pending)) {
          const task = tasks.find(t => t.requestId === value.requestId && t.deviceId === deviceId && t.appSlot === value.appSlot);
          if (task && !ACTIVE.has(task.status)) delete pending[deviceId];
        }
        persist();
      } catch (error) { if (current === generation) loaded = false; throw error; }
    })();
    loading = work;
    try { await work; } finally { if (loading === work) loading = null; }
  };
  const submit = async (ctx, input) => {
    session(ctx);
    const device = devices.find(d => d.deviceId === input.deviceId);
    if (!identity || !loaded || !device?.available || !device.appSlots?.some(s => s.appSlot === input.appSlot)) throw localRejection("请刷新并选择已配置的空闲应用");
    if (pending[input.deviceId] || tasks.some(t => t.deviceId === input.deviceId && ACTIVE.has(t.status))) throw localRejection("请先核对这台手机的原任务，不能重复提交");
    if (!/^1[3-9]\d{9}$/.test(input.phoneNumber)) throw localRejection("请输入11位客户手机号");
    const current = generation;
    pending[input.deviceId] = { requestId: input.requestId, appSlot: input.appSlot };
    // If the recovery identity cannot be saved, do not POST.
    try { persist(); } catch { delete pending[input.deviceId]; throw localRejection("无法保存请求编号，本次未提交，请检查浏览器存储"); }
    try {
      const result = await request(ctx, "/wecom-preview-tasks", input);
      if (current !== generation) return;
      tasks = [result.task, ...tasks.filter(t => t.jobId !== result.task.jobId)];
      return result.task;
    } catch (error) {
      if (current !== generation) return;
      if (error.definiteResponse) { delete pending[input.deviceId]; persist(); }
      throw error;
    }
  };
  return { session, snapshot, refresh, submit };
}

export function createWecomAutomationPanel({ context, document: doc = document, fetchImpl = fetch, storage = sessionStorage } = {}) {
  const form = doc.getElementById("userWecomForm");
  if (!form) return { render() {}, refresh: async () => {} };
  const slot = doc.getElementById("userWecomSlot"), phone = doc.getElementById("userWecomPhone");
  const button = doc.getElementById("userWecomSubmit"), hint = doc.getElementById("userWecomHint"), history = doc.getElementById("userWecomTasks");
  const selectedSlots = new Map();
  let message = "", displayedSession = "", displayedDevice = "";
  const model = createWecomPanelModel({ storage, request: async (ctx, route, input) => {
    const response = await fetchImpl(ROOT + route, { method: input ? "POST" : "GET", credentials: "same-origin", redirect: "error",
      headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
      ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || "请求失败"), { definiteResponse: response.status < 500 });
    return data;
  } });
  function text(tag, value) { const node = doc.createElement(tag); node.textContent = value; return node; }
  function render() {
    const ctx = context(); model.session(ctx);
    const identity = ctx.userId && ctx.token ? ctx.userId : "";
    if (displayedSession !== identity) { displayedSession = identity; message = ""; phone.value = ""; selectedSlots.clear(); }
    if (displayedDevice !== ctx.deviceId) { displayedDevice = ctx.deviceId; phone.value = ""; message = ""; }
    const state = model.snapshot(), device = state.devices.find(d => d.deviceId === ctx.deviceId);
    const options = device?.appSlots || [];
    const pending = state.pending[ctx.deviceId];
    const activeTask = state.tasks.find(t => t.deviceId === ctx.deviceId && ACTIVE.has(t.status));
    const selected = pending?.appSlot || activeTask?.appSlot || selectedSlots.get(ctx.deviceId) || device?.appSlot;
    slot.replaceChildren();
    for (const target of options) { const option = text("option", wecomSlotLabel(target.appSlot)); option.value = target.appSlot; slot.append(option); }
    if (!options.length) { const option = text("option", state.loaded ? "此手机未配置企微应用" : "请刷新读取企微应用"); option.value = ""; slot.append(option); }
    if (options.some(o => o.appSlot === selected)) slot.value = selected;
    const original = pending && state.tasks.find(t => t.requestId === pending.requestId && t.deviceId === ctx.deviceId);
    const active = Boolean(activeTask);
    button.disabled = ctx.role !== "admin" || !state.loaded || !device?.available || !slot.value || Boolean(pending || active);
    slot.disabled = Boolean(pending || active) || !options.length;
    phone.disabled = Boolean(pending || active) || ctx.role !== "admin";
    hint.textContent = ctx.role !== "admin" ? "此阶段仅管理员可运行企微预览。" : pending ? (original ? `原任务：${wecomStatusLabel(original)}。同一台手机请等待当前任务结束。` : "提交结果暂未确认，正在查找原请求，请勿重新提交。") : !state.loaded ? (message || "请刷新读取企微应用和任务状态。") : !device ? "这台手机不在本轮8台范围内。" : message || (!device.available ? "手机占用或离线，请空闲后再试。" : "只搜索并核对备注，停在发送邀请前。");
    history.replaceChildren();
    const tasks = state.tasks.filter(t => t.deviceId === ctx.deviceId);
    for (const task of tasks) {
      const row = doc.createElement("article"); row.className = "scan-task-card";
      row.append(text("strong", `${wecomSlotLabel(task.appSlot)} · ${wecomStatusLabel(task)}`), text("p", task.result?.code || "等待执行"), text("small", `${task.requestId} · ${task.jobId}`)); history.append(row);
    }
    if (!tasks.length) history.append(text("p", "暂无企微任务记录。"));
  }
  async function refresh() { const ctx = context(); if (ctx.role !== "admin") { render(); return; } try { await model.refresh(ctx); } catch { message = "企微状态读取失败，请刷新后再运行。"; } render(); }
  slot.addEventListener("change", () => { selectedSlots.set(context().deviceId, slot.value); });
  form.addEventListener("submit", async event => {
    event.preventDefault(); const ctx = context();
    const input = { deviceId: ctx.deviceId, appSlot: slot.value, phoneNumber: phone.value, requestId: crypto.randomUUID() };
    const work = model.submit(ctx, input); render();
    try { const task = await work; if (task) { phone.value = ""; message = "原任务已创建，等待设备执行。"; } }
    catch (error) { message = error.definiteResponse ? error.message : "提交未确认，请刷新查询原请求，不要重复提交。"; }
    render(); await refresh();
  });
  doc.getElementById("userWecomRefresh")?.addEventListener("click", refresh);
  return { render, refresh };
}
