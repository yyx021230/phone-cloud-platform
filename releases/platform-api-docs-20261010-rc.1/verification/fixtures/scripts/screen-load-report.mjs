export function buildLoadReport(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const acknowledgements = sessions.flatMap((session) => session.acknowledgements || []);
  const failed = sessions.filter((session) => (session.failures || []).length > 0);
  const released = sessions.filter((session) => session.released === true).length;

  return {
    startedAt: input.startedAt || "",
    completedAt: input.completedAt || "",
    requestedConcurrency: Math.max(0, Number(input.requestedConcurrency || sessions.length)),
    sessions: {
      started: sessions.length,
      succeeded: sessions.length - failed.length,
      failed: failed.length,
      released,
      releaseFailures: sessions.length - released
    },
    firstFrameMs: percentileSummary(sessions.map((session) => session.firstFrameMs).filter(isNonNegativeNumber)),
    control: {
      acknowledgements: acknowledgements.length,
      rttMs: percentileSummary(acknowledgements.map((item) => item.roundTripMs).filter(isNonNegativeNumber)),
      agentElapsedMs: percentileSummary(acknowledgements.map((item) => item.agentElapsedMs).filter(isNonNegativeNumber))
    },
    video: {
      totalBytes: sessions.reduce((sum, session) => sum + Math.max(0, Number(session.videoBytes || 0)), 0),
      totalPackets: sessions.reduce((sum, session) => sum + Math.max(0, Number(session.videoPackets || 0)), 0)
    },
    failures: failed.map((session) => ({
      deviceId: session.deviceId || "",
      errors: [...session.failures]
    })),
    devices: sessions
  };
}

export function percentileSummary(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { p50: 0, p95: 0, p99: 0, max: 0, samples: 0 };
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: round(sorted[sorted.length - 1]),
    samples: sorted.length
  };
}

function percentile(sorted, percentage) {
  const index = Math.max(0, Math.ceil(sorted.length * percentage / 100) - 1);
  return round(sorted[index]);
}

function isNonNegativeNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function round(value) {
  return Math.round(Number(value || 0) * 1_000) / 1_000;
}
