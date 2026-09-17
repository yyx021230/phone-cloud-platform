import assert from "node:assert/strict";
import test from "node:test";

import { createControlInput } from "./control-input.js";

function createHarness({ rect = { left: 0, top: 0, width: 360, height: 800 } } = {}) {
  const listeners = new Map();
  const sent = [];
  const frames = [];
  let focusCalls = 0;
  const keyboardListeners = new Map();
  const video = {
    videoWidth: 720,
    videoHeight: 1600,
    getBoundingClientRect: () => rect,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() { return true; },
    focus() { focusCalls += 1; }
  };
  const keyboardTarget = {
    value: "",
    addEventListener(name, handler) { keyboardListeners.set(name, handler); },
    removeEventListener(name) { keyboardListeners.delete(name); },
    focus() { focusCalls += 1; }
  };
  const input = createControlInput({
    video,
    keyboardTarget,
    send(message) { sent.push(message); },
    requestFrame(handler) { frames.push(handler); return frames.length; },
    cancelFrame() {}
  });
  const emit = (name, values = {}) => (keyboardListeners.get(name) || listeners.get(name))?.({
    type: name,
    pointerId: 7,
    clientX: 100,
    clientY: 200,
    preventDefault() {},
    ...values
  });
  return { input, video, keyboardTarget, sent, frames, emit, get focusCalls() { return focusCalls; } };
}

test("coalesces pointer moves to the latest position in one animation frame", () => {
  const { sent, frames, emit } = createHarness();
  emit("pointerdown");
  emit("pointermove", { clientX: 110 });
  emit("pointermove", { clientX: 120 });
  emit("pointermove", { clientX: 130 });

  assert.equal(sent.length, 1);
  assert.equal(frames.length, 1);
  frames[0]();

  assert.equal(sent.length, 2);
  assert.equal(sent[1].action, "move");
  assert.equal(sent[1].sequenceId, 2);
  assert.equal(sent[1].x, 260);
});

test("flushes the latest move before pointer up", () => {
  const { sent, emit } = createHarness();
  emit("pointerdown");
  emit("pointermove", { clientX: 120 });
  emit("pointermove", { clientX: 140 });
  emit("pointerup", { clientX: 150 });

  assert.deepEqual(sent.map((message) => [message.action, message.sequenceId]), [
    ["down", 1],
    ["move", 2],
    ["up", 3]
  ]);
  assert.equal(sent[1].x, 280);
});

test("ignores pointer down in letterbox space", () => {
  const { sent, emit } = createHarness({ rect: { left: 0, top: 0, width: 400, height: 800 } });
  emit("pointerdown", { clientX: 10, clientY: 400 });
  assert.deepEqual(sent, []);
});

test("clamps coordinates to the last valid video pixel", () => {
  const { sent, emit } = createHarness();
  emit("pointerdown", { clientX: 360, clientY: 800 });
  assert.equal(sent[0].x, 719);
  assert.equal(sent[0].y, 1599);
});

test("uses the executor-confirmed encoded size when WebRTC metadata is stale", () => {
  const { input, sent, emit } = createHarness();
  input.setSourceSize(568, 1280);
  emit("pointerdown", { clientX: 180, clientY: 400 });
  assert.deepEqual(sent[0], {
    type: "touch",
    action: "down",
    pointerId: 7,
    x: 284,
    y: 640,
    videoWidth: 568,
    videoHeight: 1280,
    sequenceId: 1
  });
});

test("sends explicit text and keys with monotonic sequence ids", () => {
  const { input, sent, emit } = createHarness();
  emit("pointerdown");
  input.text("你好 Phone Cloud 123");
  input.key("enter");

  assert.deepEqual(sent.slice(1), [
    { type: "text", text: "你好 Phone Cloud 123", sequenceId: 2 },
    { type: "key", key: "enter", sequenceId: 3 }
  ]);
});

test("focuses the phone surface and forwards direct keyboard text controls", () => {
  const harness = createHarness();
  const { sent, emit, keyboardTarget } = harness;
  const prevented = [];
  const emitKey = (key, values = {}) => emit("keydown", {
    key,
    preventDefault() { prevented.push(key); },
    ...values
  });

  emit("pointerdown");
  emitKey("a");
  keyboardTarget.value = "a";
  emit("input", { data: "a" });
  emitKey("Backspace");
  emitKey("Delete");
  emitKey("Enter");
  emitKey("a", { ctrlKey: true });
  emit("compositionstart");
  keyboardTarget.value = "你好";
  emit("input", { data: "你" });
  emit("compositionend", { data: "你好" });
  let pastePrevented = false;
  emit("paste", {
    clipboardData: { getData(type) { return type === "text/plain" ? "从电脑剪贴板粘贴" : ""; } },
    preventDefault() { pastePrevented = true; }
  });
  emitKey("r", { ctrlKey: true });

  assert.equal(harness.focusCalls, 1);
  assert.deepEqual(sent.slice(1), [
    { type: "text", text: "a", sequenceId: 2 },
    { type: "key", key: "delete", sequenceId: 3 },
    { type: "key", key: "forward_delete", sequenceId: 4 },
    { type: "key", key: "enter", sequenceId: 5 },
    { type: "key", key: "select_all", sequenceId: 6 },
    { type: "text", text: "你好", sequenceId: 7 },
    { type: "text", text: "从电脑剪贴板粘贴", sequenceId: 8 }
  ]);
  assert.equal(pastePrevented, true);
  assert.deepEqual(prevented, ["Backspace", "Delete", "Enter", "a"]);
});

test("splits a large clipboard text control without splitting a surrogate pair", () => {
  const { input, sent } = createHarness();
  input.text(`${"a".repeat(999)}😀b`);
  assert.deepEqual(sent.map((message) => message.text), [`${"a".repeat(999)}`, "😀b"]);
  assert.deepEqual(sent.map((message) => message.sequenceId), [1, 2]);
});
