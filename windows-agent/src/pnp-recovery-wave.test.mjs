import assert from "node:assert/strict";
import test from "node:test";

import {
  selectIndependentPnpRecoveryTargets,
  scopePnpRecoveryPlansForSafety,
  summarizePnpRecoveryBatchResults
} from "./pnp-recovery-wave.mjs";

test("selects at most one target per upstream hub", () => {
  const upstream = new Map([
    ["PHONE-1", "USB\\HUB-A"],
    ["PHONE-2", "USB\\HUB-A"],
    ["PHONE-3", "USB\\HUB-B"],
    ["PHONE-4", "USB\\HUB-C"]
  ]);
  assert.deepEqual(
    selectIndependentPnpRecoveryTargets(["phone-1", "phone-2", "phone-3", "phone-4"], upstream, 3),
    ["phone-1", "phone-3", "phone-4"]
  );
});

test("keeps unknown topology targets in one conservative lane", () => {
  assert.deepEqual(
    selectIndependentPnpRecoveryTargets(["phone-1", "phone-2", "phone-3"], new Map(), 3),
    ["phone-1"]
  );
});

test("deduplicates serials case-insensitively and honors the limit", () => {
  const upstream = {
    "PHONE-1": "USB\\HUB-A",
    "PHONE-2": "USB\\HUB-B",
    "PHONE-3": "USB\\HUB-C"
  };
  assert.deepEqual(
    selectIndependentPnpRecoveryTargets(["phone-1", "PHONE-1", "phone-2", "phone-3"], upstream, 2),
    ["phone-1", "phone-2"]
  );
});

test("counts only commands which actually started as attempted", () => {
  const summary = summarizePnpRecoveryBatchResults([
    { status: "fulfilled", value: { serial: "phone-action", status: "action_completed", actionAttempted: true } },
    { status: "fulfilled", value: { serial: "phone-blocked", status: "blocked", actionAttempted: false } },
    { status: "fulfilled", value: { serial: "phone-deferred", status: "deferred", actionAttempted: false } },
    { status: "fulfilled", value: { serial: "phone-online", status: "skipped", actionAttempted: false } },
    { status: "fulfilled", value: { serial: "phone-terminal", status: "quarantined", actionAttempted: false } }
  ], ["phone-action", "phone-blocked", "phone-deferred", "phone-online", "phone-terminal"]);

  assert.deepEqual(summary.actionedSerials, ["phone-action"]);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.deferred, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.quarantined, 1);
});

test("keeps failed commands in the actual action set and reports internal failures separately", () => {
  const summary = summarizePnpRecoveryBatchResults([
    { status: "fulfilled", value: { serial: "phone-failed", status: "action_failed", actionAttempted: true } },
    { status: "rejected", reason: new Error("unexpected") }
  ], ["phone-failed", "phone-internal"]);

  assert.deepEqual(summary.actionedSerials, ["phone-failed"]);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.internalFailures, [{ serial: "phone-internal", error: "unexpected" }]);
});

test("keeps the ordinary queue blocked while scoping a circuit to one collateral rescue", () => {
  const plans = [
    { serial: "phone-target" },
    { serial: "phone-collateral" },
    { serial: "phone-other" }
  ];
  const scoped = scopePnpRecoveryPlansForSafety(plans, {
    circuitOpen: true,
    rescueSerials: ["PHONE-COLLATERAL"]
  }, 8);
  assert.equal(scoped.rescue, true);
  assert.equal(scoped.maxTargets, 1);
  assert.deepEqual(scoped.plans, [{ serial: "phone-collateral" }]);
});

test("preserves the normal batch limit when the circuit is closed", () => {
  const plans = [{ serial: "phone-1" }, { serial: "phone-2" }];
  const scoped = scopePnpRecoveryPlansForSafety(plans, { circuitOpen: false }, 8);
  assert.equal(scoped.rescue, false);
  assert.equal(scoped.maxTargets, 8);
  assert.equal(scoped.plans, plans);
});
