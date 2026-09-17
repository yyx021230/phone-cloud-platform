import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultScreenTransportPolicy,
  normalizeScreenTransportPolicy,
  resolveScreenTransportPolicy,
  screenTransportPolicyFields
} from "./screen-transport-policy.mjs";

test("normalizes bounded versioned screen transport policies", () => {
  assert.deepEqual(normalizeScreenTransportPolicy({
    defaults: {
      mediaTransport: "webrtc",
      maxSize: 960,
      maxFps: 40,
      videoBitRate: 1_500_000,
      encoderBitrateMode: 2,
      iFrameIntervalSeconds: 1,
      realtimeQueueLatencyMs: 400,
      transportPacingBitRate: 10_000_000,
      transportPacketsPerBurst: 2
    },
    devices: {
      "serial-10": {
        mediaTransport: "direct_webrtc",
        videoEncoder: "c2.android.avc.encoder",
        sourceRecoveryEnabled: true,
        sourceRecoveryMaxAttempts: 4,
        sourceRecoveryWindowSeconds: 45,
        viewerKeyframeResetEnabled: true,
        keyframeRecoveryCooldownMs: 2_000,
        transportReceiverFeedback: true,
        transportReceiverStableHoldMs: 15_000
      }
    }
  }, { revision: 7, updatedAt: "2026-08-28T08:00:00.000Z", updatedBy: "admin-1" }), {
    revision: 7,
    updatedAt: "2026-08-28T08:00:00.000Z",
    updatedBy: "admin-1",
    defaults: {
      mediaTransport: "webrtc",
      maxSize: 960,
      maxFps: 40,
      videoBitRate: 1_500_000,
      encoderBitrateMode: 2,
      iFrameIntervalSeconds: 1,
      realtimeQueueLatencyMs: 400,
      transportPacingBitRate: 10_000_000,
      transportPacketsPerBurst: 2
    },
    devices: {
      "serial-10": {
        mediaTransport: "direct_webrtc",
        videoEncoder: "c2.android.avc.encoder",
        sourceRecoveryEnabled: true,
        sourceRecoveryMaxAttempts: 4,
        sourceRecoveryWindowSeconds: 45,
        viewerKeyframeResetEnabled: true,
        keyframeRecoveryCooldownMs: 2_000,
        transportReceiverFeedback: true,
        transportReceiverStableHoldMs: 15_000
      }
    }
  });
});

test("resolves defaults, device id and adb serial without mutating the policy", () => {
  const policy = normalizeScreenTransportPolicy({
    defaults: { transportPacingBitRate: 10_000_000, transportPacketsPerBurst: 2 },
    devices: {
      "device-1": { transportPacketsPerBurst: 3 },
      "serial-10": { transportPacketsPerBurst: 1, transportReceiverFeedback: true }
    }
  }, { revision: 4 });
  assert.deepEqual(resolveScreenTransportPolicy(policy, { deviceId: "device-1", adbSerial: "serial-10" }), {
    transportPacingBitRate: 10_000_000,
    transportPacketsPerBurst: 1,
    transportReceiverFeedback: true,
    screenHotConfigFields: [
      "transportPacingBitRate",
      "transportPacketsPerBurst",
      "transportReceiverFeedback"
    ],
    transportPolicyRevision: 4
  });
  assert.equal(policy.devices["serial-10"].transportPacketsPerBurst, 1);
});

test("rejects typos and out-of-range transport settings", () => {
  assert.throws(
    () => normalizeScreenTransportPolicy({ defaults: { transportPacketsPerBrust: 2 } }),
    /unknown_field/
  );
  assert.throws(
    () => normalizeScreenTransportPolicy({ defaults: { transportPacingBitRate: 1_000_000 } }),
    /out_of_range/
  );
  assert.throws(
    () => normalizeScreenTransportPolicy({ defaults: { encoderBitrateMode: 0 } }),
    /out_of_range/
  );
  assert.throws(
    () => normalizeScreenTransportPolicy({ devices: { "serial-10": { videoEncoder: "bad encoder name" } } }),
    /invalid_string/
  );
  assert.throws(
    () => normalizeScreenTransportPolicy({ defaults: { realtimeQueueLatencyMs: 2_000 } }),
    /out_of_range/
  );
  assert.throws(
    () => normalizeScreenTransportPolicy({ defaults: { mediaTransport: "turn_magic" } }),
    /invalid_string/
  );
  assert.deepEqual(screenTransportPolicyFields().mediaTransport, {
    type: "string",
    values: ["webrtc", "direct_webrtc"]
  });
  assert.deepEqual(screenTransportPolicyFields().encoderBitrateMode, {
    type: "number",
    values: [1, 2]
  });
  assert.deepEqual(Object.keys(screenTransportPolicyFields()), [
    "mediaTransport",
    "maxSize",
    "maxFps",
    "videoBitRate",
    "videoEncoder",
    "encoderBitrateMode",
    "iFrameIntervalSeconds",
    "realtimeQueueLatencyMs",
    "sourceRecoveryEnabled",
    "sourceRecoveryMaxAttempts",
    "sourceRecoveryWindowSeconds",
    "viewerKeyframeResetEnabled",
    "keyframeRecoveryCooldownMs",
    "transportPacingBitRate",
    "transportPacketsPerBurst",
    "transportAdaptivePacing",
    "transportReceiverFeedback",
    "transportReceiverStableHoldMs"
  ]);
  assert.deepEqual(defaultScreenTransportPolicy(), {
    revision: 0,
    updatedAt: "",
    updatedBy: "",
    defaults: {},
    devices: {}
  });
});
