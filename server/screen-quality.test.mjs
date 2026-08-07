import assert from "node:assert/strict";
import test from "node:test";

import { SCREEN_QUALITY_PROFILES, selectScreenQuality } from "./screen-quality.mjs";

test("auto quality keeps the first seven concurrent sessions at 720p-class 60fps", () => {
  const realtime = selectScreenQuality({ activeSessions: 0, bandwidthMbps: 100 });
  assert.equal(realtime.profile, "realtime");
  assert.equal(realtime.maxSize, 1600);
  assert.equal(realtime.maxFps, 60);
  assert.equal(realtime.videoBitRate, 8_000_000);
  assert.equal(selectScreenQuality({ activeSessions: 6, bandwidthMbps: 100 }).profile, "realtime");
  assert.equal(selectScreenQuality({ activeSessions: 7, bandwidthMbps: 100 }).profile, "standard");
  assert.equal(selectScreenQuality({ activeSessions: 12, bandwidthMbps: 100 }).profile, "concurrent");
});

test("auto quality uses the standard profile after the seven-session target", () => {
  const selected = selectScreenQuality({ activeSessions: 7, bandwidthMbps: 20 });
  assert.equal(selected.profile, "standard");
  assert.equal(selected.maxFps, 24);
});

test("an explicit profile is capped by Agent encoder capabilities", () => {
  const selected = selectScreenQuality({
    requestedProfile: "high",
    activeSessions: 0,
    agentCapabilities: { maxSize: 1280, maxFps: 24, maxVideoBitRate: 3_000_000 }
  });
  assert.deepEqual(selected, {
    ...SCREEN_QUALITY_PROFILES.high,
    profile: "high",
    maxSize: 1280,
    maxFps: 24,
    videoBitRate: 3_000_000
  });
});

test("rejects an unknown requested profile", () => {
  assert.throws(() => selectScreenQuality({ requestedProfile: "ultra" }), /invalid_screen_quality_profile/);
});
