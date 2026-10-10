import assert from "node:assert/strict";
import test from "node:test";

import {
  observeAdbRecoveryVerification,
  observePhysicalAbsence
} from "./pnp-recovery-verification.mjs";

test("requires both repeated scans and elapsed stability before recovery is confirmed", () => {
  let state = { attempts: 1, lastMode: "restart_adb_interface" };
  let result = observeAdbRecoveryVerification(state, { online: true, now: 1_000, minStableMs: 60_000, minStableScans: 3 });
  state = result.state;
  assert.equal(result.confirmed, false);
  result = observeAdbRecoveryVerification(state, { online: true, now: 31_000, minStableMs: 60_000, minStableScans: 3 });
  state = result.state;
  assert.equal(result.confirmed, false);
  result = observeAdbRecoveryVerification(state, { online: true, now: 61_000, minStableMs: 60_000, minStableScans: 3 });
  assert.equal(result.confirmed, true);
  assert.equal(result.scans, 3);
});

test("clears a partial stability window when ADB regresses", () => {
  const result = observeAdbRecoveryVerification({ verificationStartedAt: 1_000, verificationScans: 2 }, { online: false, now: 20_000 });
  assert.equal(result.status, "regressed");
  assert.equal(result.state.verificationStartedAt, undefined);
  assert.equal(result.state.verificationScans, undefined);
});

test("does not reset the recovery cycle for a transient PnP disappearance", () => {
  let result = observePhysicalAbsence({ attempts: 2 }, { absent: true, now: 1_000, minAbsentMs: 90_000 });
  assert.equal(result.reset, false);
  result = observePhysicalAbsence(result.state, { absent: true, now: 90_999, minAbsentMs: 90_000 });
  assert.equal(result.reset, false);
  result = observePhysicalAbsence(result.state, { absent: true, now: 91_000, minAbsentMs: 90_000 });
  assert.equal(result.reset, true);
});

test("cancels an absence window when the physical device returns", () => {
  const result = observePhysicalAbsence({ attempts: 2, absentSince: 1_000 }, { absent: false, now: 2_000 });
  assert.equal(result.reset, false);
  assert.equal(result.state.absentSince, undefined);
});
