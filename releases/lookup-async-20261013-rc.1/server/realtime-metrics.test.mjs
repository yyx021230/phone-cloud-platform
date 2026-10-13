import assert from "node:assert/strict";
import test from "node:test";

import { createRealtimeMetrics } from "./realtime-metrics.mjs";

test("tracks bounded control latency percentiles and Agent injection time", () => {
  let now = 1_000;
  const metrics = createRealtimeMetrics({ now: () => now, sampleLimit: 3, monitorEventLoop: false });

  for (const [sequenceId, rttMs, agentElapsedMs] of [[1, 10, 1], [2, 20, 2], [3, 30, 3], [4, 40, 4]]) {
    metrics.controlForwarded("session-1", sequenceId);
    now += rttMs;
    metrics.controlAcknowledged("session-1", sequenceId, agentElapsedMs);
  }

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.control.totalForwarded, 4);
  assert.equal(snapshot.control.totalAcknowledged, 4);
  assert.equal(snapshot.control.pending, 0);
  assert.deepEqual(snapshot.control.rttMs, { p50: 30, p95: 40, p99: 40, max: 40, samples: 3 });
  assert.deepEqual(snapshot.control.agentElapsedMs, { p50: 3, p95: 4, p99: 4, max: 4, samples: 3 });
});

test("tracks active sessions and per-session video windows", () => {
  let now = 10_000;
  const metrics = createRealtimeMetrics({ now: () => now, monitorEventLoop: false });

  metrics.sessionStarted({ sessionId: "session-1", agentId: "agent-1", deviceId: "device-1" });
  metrics.videoForwarded("session-1", 500, false);
  metrics.videoForwarded("session-1", 700, true);
  now += 2_000;

  let snapshot = metrics.snapshot();
  assert.equal(snapshot.sessions.active, 1);
  assert.equal(snapshot.sessions.started, 1);
  assert.equal(snapshot.video.totalBytes, 1_200);
  assert.equal(snapshot.video.totalDroppedPackets, 1);
  assert.equal(snapshot.video.sessions[0].megabitsPerSecond, 0.005);

  metrics.sessionClosed("session-1", "user_closed");
  snapshot = metrics.snapshot();
  assert.equal(snapshot.sessions.active, 0);
  assert.equal(snapshot.sessions.closed, 1);
  assert.equal(snapshot.sessions.closeReasons.user_closed, 1);
});

test("keeps the latest bounded Agent and browser playback measurements per active session", () => {
  let now = 10_000;
  const metrics = createRealtimeMetrics({ now: () => now, monitorEventLoop: false });
  metrics.sessionStarted({ sessionId: "session-1", agentId: "agent-1", deviceId: "device-1" });

  metrics.agentStreamReported("session-1", {
    fps: 28.6,
    megabitsPerSecond: 3.72,
    droppedFrames: 4,
    relayBufferedBytes: 12_345,
    width: 720,
    height: 1_600
  });
  now += 5_000;
  metrics.browserPlaybackReported("session-1", {
    fps: 25.2,
    decoded: 181,
    dropped: 7,
    presented: 174,
    bufferSeconds: 0.14,
    controlRttMs: 82,
    agentControlMs: 6
  });

  const [session] = metrics.snapshot().video.sessions;
  assert.deepEqual(session.agent, {
    fps: 28.6,
    megabitsPerSecond: 3.72,
    droppedFrames: 4,
    bufferedBytes: 12_345,
    width: 720,
    height: 1_600,
    reportedAt: "1970-01-01T00:00:10.000Z"
  });
  assert.deepEqual(session.browser, {
    fps: 25.2,
    decoded: 181,
    dropped: 7,
    presented: 174,
    bufferMs: 140,
    controlRttMs: 82,
    agentControlMs: 6,
    reportedAt: "1970-01-01T00:00:15.000Z"
  });
});

test("retains bounded playback evidence after a session closes", () => {
  let now = 10_000;
  const metrics = createRealtimeMetrics({
    now: () => now,
    monitorEventLoop: false,
    completedSessionLimit: 1,
    sessionSampleLimit: 2
  });
  metrics.sessionStarted({ sessionId: "session-1", agentId: "agent-1", deviceId: "device-1" });
  metrics.agentStreamReported("session-1", { fps: 20, megabitsPerSecond: 2 });
  now += 5_000;
  metrics.browserPlaybackReported("session-1", { fps: 16, decoded: 80, presented: 72, dropped: 8, bufferSeconds: 0.08 });
  now += 2_000;
  metrics.sessionClosed("session-1", "user_closed");

  let snapshot = metrics.snapshot();
  assert.equal(snapshot.sessions.recent.length, 1);
  assert.equal(snapshot.sessions.recent[0].closeReason, "user_closed");
  assert.equal(snapshot.sessions.recent[0].durationMs, 7_000);
  assert.equal(snapshot.sessions.recent[0].agentSamples.length, 1);
  assert.equal(snapshot.sessions.recent[0].browserSamples.length, 1);

  metrics.sessionStarted({ sessionId: "session-2", agentId: "agent-1", deviceId: "device-2" });
  metrics.sessionClosed("session-2", "failed");
  snapshot = metrics.snapshot();
  assert.equal(snapshot.sessions.recent.length, 1);
  assert.equal(snapshot.sessions.recent[0].sessionId, "session-2");
});

test("ignores stream measurements for unknown sessions", () => {
  const metrics = createRealtimeMetrics({ monitorEventLoop: false });
  assert.equal(metrics.agentStreamReported("missing", { fps: 60 }), false);
  assert.equal(metrics.browserPlaybackReported("missing", { fps: 60 }), false);
  assert.equal(metrics.snapshot().video.sessions.length, 0);
});

test("reports persistence and event-loop delay without exposing nanoseconds", () => {
  const histogram = {
    enabled: false,
    enable() { this.enabled = true; },
    percentile(value) { return ({ 50: 2_000_000, 95: 8_000_000, 99: 14_000_000 })[value]; },
    get max() { return 20_000_000; }
  };
  const metrics = createRealtimeMetrics({
    now: () => 5_000,
    createEventLoopMonitor: () => histogram
  });

  metrics.snapshotSaved(125, 34_489_732);
  metrics.snapshotSaved(250, 34_500_000);

  const snapshot = metrics.snapshot();
  assert.equal(histogram.enabled, true);
  assert.deepEqual(snapshot.eventLoopDelayMs, { p50: 2, p95: 8, p99: 14, max: 20 });
  assert.deepEqual(snapshot.persistence.durationMs, { p50: 125, p95: 250, p99: 250, max: 250, samples: 2 });
  assert.equal(snapshot.persistence.lastBytes, 34_500_000);
  assert.equal(snapshot.persistence.totalSaves, 2);
});

test("includes a bounded server runtime snapshot for bottleneck attribution", () => {
  const runtime = {
    snapshot() {
      return { processCpuPercent: 77.2, processRssMb: 420.5, processHeapUsedMb: 98.1, hostMemoryUsedPercent: 81, hostFreeMemoryMb: 1_024, uptimeSeconds: 600 };
    }
  };
  const metrics = createRealtimeMetrics({ monitorEventLoop: false, runtime });

  assert.deepEqual(metrics.snapshot().runtime, runtime.snapshot());
});
