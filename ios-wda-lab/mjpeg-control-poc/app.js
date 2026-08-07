import { mapPointToDevice } from "./bridge.mjs";

const state = { connected: false, viewport: null, pointer: null, metricsTimer: null };
const stream = document.querySelector("#stream");
const stage = document.querySelector("#stage");
const loading = document.querySelector("#loading");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const sendTextButton = document.querySelector("#sendText");

connectButton.addEventListener("click", connect);
disconnectButton.addEventListener("click", disconnect);
sendTextButton.addEventListener("click", sendText);
stage.addEventListener("pointerdown", (event) => {
  if (!state.connected || event.target !== stream) return;
  state.pointer = { clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp };
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointerup", async (event) => {
  if (!state.connected || !state.pointer) return;
  const start = map(eventFrom(state.pointer));
  const end = map(eventFrom(event));
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const durationMs = Math.max(120, Math.min(700, event.timeStamp - state.pointer.timeStamp));
  state.pointer = null;
  try {
    const body = distance < 12
      ? { type: "tap", point: end }
      : { type: "swipe", start, end, durationMs };
    await control(body);
  } catch (error) {
    setState("error", error.message);
  }
});

async function connect() {
  try {
    setState("connecting", "正在连接 iPhone…");
    const result = await api("/api/connect", {});
    state.connected = true;
    state.viewport = result.viewport;
    stream.src = `/mjpeg?at=${Date.now()}`;
    loading.hidden = true;
    document.querySelector("#viewport").textContent = `${result.viewport.width} × ${result.viewport.height}`;
    connectButton.disabled = true;
    disconnectButton.disabled = false;
    sendTextButton.disabled = false;
    setState("live", "已连接");
    startMetrics();
  } catch (error) {
    setState("error", error.message);
  }
}

async function disconnect() {
  await api("/api/disconnect", {});
  state.connected = false;
  stopMetrics();
  stream.removeAttribute("src");
  loading.hidden = false;
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  sendTextButton.disabled = true;
  setState("idle", "未连接");
}

function startMetrics() {
  stopMetrics();
  const update = async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      const status = await response.json();
      document.querySelector("#fps").textContent = `${status.mjpeg.fps.toFixed(1)}`;
    } catch {
      // The connection badge remains the user-facing failure indicator.
    }
  };
  update();
  state.metricsTimer = window.setInterval(update, 1_000);
}

function stopMetrics() {
  if (state.metricsTimer) window.clearInterval(state.metricsTimer);
  state.metricsTimer = null;
  document.querySelector("#fps").textContent = "-";
}

async function sendText() {
  const text = document.querySelector("#text").value;
  if (!text) return;
  try {
    await control({ type: "text", text });
  } catch (error) {
    setState("error", error.message);
  }
}

async function control(body) {
  const startedAt = performance.now();
  const endpoint = body.type === "tap" ? "/api/tap" : body.type === "swipe" ? "/api/swipe" : "/api/text";
  await api(endpoint, body);
  document.querySelector("#latency").textContent = `${Math.round(performance.now() - startedAt)} ms`;
}

function map(event) {
  return mapPointToDevice({ clientX: event.clientX, clientY: event.clientY, rect: stream.getBoundingClientRect(), deviceSize: state.viewport });
}

function eventFrom(event) {
  return { clientX: event.clientX, clientY: event.clientY };
}

async function api(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}

function setState(kind, label) {
  document.querySelector("#connectionState").dataset.state = kind;
  document.querySelector("#connectionState").textContent = label;
  stage.dataset.state = kind;
}
