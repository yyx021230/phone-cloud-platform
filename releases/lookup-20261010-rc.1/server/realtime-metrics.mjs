import { monitorEventLoopDelay } from "node:perf_hooks";
import os from "node:os";

export function createRealtimeMetrics(options = {}) {
  const now = options.now || Date.now;
  const sampleLimit = Math.max(1, Number(options.sampleLimit || 2_000));
  const completedSessionLimit = Math.max(1, Number(options.completedSessionLimit || 80));
  const sessionSampleLimit = Math.max(1, Number(options.sessionSampleLimit || 72));
  const sessions = new Map();
  const recentSessions = [];
  const pendingControls = new Map();
  const controlRttSamples = [];
  const agentElapsedSamples = [];
  const persistenceSamples = [];
  const closeReasons = new Map();
  const eventLoop = createEventLoopMonitor(options);
  const runtime = options.runtime || createServerRuntimeMetrics(now);
  eventLoop?.enable();

  const totals = {
    sessionsStarted: 0,
    sessionsClosed: 0,
    videoBytes: 0,
    videoPackets: 0,
    videoDroppedPackets: 0,
    controlsForwarded: 0,
    controlsAcknowledged: 0,
    snapshotSaves: 0,
    lastSnapshotBytes: 0
  };

  return {
    sessionStarted(session = {}) {
      const sessionId = String(session.sessionId || "");
      if (!sessionId || sessions.has(sessionId)) return;
      sessions.set(sessionId, {
        sessionId,
        agentId: String(session.agentId || ""),
        deviceId: String(session.deviceId || ""),
        startedAt: now(),
        videoBytes: 0,
        videoPackets: 0,
        droppedPackets: 0,
        agent: null,
        browser: null,
        agentSamples: [],
        browserSamples: []
      });
      totals.sessionsStarted += 1;
    },

    sessionClosed(sessionId, reason = "closed") {
      const id = String(sessionId || "");
      const session = sessions.get(id);
      if (!session) return;
      const endedAt = now();
      recentSessions.unshift(serializeCompletedSession(session, reason, endedAt));
      if (recentSessions.length > completedSessionLimit) recentSessions.splice(completedSessionLimit);
      sessions.delete(id);
      pendingControls.delete(id);
      totals.sessionsClosed += 1;
      const normalizedReason = String(reason || "closed");
      closeReasons.set(normalizedReason, (closeReasons.get(normalizedReason) || 0) + 1);
    },

    videoForwarded(sessionId, bytes, dropped = false) {
      const size = Math.max(0, Number(bytes || 0));
      const session = sessions.get(String(sessionId || ""));
      totals.videoBytes += size;
      totals.videoPackets += 1;
      if (dropped) totals.videoDroppedPackets += 1;
      if (!session) return;
      session.videoBytes += size;
      session.videoPackets += 1;
      if (dropped) session.droppedPackets += 1;
    },

    agentStreamReported(sessionId, payload = {}) {
      const session = sessions.get(String(sessionId || ""));
      if (!session) return false;
      session.agent = normalizeAgentMetrics(payload, now());
      pushBounded(session.agentSamples, session.agent, sessionSampleLimit);
      return true;
    },

    browserPlaybackReported(sessionId, payload = {}) {
      const session = sessions.get(String(sessionId || ""));
      if (!session) return false;
      session.browser = normalizeBrowserMetrics(payload, now());
      pushBounded(session.browserSamples, session.browser, sessionSampleLimit);
      return true;
    },

    controlForwarded(sessionId, sequenceId) {
      const id = String(sessionId || "");
      if (!pendingControls.has(id)) pendingControls.set(id, new Map());
      pendingControls.get(id).set(Number(sequenceId || 0), now());
      totals.controlsForwarded += 1;
    },

    controlAcknowledged(sessionId, sequenceId, agentElapsedMs = 0) {
      const id = String(sessionId || "");
      const sequence = Number(sequenceId || 0);
      const controls = pendingControls.get(id);
      const sentAt = controls?.get(sequence);
      if (sentAt === undefined) return;
      controls.delete(sequence);
      if (!controls.size) pendingControls.delete(id);
      pushBounded(controlRttSamples, Math.max(0, now() - sentAt), sampleLimit);
      pushBounded(agentElapsedSamples, Math.max(0, Number(agentElapsedMs || 0)), sampleLimit);
      totals.controlsAcknowledged += 1;
    },

    snapshotSaved(durationMs, bytes = 0) {
      pushBounded(persistenceSamples, Math.max(0, Number(durationMs || 0)), sampleLimit);
      totals.snapshotSaves += 1;
      totals.lastSnapshotBytes = Math.max(0, Number(bytes || 0));
    },

    snapshot() {
      const capturedAt = now();
      return {
        generatedAt: new Date(capturedAt).toISOString(),
        sessions: {
          active: sessions.size,
          started: totals.sessionsStarted,
          closed: totals.sessionsClosed,
          closeReasons: Object.fromEntries(closeReasons),
          recent: recentSessions.map((session) => ({ ...session, agentSamples: [...session.agentSamples], browserSamples: [...session.browserSamples] }))
        },
        video: {
          totalBytes: totals.videoBytes,
          totalPackets: totals.videoPackets,
          totalDroppedPackets: totals.videoDroppedPackets,
          sessions: [...sessions.values()].map((session) => serializeActiveSession(session, capturedAt))
        },
        control: {
          totalForwarded: totals.controlsForwarded,
          totalAcknowledged: totals.controlsAcknowledged,
          pending: [...pendingControls.values()].reduce((sum, values) => sum + values.size, 0),
          rttMs: summarize(controlRttSamples),
          agentElapsedMs: summarize(agentElapsedSamples)
        },
        persistence: {
          totalSaves: totals.snapshotSaves,
          lastBytes: totals.lastSnapshotBytes,
          durationMs: summarize(persistenceSamples)
        },
        eventLoopDelayMs: summarizeEventLoop(eventLoop),
        runtime: runtime.snapshot()
      };
    },

    close() {
      eventLoop?.disable?.();
    }
  };
}

