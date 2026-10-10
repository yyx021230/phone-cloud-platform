import assert from "node:assert/strict";
import test from "node:test";

import { buildLoadReport, percentileSummary } from "./screen-load-report.mjs";

test("returns zero percentiles for an empty sample", () => {
  assert.deepEqual(percentileSummary([]), { p50: 0, p95: 0, p99: 0, max: 0, samples: 0 });
});

test("builds aggregate latency and cleanup results from mixed sessions", () => {
  const report = buildLoadReport({
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:01:00.000Z",
    requestedConcurrency: 3,
    sessions: [
      session("device-1", [10, 20], [1, 2], { firstFrameMs: 900, videoBytes: 1_000, released: true }),
      session("device-2", [30, 40], [3, 4], { firstFrameMs: 1_200, videoBytes: 2_000, released: true }),
      session("device-3", [50], [5], { firstFrameMs: 2_000, videoBytes: 3_000, released: false, failures: ["control_ack_timeout"] })
    ]
  });

  assert.equal(report.sessions.started, 3);
  assert.equal(report.sessions.succeeded, 2);
  assert.equal(report.sessions.failed, 1);
  assert.equal(report.sessions.released, 2);
  assert.equal(report.sessions.releaseFailures, 1);
  assert.deepEqual(report.control.rttMs, { p50: 30, p95: 50, p99: 50, max: 50, samples: 5 });
  assert.deepEqual(report.control.agentElapsedMs, { p50: 3, p95: 5, p99: 5, max: 5, samples: 5 });
  assert.deepEqual(report.firstFrameMs, { p50: 1200, p95: 2000, p99: 2000, max: 2000, samples: 3 });
  assert.equal(report.video.totalBytes, 6_000);
  assert.deepEqual(report.failures, [{ deviceId: "device-3", errors: ["control_ack_timeout"] }]);
});

function session(deviceId, rtt, agent, overrides = {}) {
  return {
    deviceId,
    firstFrameMs: overrides.firstFrameMs || 0,
    videoBytes: overrides.videoBytes || 0,
    videoPackets: 10,
    acknowledgements: rtt.map((roundTripMs, index) => ({ roundTripMs, agentElapsedMs: agent[index] })),
    failures: overrides.failures || [],
    released: overrides.released !== false
  };
}
