import { ScrcpyVideoCodecId } from "@yume-chan/scrcpy";
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder
} from "@yume-chan/scrcpy-decoder-webcodecs";

const elements = {
  canvas: document.querySelector("#screen"),
  connect: document.querySelector("#connect"),
  device: document.querySelector("#device"),
  disconnect: document.querySelector("#disconnect"),
  empty: document.querySelector("#empty"),
  status: document.querySelector("#status")
};

let socket;
let decoder;
let decoderWriter;
let renderer;
let writeQueue = Promise.resolve();
let failureMessage = "";

function setStatus(state, text) {
  elements.status.dataset.state = state;
  elements.status.textContent = text;
}

async function loadDevices() {
  setStatus("preparing", "正在检查 ADB 设备");
  const response = await fetch("/api/devices", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "设备读取失败");
  elements.device.replaceChildren();
  for (const item of payload.devices) {
    const option = document.createElement("option");
    option.value = item.serial;
    option.textContent = `${item.model} · ${item.serial}`;
    if (item.serial === payload.preferredSerial) option.selected = true;
    elements.device.append(option);
  }
  if (!payload.devices.length) {
    setStatus("failed", "没有已授权的 ADB 手机");
    elements.connect.disabled = true;
  } else {
    setStatus("idle", `已发现 ${payload.devices.length} 台手机`);
  }
}

function decodePacket(buffer) {
  const view = new DataView(buffer);
  const type = view.getUint8(0);
  const keyframe = view.getUint8(1) === 1;
  const pts = view.getBigInt64(2, false);
  const data = new Uint8Array(buffer, 10);
  if (type === 0) return { type: "configuration", data };
  return { type: "data", keyframe, pts: pts === -1n ? undefined : pts, data };
}

function setupDecoder(codec) {
  renderer = new BitmapVideoFrameRenderer(elements.canvas);
  decoder = new WebCodecsVideoDecoder({
    codec: codec || ScrcpyVideoCodecId.H264,
    renderer,
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true
  });
  decoderWriter = decoder.writable.getWriter();
}

function connect() {
  const serial = elements.device.value;
  if (!serial || socket) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/stream?serial=${encodeURIComponent(serial)}`);
  socket.binaryType = "arraybuffer";
  elements.connect.disabled = true;
  elements.disconnect.disabled = false;
  failureMessage = "";
  setStatus("preparing", "正在创建视频通道");

  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      if (message.type === "status") {
        setStatus(message.status, message.detail || message.status);
        if (message.status === "failed") failureMessage = message.detail || "会话失败";
        if (message.status === "live") elements.empty.hidden = true;
      } else if (message.type === "metadata") {
        setupDecoder(message.codec);
      }
      return;
    }
    if (!decoderWriter) return;
    const packet = decodePacket(event.data);
    writeQueue = writeQueue.then(() => decoderWriter.write(packet)).catch((error) => {
      setStatus("failed", `解码失败：${error.message}`);
    });
  };
  socket.onerror = () => setStatus("failed", "WebSocket 连接失败");
  socket.onclose = () => cleanup(failureMessage || "会话已结束");
}

function cleanup(message = "等待连接") {
  socket = undefined;
  try { decoderWriter?.releaseLock(); } catch {}
  decoderWriter = undefined;
  decoder?.dispose();
  decoder = undefined;
  renderer = undefined;
  elements.empty.hidden = false;
  elements.connect.disabled = elements.device.options.length === 0;
  elements.disconnect.disabled = true;
  setStatus(failureMessage ? "failed" : "idle", message);
}

function disconnect() {
  socket?.close(1000, "user_closed");
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function pointerPosition(event) {
  const rect = elements.canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * elements.canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * elements.canvas.height,
    videoWidth: elements.canvas.width,
    videoHeight: elements.canvas.height
  };
}

elements.canvas.addEventListener("pointerdown", (event) => {
  elements.canvas.setPointerCapture(event.pointerId);
  send({ type: "touch", action: "down", pointerId: event.pointerId, ...pointerPosition(event) });
});
elements.canvas.addEventListener("pointermove", (event) => {
  if (!elements.canvas.hasPointerCapture(event.pointerId)) return;
  send({ type: "touch", action: "move", pointerId: event.pointerId, ...pointerPosition(event) });
});
for (const type of ["pointerup", "pointercancel"]) {
  elements.canvas.addEventListener(type, (event) => {
    send({ type: "touch", action: type === "pointerup" ? "up" : "cancel", pointerId: event.pointerId, ...pointerPosition(event) });
    if (elements.canvas.hasPointerCapture(event.pointerId)) elements.canvas.releasePointerCapture(event.pointerId);
  });
}

document.querySelectorAll("[data-key]").forEach((button) => {
  button.addEventListener("click", () => send({ type: "key", key: button.dataset.key }));
});
elements.connect.addEventListener("click", connect);
elements.disconnect.addEventListener("click", disconnect);
window.addEventListener("beforeunload", disconnect);

loadDevices().catch((error) => setStatus("failed", error.message));
