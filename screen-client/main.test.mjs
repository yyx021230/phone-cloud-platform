import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

globalThis.window = globalThis.window || {};
const { createPlaybackMetricsReporter, liveScreenPlaybackStatus, normalizeScreenPlayerMedia } = await import("./main.js");
const screenClientSource = await readFile(new URL("./main.js", import.meta.url), "utf8");

test("passes the browser token into the direct WebRTC player", () => {
  assert.deepEqual(normalizeScreenPlayerMedia({
    mode: "direct_webrtc",
    signalUrl: "ws://example.test/direct-webrtc",
    iceServers: []
  }, "pcs_browser-token"), {
    mode: "direct_webrtc",
    signalUrl: "ws://example.test/direct-webrtc",
    iceServers: [],
    token: "pcs_browser-token"
  });
});

test("does not downgrade a rendered WebRTC screen when the delayed live status arrives", () => {
  assert.deepEqual(liveScreenPlaybackStatus(true), {
    status: "live",
    detail: "实时画面已连接"
  });
  assert.deepEqual(liveScreenPlaybackStatus(false), {
    status: "preparing",
    detail: "执行器已连接，正在等待手机首帧"
  });
});

test("starts WHEP only after the Agent reports a media-ready live status", () => {
  assert.match(screenClientSource, /if \(this\.media\.mode === "direct_webrtc"\) this\.setupPlayer\("h264"\)/);
  assert.match(screenClientSource, /if \(this\.media\.mode === "webrtc" && !this\.player\) this\.setupPlayer\("h264"\)/);
});

test("announces each established WHEP reader generation to the Agent", () => {
  assert.match(screenClientSource, /onReaderReady:\s*\(\)\s*=>/);
  assert.match(screenClientSource, /type:\s*"screen_media_reader_ready"/);
  assert.match(screenClientSource, /generation:\s*this\.mediaReaderGeneration/);
});

test("reports browser playback measurements at a bounded cadence", () => {
  let now = 1_000;
  const sent = [];
  const reporter = createPlaybackMetricsReporter({
    now: () => now,
    send: (message) => sent.push(message),
    intervalMs: 5_000
  });
  const metrics = {
    fps: 28.4,
    decoded: 300,
    dropped: 3,
    presented: 297,
    bufferSeconds: 0.12,
    controlRttMs: 81,
    agentControlMs: 6
  };

  assert.equal(reporter.report(metrics), true);
  now += 4_999;
  assert.equal(reporter.report(metrics), false);
  now += 1;
  assert.equal(reporter.report(metrics), true);

  assert.deepEqual(sent, [
    { type: "screen_playback_metrics", metrics },
    { type: "screen_playback_metrics", metrics }
  ]);
});

test("resets the cadence when a screen session ends", () => {
  let now = 1_000;
  const sent = [];
  const reporter = createPlaybackMetricsReporter({ now: () => now, send: (message) => sent.push(message) });

  reporter.report({ fps: 30 });
  reporter.reset();
  assert.equal(reporter.report({ fps: 30 }), true);
  assert.equal(sent.length, 2);
});
