import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SESSION_SETTINGS, createMjpegMetrics, mapPointToDevice, parseControlPayload } from "./bridge.mjs";

test("maps a displayed MJPEG point to the iPhone viewport", () => {
  const point = mapPointToDevice({
    clientX: 210,
    clientY: 420,
    rect: { left: 10, top: 20, width: 400, height: 800 },
    deviceSize: { width: 390, height: 844 },
  });

  assert.deepEqual(point, { x: 195, y: 422 });
});

test("clamps pointer coordinates inside the iPhone viewport", () => {
  const point = mapPointToDevice({
    clientX: -20,
    clientY: 2000,
    rect: { left: 0, top: 0, width: 390, height: 844 },
    deviceSize: { width: 390, height: 844 },
  });

  assert.deepEqual(point, { x: 0, y: 843 });
});

test("accepts only bounded explicit text input", () => {
  assert.deepEqual(parseControlPayload({ type: "text", text: "Phone Cloud" }), {
    type: "text",
    text: "Phone Cloud",
  });
  assert.throws(() => parseControlPayload({ type: "text", text: "" }), /invalid_text/);
  assert.throws(() => parseControlPayload({ type: "text", text: "a".repeat(513) }), /invalid_text/);
});

test("uses the verified local WDA defaults instead of resetting to 20 FPS", () => {
  assert.deepEqual(DEFAULT_SESSION_SETTINGS, {
    mjpegServerFramerate: 45,
    mjpegServerScreenshotQuality: 60,
    mjpegScalingFactor: 100,
    waitForIdleTimeout: 0.5,
  });
});

test("reports MJPEG FPS from a recent window rather than the full session history", () => {
  const metrics = createMjpegMetrics(1_000);
  metrics.recordFrame(0);
  metrics.recordFrame(100);
  metrics.recordFrame(200);
  assert.equal(metrics.fpsAt(200), 3);

  for (let timestamp = 2_000; timestamp <= 9_000; timestamp += 1_000) metrics.recordFrame(timestamp);
  assert.equal(metrics.fpsAt(9_000), 2);
});
