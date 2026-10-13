import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import {
  createScreenRelay,
  decodeAgentVideoPacket,
  encodeAgentVideoPacket,
  sanitizeMediaReaderGeneration,
  sanitizeScreenMetadata,
  shouldThrottleControlMessage,
  validateControlMessage
} from "./screen-relay.mjs";
import { ScreenSessionRegistry } from "./screen-sessions.mjs";

test("round-trips the session id and browser video packet", () => {
  const videoPacket = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const encoded = encodeAgentVideoPacket("session-123", videoPacket);
  const decoded = decodeAgentVideoPacket(encoded);

  assert.equal(decoded.sessionId, "session-123");
  assert.deepEqual(decoded.videoPacket, videoPacket);
});

test("rejects malformed agent video packets", () => {
  assert.throws(() => decodeAgentVideoPacket(Buffer.from([1, 20, 1, 2])), /invalid_screen_video_packet/);
});

test("rejects a duplicate Agent relay without disconnecting the active relay", async (t) => {
  const server = createServer();
  const registry = new ScreenSessionRegistry();
  const warnings = [];
  const relay = createScreenRelay({
    server,
    registry,
    authenticateAgent() {},
    logger: { error() {}, warn(message, details) { warnings.push([message, details]); } }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const first = new WebSocket(`ws://127.0.0.1:${port}/api/v1/windows-agents/agent-1/screen-relay`);
  const second = new WebSocket(`ws://127.0.0.1:${port}/api/v1/windows-agents/agent-1/screen-relay`);
  t.after(async () => {
    first.terminate();
    second.terminate();
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await waitForOpen(first);
  const close = await waitForClose(second);
  assert.equal(close.code, 1013);
  assert.equal(close.reason, "agent_already_connected");
  assert.equal(first.readyState, WebSocket.OPEN);

  const created = registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });
  assert.equal(relay.start(created.session), true);
  assert.equal((await waitForJson(first, (message) => message.type === "screen_start")).sessionId, created.session.sessionId);
  assert.deepEqual(warnings, [["screen relay duplicate agent rejected", { agentId: "agent-1" }]]);
});

test("preserves the numeric scrcpy codec id for the browser decoder", () => {
  assert.equal(sanitizeScreenMetadata({ codec: 1748121140 }).codec, 1748121140);
});

test("accepts a wakeup key control message", () => {
  assert.deepEqual(validateControlMessage({ type: "key", key: "wakeup", sequenceId: 9 }), { type: "key", key: "wakeup", sequenceId: 9 });
});

test("accepts bounded WHEP reader generations", () => {
  assert.equal(sanitizeMediaReaderGeneration(1), 1);
  assert.equal(sanitizeMediaReaderGeneration("3"), 3);
  assert.throws(() => sanitizeMediaReaderGeneration(0), /invalid_screen_media_reader_generation/);
  assert.throws(() => sanitizeMediaReaderGeneration(Number.MAX_SAFE_INTEGER), /invalid_screen_media_reader_generation/);
});

test("accepts explicit text plus direct keyboard edit controls", () => {
  assert.deepEqual(
    validateControlMessage({ type: "text", text: "你好 Phone Cloud 123", sequenceId: 10 }),
    { type: "text", text: "你好 Phone Cloud 123", sequenceId: 10 }
  );
  assert.deepEqual(validateControlMessage({ type: "key", key: "enter", sequenceId: 11 }), { type: "key", key: "enter", sequenceId: 11 });
  assert.deepEqual(validateControlMessage({ type: "key", key: "delete", sequenceId: 12 }), { type: "key", key: "delete", sequenceId: 12 });
  assert.deepEqual(validateControlMessage({ type: "key", key: "forward_delete", sequenceId: 13 }), { type: "key", key: "forward_delete", sequenceId: 13 });
  assert.deepEqual(validateControlMessage({ type: "key", key: "select_all", sequenceId: 14 }), { type: "key", key: "select_all", sequenceId: 14 });
  assert.deepEqual(validateControlMessage({ type: "key", key: "clear", sequenceId: 15 }), { type: "key", key: "clear", sequenceId: 15 });
});

test("rejects unsafe or oversized screen text", () => {
  assert.throws(() => validateControlMessage({ type: "text", text: "", sequenceId: 1 }), /invalid_screen_text/);
  assert.throws(() => validateControlMessage({ type: "text", text: "a\0b", sequenceId: 1 }), /invalid_screen_text/);
  assert.throws(() => validateControlMessage({ type: "text", text: "a".repeat(1001), sequenceId: 1 }), /invalid_screen_text/);
});

test("rate limiting only coalesces move events and preserves touch boundaries", () => {
  assert.equal(shouldThrottleControlMessage({ type: "touch", action: "move" }, 121), true);
  assert.equal(shouldThrottleControlMessage({ type: "touch", action: "down" }, 121), false);
  assert.equal(shouldThrottleControlMessage({ type: "touch", action: "up" }, 121), false);
  assert.equal(shouldThrottleControlMessage({ type: "touch", action: "cancel" }, 121), false);
  assert.equal(shouldThrottleControlMessage({ type: "key", key: "home" }, 121), false);
});

test("relays an authorized Agent control acknowledgement to the browser", async (t) => {
  const server = createServer();
  const registry = new ScreenSessionRegistry();
  const metricCalls = [];
  const relay = createScreenRelay({
    server,
    registry,
    authenticateAgent() {},
    logger: { error() {} },
    metrics: {
      sessionStarted(session) { metricCalls.push(["sessionStarted", session.sessionId]); },
      sessionClosed(sessionId, reason) { metricCalls.push(["sessionClosed", sessionId, reason]); },
      controlForwarded(sessionId, sequenceId) { metricCalls.push(["controlForwarded", sessionId, sequenceId]); },
      controlAcknowledged(sessionId, sequenceId, elapsedMs) { metricCalls.push(["controlAcknowledged", sessionId, sequenceId, elapsedMs]); },
      videoForwarded(sessionId, bytes, dropped) { metricCalls.push(["videoForwarded", sessionId, bytes, dropped]); }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const agent = new WebSocket(`ws://127.0.0.1:${port}/api/v1/windows-agents/agent-1/screen-relay`);
  t.after(async () => {
    agent.terminate();
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(agent);
  const created = registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });
  relay.start(created.session);
  await waitForJson(agent, (message) => message.type === "screen_start");
  const browser = new WebSocket(`ws://127.0.0.1:${port}/api/v1/screen-sessions/${created.session.sessionId}/stream?token=${encodeURIComponent(created.browserToken)}`);
  t.after(() => browser.terminate());
  await waitForOpen(browser);

  browser.send(JSON.stringify({
    type: "touch", action: "down", pointerId: 1, x: 10, y: 20,
    videoWidth: 720, videoHeight: 1600, sequenceId: 42
  }));
  const command = await waitForJson(agent, (message) => message.type === "screen_control");
  assert.equal(command.control.sequenceId, 42);
  agent.send(JSON.stringify({
    type: "screen_control_ack", sessionId: created.session.sessionId,
    sequenceId: 42, status: "injected", action: "down", agentElapsedMs: 3
  }));

  const acknowledgement = await waitForJson(browser, (message) => message.type === "screen_control_ack");
  assert.deepEqual(acknowledgement, {
    type: "screen_control_ack", sequenceId: 42, status: "injected", action: "down", agentElapsedMs: 3
  });
  const videoPacket = Buffer.concat([Buffer.from([1, 1]), Buffer.alloc(8), Buffer.from([4, 5, 6])]);
  agent.send(encodeAgentVideoPacket(created.session.sessionId, videoPacket));
  await waitForBinaryPackets(browser, 1);
  relay.stop(created.session.sessionId, "test_complete");

  assert.deepEqual(metricCalls, [
    ["sessionStarted", created.session.sessionId],
    ["controlForwarded", created.session.sessionId, 42],
    ["controlAcknowledged", created.session.sessionId, 42, 3],
    ["videoForwarded", created.session.sessionId, videoPacket.length, false],
    ["sessionClosed", created.session.sessionId, "test_complete"]
  ]);
});

test("replays codec configuration and keyframe when the browser connects late", async (t) => {
  const server = createServer();
  const registry = new ScreenSessionRegistry();
  const relay = createScreenRelay({ server, registry, authenticateAgent() {}, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const agent = new WebSocket(`ws://127.0.0.1:${port}/api/v1/windows-agents/agent-1/screen-relay`);
  t.after(async () => {
    agent.terminate();
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(agent);
  const created = registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });
  assert.equal(relay.start(created.session), true);
  const startMessage = await waitForJson(agent, (message) => message.type === "screen_start");
  assert.deepEqual(startMessage.options, { profile: "realtime", maxSize: 1600, maxFps: 60, videoBitRate: 8_000_000 });

  const configuration = Buffer.concat([Buffer.from([0, 0]), Buffer.alloc(8), Buffer.from([1, 2, 3])]);
  const keyframe = Buffer.concat([Buffer.from([1, 1]), Buffer.alloc(8), Buffer.from([4, 5, 6])]);
  agent.send(encodeAgentVideoPacket(created.session.sessionId, configuration));
  agent.send(encodeAgentVideoPacket(created.session.sessionId, keyframe));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const browser = new WebSocket(`ws://127.0.0.1:${port}/api/v1/screen-sessions/${created.session.sessionId}/stream?token=${encodeURIComponent(created.browserToken)}`);
  t.after(() => browser.terminate());
  const packets = await waitForBinaryPackets(browser, 2);
  assert.deepEqual(packets, [configuration, keyframe]);
});

test("forwards an explicit high quality profile to the Agent", async (t) => {
  const server = createServer();
  const registry = new ScreenSessionRegistry();
  const relay = createScreenRelay({ server, registry, authenticateAgent() {}, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const agent = new WebSocket(`ws://127.0.0.1:${port}/api/v1/windows-agents/agent-1/screen-relay`);
  t.after(async () => {
    agent.terminate();
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(agent);

  const created = registry.create({
    deviceId: "device-1",
    agentId: "agent-1",
    adbSerial: "serial-1",
    userId: "user-1",
    requestedQualityProfile: "high"
  });
  assert.equal(relay.start(created.session), true);
  const startMessage = await waitForJson(agent, (message) => message.type === "screen_start");
  assert.deepEqual(startMessage.options, {
    profile: "high",
    maxSize: 1600,
    maxFps: 60,
    videoBitRate: 8_000_000
  });
});

test("isolates Agent video, browser video, and browser control sockets", async (t) => {
  const server = createServer();
  const registry = new ScreenSessionRegistry();
  const relay = createScreenRelay({ server, registry, authenticateAgent() {}, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const agent = new WebSocket(`ws://127.0.0.1:${port}/api/v1/windows-agents/agent-1/screen-relay`);
  t.after(async () => {
    agent.terminate();
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(agent);
  agent.send(JSON.stringify({ type: "screen_capabilities", transports: ["multiplexed", "split-v1"] }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const created = registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });
  assert.equal(relay.start(created.session), true);
  const start = await waitForJson(agent, (message) => message.type === "screen_start");
  assert.equal(start.transportMode, "split-v1");

  const token = encodeURIComponent(created.browserToken);
  const control = new WebSocket(`ws://127.0.0.1:${port}/realtime/v1/sessions/${created.session.sessionId}/control?token=${token}`);
  const video = new WebSocket(`ws://127.0.0.1:${port}/realtime/v1/sessions/${created.session.sessionId}/video?token=${token}`);
  const publisher = new WebSocket(`ws://127.0.0.1:${port}/realtime/v1/sessions/${created.session.sessionId}/video-publish?agentId=agent-1`);
  t.after(() => { control.terminate(); video.terminate(); publisher.terminate(); });
  await Promise.all([waitForOpen(control), waitForOpen(video), waitForOpen(publisher)]);

  control.send(JSON.stringify({ type: "key", key: "home", sequenceId: 7 }));
  const command = await waitForJson(agent, (message) => message.type === "screen_control");
  assert.equal(command.control.sequenceId, 7);
  agent.send(JSON.stringify({
    type: "screen_control_ack", sessionId: created.session.sessionId,
    sequenceId: 7, status: "injected", action: "home", agentElapsedMs: 2
  }));
  assert.equal((await waitForJson(control, (message) => message.type === "screen_control_ack")).sequenceId, 7);

  const packet = Buffer.concat([Buffer.from([1, 1]), Buffer.alloc(8), Buffer.from([9, 8, 7])]);
  publisher.send(packet);
  assert.deepEqual((await waitForBinaryPackets(video, 1))[0], packet);
});

test("collects authenticated Agent and browser playback metrics without forwarding them as controls", async (t) => {
  const server = createServer();
  const registry = new ScreenSessionRegistry();
  const reports = [];
  const relay = createScreenRelay({
    server,
    registry,
    authenticateAgent() {},
    logger: { error() {} },
    metrics: {
      agentStreamReported(sessionId, payload) { reports.push(["agent", sessionId, payload]); },
      browserPlaybackReported(sessionId, payload) { reports.push(["browser", sessionId, payload]); }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const agent = new WebSocket(`ws://127.0.0.1:${port}/api/v1/windows-agents/agent-1/screen-relay`);
  t.after(async () => {
    agent.terminate();
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(agent);
  const created = registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });
  relay.start(created.session);
  await waitForJson(agent, (message) => message.type === "screen_start");

  agent.send(JSON.stringify({
    type: "screen_stream_metrics",
    sessionId: created.session.sessionId,
    metrics: { fps: 30, megabitsPerSecond: 3, droppedFrames: 2 }
  }));
  const browser = new WebSocket(`ws://127.0.0.1:${port}/api/v1/screen-sessions/${created.session.sessionId}/stream?token=${encodeURIComponent(created.browserToken)}`);
  t.after(() => browser.terminate());
  await waitForOpen(browser);
  browser.send(JSON.stringify({
    type: "screen_playback_metrics",
    metrics: {
      fps: 29, dropped: 1, bufferSeconds: 0.08,
      rtcFramesPerSecond: 27, rtcPacketsLost: 2, rtcJitterMs: 14, rtcDecodeMsPerFrame: 3
    }
  }));
  browser.send(JSON.stringify({ type: "screen_media_reader_ready", generation: 2 }));
  assert.deepEqual(
    await waitForJson(agent, (message) => message.type === "screen_media_reader_ready"),
    {
      type: "screen_media_reader_ready",
      sessionId: created.session.sessionId,
      generation: 2
    }
  );

  await waitFor(() => reports.length === 2);
  assert.deepEqual(reports, [
    ["agent", created.session.sessionId, {
      fps: 30, megabitsPerSecond: 3, droppedFrames: 2,
      relayBufferedBytes: 0, width: 0, height: 0
    }],
    ["browser", created.session.sessionId, {
      fps: 29, decoded: 0, dropped: 1, presented: 0,
      bufferSeconds: 0.08, controlRttMs: 0, agentControlMs: 0,
      rtcFramesPerSecond: 27, rtcPacketsLost: 2, rtcJitterMs: 14, rtcDecodeMsPerFrame: 3
    }]
  ]);
});

test("relays direct WebRTC offer and answer without a media server URL", async (t) => {
  const server = createServer();
  const registry = new ScreenSessionRegistry();
  const relay = createScreenRelay({
    server,
    registry,
    authenticateAgent() {},
    buildMediaStart: () => ({ mode: "direct_webrtc" }),
    logger: { error() {} }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const agentRelay = new WebSocket(`ws://127.0.0.1:${port}/api/v1/windows-agents/agent-1/screen-relay`);
  t.after(async () => {
    agentRelay.terminate();
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(agentRelay);
  agentRelay.send(JSON.stringify({
    type: "screen_capabilities",
    transports: ["multiplexed", "split-v1"],
    mediaTransports: ["webrtc-direct-v1"],
    maxSize: 1920,
    maxFps: 60,
    maxVideoBitRate: 12,
    maxConcurrentSessions: 1
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const created = registry.create({
    deviceId: "device-1",
    agentId: "agent-1",
    adbSerial: "serial-1",
    userId: "user-1",
    mediaTransport: "direct_webrtc"
  });
  assert.equal(relay.start(created.session), true);
  await waitForJson(agentRelay, (message) => message.type === "screen_start");

  const directAgent = new WebSocket(`ws://127.0.0.1:${port}/realtime/v1/sessions/${created.session.sessionId}/direct-webrtc?role=agent&agentId=agent-1`);
  const directBrowser = new WebSocket(
    `ws://127.0.0.1:${port}/realtime/v1/sessions/${created.session.sessionId}/direct-webrtc?role=browser`,
    [created.browserToken]
  );
  t.after(() => {
    directAgent.terminate();
    directBrowser.terminate();
  });
  await Promise.all([waitForOpen(directAgent), waitForOpen(directBrowser)]);
  const agentOffer = waitForJson(directAgent, (message) => message.type === "offer");
  directBrowser.send(JSON.stringify({ type: "offer", sdp: "v=0\r\n" }));
  assert.equal((await agentOffer).sdp, "v=0\r\n");
  const browserAnswer = waitForJson(directBrowser, (message) => message.type === "answer");
  directAgent.send(JSON.stringify({ type: "answer", sdp: "v=0\r\n" }));
  assert.equal((await browserAnswer).sdp, "v=0\r\n");
  directBrowser.close();
  await waitFor(() => registry.get(created.session.sessionId)?.status === "closed");
});

function waitForOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket_close_timeout")), timeoutMs);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForJson(socket, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("json_message_timeout")), timeoutMs);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString("utf8"));
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function waitForBinaryPackets(socket, count, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const packets = [];
    const timer = setTimeout(() => reject(new Error("binary_message_timeout")), timeoutMs);
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      packets.push(Buffer.from(data));
      if (packets.length < count) return;
      clearTimeout(timer);
      resolve(packets);
    });
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
