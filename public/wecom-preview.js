import { wecomStatusLabel } from "./wecom-automation-ui.js?v=20261028-remarks-rc4";
const root = "/api/v1/user/automation";
const form = document.querySelector("#previewForm");
const devices = document.querySelector("#device");
const submit = document.querySelector("#submit");
const feedback = document.querySelector("#feedback");
const history = document.querySelector("#history");
const appSlot = document.querySelector("#appSlot");
let inventoryRows = [];
let slotDevice = "";
function renderSlots() {
  const device = inventoryRows.find(d => d.deviceId === devices.value);
  const selected = slotDevice === devices.value ? appSlot.value : device?.appSlot;
  slotDevice = devices.value;
  appSlot.replaceChildren();
  for (const target of device?.appSlots || []) {
    const option = text("option", target.appSlot === "clone" ? "分身" : "主应用"); option.value = target.appSlot; appSlot.append(option);
  }
  if ([...appSlot.options].some(o => o.value === selected)) appSlot.value = selected;
}
let requestInFlight = false;
let accepted = null;
let unresolved = null;

async function api(path, data) {
  const token = localStorage.getItem("phoneCloudSessionToken");
  if (!token) throw new Error("请先返回平台登录管理员账号");
  const response = await fetch(root + path, {
    method: data ? "POST" : "GET", credentials: "same-origin", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15000)
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || "请求失败"), { definiteResponse: response.status < 500 });
  return body;
}

function text(tag, value) { const element = document.createElement(tag); element.textContent = value; return element; }

async function refresh() {
  const [inventory, list] = await Promise.all([api("/wecom-preview-devices"), api("/wecom-preview-tasks")]);
  const selected = devices.value;
  inventoryRows = inventory.devices;
  devices.replaceChildren(text("option", "选择空闲手机")); devices.firstChild.value = "";
  for (const device of inventory.devices) {
    const option = text("option", `${device.deviceNumber}号${device.androidUser === 999 ? " · 分身" : ""} · ${device.available ? "可用" : "占用或离线"}`);
    option.value = device.deviceId; option.disabled = !device.available; devices.append(option);
  }
  devices.value = selected;
  renderSlots();
  history.replaceChildren();
  if (!list.tasks.length) history.append(text("p", "暂无预览任务"));
  for (const task of list.tasks) {
    const row = document.createElement("article"); row.className = "wecom-preview-task";
    row.append(text("b", `${task.deviceNumber}号 · ${task.appSlot === "clone" ? "分身" : "主应用"} · ${wecomStatusLabel(task)}`));
    row.append(text("p", task.result.code || "所有操作都停在发送前"));
    row.append(text("small", `${new Date(task.createdAt).toLocaleString()} · ${task.jobId}`)); history.append(row);
  }
  if (unresolved) {
    const found = list.tasks.find(task => task.requestId === unresolved.requestId);
    if (found) { accepted = found.jobId; unresolved = null; }
  }
  const own = accepted && list.tasks.find(task => task.jobId === accepted);
  if (own) feedback.textContent = `${own.deviceNumber}号：${wecomStatusLabel(own)}${own.result.code ? `（${own.result.code}）` : ""}`;
  submit.disabled = requestInFlight || Boolean(unresolved) || Boolean(own && ["queued", "running", "stalled"].includes(own.status));
}

form.addEventListener("submit", async event => {
  event.preventDefault(); if (requestInFlight || unresolved) return;
  requestInFlight = true; submit.disabled = true;
  const input = { remarkName: document.querySelector("#remarkName").value, description: document.querySelector("#description").value, deviceId: devices.value, appSlot: appSlot.value, phoneNumber: document.querySelector("#phone").value, requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("") };
  feedback.textContent = "正在提交…";
  try { const body = await api("/wecom-preview-tasks", input); accepted = body.task.jobId; }
  catch (error) {
    if (!error.definiteResponse) { unresolved = input; feedback.textContent = "提交结果暂未确认，正在查找原任务。请勿重新提交。"; }
    else feedback.textContent = error.message;
  } finally { requestInFlight = false; }
  try { await refresh(); } catch (error) { feedback.textContent = error.message; }
});
document.querySelector("#refresh").addEventListener("click", () => refresh().catch(error => { feedback.textContent = error.message; }));
devices.addEventListener("change", renderSlots);
await refresh().catch(error => { feedback.textContent = error.message; });
setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 5000);
