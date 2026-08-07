import assert from "node:assert/strict";
import test from "node:test";

import {
  ANDROID_USB_VENDOR_IDS,
  orderPnpRecoveryTargets,
  pnpTargetRecoveryBackoffMs,
  pnpTargetRecoveryMode
} from "./pnp-recovery-policy.mjs";

test("discovers the Android and Unisoc USB vendor ids used by current phones", () => {
  assert.equal(ANDROID_USB_VENDOR_IDS.includes("18D1"), true);
  assert.equal(ANDROID_USB_VENDOR_IDS.includes("1782"), true);
});

test("uses a targeted restart before escalating to remove and re-enumerate", () => {
  assert.equal(pnpTargetRecoveryMode(1), "restart");
  assert.equal(pnpTargetRecoveryMode(2), "reenumerate");
  assert.equal(pnpTargetRecoveryMode(5), "reenumerate");
});

test("backs off repeated targeted recovery attempts", () => {
  assert.equal(pnpTargetRecoveryBackoffMs(1, 120_000, 1_800_000), 120_000);
  assert.equal(pnpTargetRecoveryBackoffMs(2, 120_000, 1_800_000), 240_000);
  assert.equal(pnpTargetRecoveryBackoffMs(5, 120_000, 1_800_000), 1_800_000);
});

test("never-attempted phones are recovered before retrying earlier failures", () => {
  const attempts = new Map([
    ["PHONE-1", { attempts: 1, lastAttemptAt: 100 }],
    ["PHONE-2", { attempts: 2, lastAttemptAt: 50 }]
  ]);
  assert.deepEqual(
    orderPnpRecoveryTargets(["phone-2", "phone-1", "phone-3"], attempts),
    ["phone-3", "phone-1", "phone-2"]
  );
});