function serializeActiveSession(session, capturedAt) {
  const elapsedMs = Math.max(1, capturedAt - session.startedAt);
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    deviceId: session.deviceId,
    packets: session.videoPackets,
    droppedPackets: session.droppedPackets,
    bytes: session.videoBytes,
    megabitsPerSecond: round(session.videoBytes * 8 / elapsedMs / 1_000, 3),
    agent: session.agent,
    browser: session.browser
  };
}

function serializeCompletedSession(session, reason, endedAt) {
  return {
    ...serializeActiveSession(session, endedAt),
    closeReason: String(reason || "closed"),
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: Math.max(0, endedAt - session.startedAt),
    agentSamples: [...session.agentSamples],
    browserSamples: [...session.browserSamples]
  };
}

function createServerRuntimeMetrics(now) {
  let previousAt = now();
  let previousCpu = process.cpuUsage();
  return {
    snapshot() {
      const capturedAt = now();
      const elapsedMs = Math.max(1, capturedAt - previousAt);
      const cpuDelta = process.cpuUsage(previousCpu);
      const memory = process.memoryUsage();
      const totalMemory = Math.max(1, Number(os.totalmem() || 0));
      const freeMemory = Math.max(0, Number(os.freemem() || 0));
      previousAt = capturedAt;
      previousCpu = process.cpuUsage();
      return {
        processCpuPercent: round((Number(cpuDelta.user || 0) + Number(cpuDelta.system || 0)) / 1_000 / elapsedMs * 100, 1),
        processRssMb: round(Math.max(0, Number(memory.rss || 0)) / 1024 / 1024, 1),
        processHeapUsedMb: round(Math.max(0, Number(memory.heapUsed || 0)) / 1024 / 1024, 1),
        hostMemoryUsedPercent: round((1 - Math.min(totalMemory, freeMemory) / totalMemory) * 100, 1),
        hostFreeMemoryMb: round(freeMemory / 1024 / 1024, 1),
        uptimeSeconds: Math.max(0, Math.round(process.uptime()))
      };
    }
  };
}

function createEventLoopMonitor(options) {
  if (options.monitorEventLoop === false) return null;
  if (typeof options.createEventLoopMonitor === "function") return options.createEventLoopMonitor();
  return monitorEventLoopDelay({ resolution: 20 });
}

