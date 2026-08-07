export const SCREEN_QUALITY_PROFILES = Object.freeze({
  high: Object.freeze({ maxSize: 1600, maxFps: 60, videoBitRate: 8_000_000 }),
  // Seven concurrent real-device publishers sustain this source profile. RTP
  // repair and on-demand IDR recovery handle loss instead of silently lowering
  // the first seven interactive sessions below the product quality target.
  realtime: Object.freeze({ maxSize: 1600, maxFps: 60, videoBitRate: 8_000_000 }),
  standard: Object.freeze({ maxSize: 960, maxFps: 24, videoBitRate: 1_250_000 }),
  smooth: Object.freeze({ maxSize: 720, maxFps: 20, videoBitRate: 900_000 }),
  // Internal concurrency probe. It is deliberately not exposed as a user UI
  // choice until real multi-device measurements establish the safe threshold.
  concurrent: Object.freeze({ maxSize: 540, maxFps: 15, videoBitRate: 500_000 })
});

export function selectScreenQuality(options = {}) {
  const requested = String(options.requestedProfile || "auto").toLowerCase();
  if (requested !== "auto" && !SCREEN_QUALITY_PROFILES[requested]) {
    throw new Error("invalid_screen_quality_profile");
  }
  const profile = requested === "auto" ? selectAutoProfile(options) : requested;
  const selected = SCREEN_QUALITY_PROFILES[profile];
  const capabilities = options.agentCapabilities || {};
  return {
    ...selected,
    profile,
    maxSize: cap(selected.maxSize, capabilities.maxSize),
    maxFps: cap(selected.maxFps, capabilities.maxFps),
    videoBitRate: cap(selected.videoBitRate, capabilities.maxVideoBitRate)
  };
}

function selectAutoProfile(options) {
  const projectedSessions = Math.max(1, Number(options.activeSessions || 0) + 1);
  if (projectedSessions <= 7) return "realtime";
  if (projectedSessions <= 12) return "standard";
  return "concurrent";
}

function cap(value, limit) {
  const normalized = Number(limit || 0);
  return normalized > 0 ? Math.min(value, normalized) : value;
}