function pushBounded(list, value, limit) {
  list.push(value);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function summarize(values) {
  if (!values.length) return { p50: 0, p95: 0, p99: 0, max: 0, samples: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    samples: sorted.length
  };
}

function summarizeEventLoop(histogram) {
  if (!histogram) return { p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    p50: nanosecondsToMilliseconds(histogram.percentile(50)),
    p95: nanosecondsToMilliseconds(histogram.percentile(95)),
    p99: nanosecondsToMilliseconds(histogram.percentile(99)),
    max: nanosecondsToMilliseconds(histogram.max)
  };
}

function percentile(sorted, percentage) {
  const index = Math.max(0, Math.ceil(sorted.length * percentage / 100) - 1);
  return round(sorted[index], 3);
}

function nanosecondsToMilliseconds(value) {
  return round(Math.max(0, Number(value || 0)) / 1_000_000, 3);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function normalizeAgentMetrics(payload, now) {
  return {
    fps: boundedNumber(payload.fps, 0, 240, 1),
    ...(Number.isFinite(Number(payload.capturedFps)) ? { capturedFps: boundedNumber(payload.capturedFps, 0, 240, 1) } : {}),
    megabitsPerSecond: boundedNumber(payload.megabitsPerSecond, 0, 1000, 3),
    droppedFrames: boundedNumber(payload.droppedFrames, 0, 10_000_000, 0),
    bufferedBytes: boundedNumber(payload.relayBufferedBytes ?? payload.bufferedBytes, 0, 256 * 1024 * 1024, 0),
    width: boundedNumber(payload.width, 0, 20_000, 0),
    height: boundedNumber(payload.height, 0, 20_000, 0),
    reportedAt: new Date(now).toISOString()
  };
}

function normalizeBrowserMetrics(payload, now) {
  return {
    fps: boundedNumber(payload.fps, 0, 240, 1),
    decoded: boundedNumber(payload.decoded, 0, 1_000_000_000, 0),
    dropped: boundedNumber(payload.dropped, 0, 1_000_000_000, 0),
    presented: boundedNumber(payload.presented, 0, 1_000_000_000, 0),
    bufferMs: boundedNumber(Number(payload.bufferSeconds || 0) * 1000, 0, 60_000, 0),
    controlRttMs: boundedNumber(payload.controlRttMs, 0, 60_000, 1),
    agentControlMs: boundedNumber(payload.agentControlMs, 0, 60_000, 1),
    ...optionalBrowserMetric(payload, "rtcFramesDecoded", 0, 1_000_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcFramesDecodedDelta", 0, 1_000_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcFramesDropped", 0, 1_000_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcFramesPerSecond", 0, 240, 1),
    ...optionalBrowserMetric(payload, "rtcPacketsLost", 0, 1_000_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcPacketsLostDelta", 0, 1_000_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcJitterMs", 0, 60_000, 1),
    ...optionalBrowserMetric(payload, "rtcBytesReceived", 0, 1_000_000_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcBytesReceivedDelta", 0, 1_000_000_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcStatsWindowMs", 0, 60_000, 0),
    ...optionalBrowserMetric(payload, "rtcReceiveMbps", 0, 1_000, 3),
    ...optionalBrowserMetric(payload, "rtcDecodeMsPerFrame", 0, 60_000, 2),
    ...optionalBrowserMetric(payload, "rtcFreezeCount", 0, 1_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcFreezeCountDelta", 0, 1_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcTotalFreezeMs", 0, 60_000_000, 0),
    ...optionalBrowserMetric(payload, "rtcTotalFreezeMsDelta", 0, 60_000_000, 0),
    ...(payload.pageVisibilityState !== undefined ? { pageVisibilityState: String(payload.pageVisibilityState || "unknown").slice(0, 16) } : {}),
    ...(payload.pageFocused !== undefined ? { pageFocused: Boolean(payload.pageFocused) } : {}),
    ...(payload.videoInViewport !== undefined ? { videoInViewport: Boolean(payload.videoInViewport) } : {}),
    ...(payload.playbackVisible !== undefined ? { playbackVisible: Boolean(payload.playbackVisible) } : {}),
    reportedAt: new Date(now).toISOString()
  };
}

function optionalBrowserMetric(payload, key, min, max, digits) {
  if (payload[key] === undefined || payload[key] === null) return {};
  return { [key]: boundedNumber(payload[key], min, max, digits) };
}

function boundedNumber(value, min, max, digits = 0) {
  const numeric = Number(value || 0);
  const bounded = Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : 0));
  return round(bounded, digits);
}
