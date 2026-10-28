import assert from "node:assert/strict";
import test from "node:test";
import { adbSerialProfile, resolveOnlineAdbSerial } from "./adb-serial-identity.mjs";

test("resolves only the observed online spelling, including mixed case", () => {
  const rows = [{ adbSerial: "tEsTab12", state: "device" }, { adbSerial: "other", state: "device" }];
  for (const requested of ["TESTAB12", "testab12", "tEsTab12", " TESTAB12 "]) {
    assert.equal(resolveOnlineAdbSerial(requested, rows), "tEsTab12");
  }
  assert.equal(rows[0].adbSerial, "tEsTab12", "does not mutate the discovery snapshot");
});

for (const [state, code] of [
  ["unauthorized", "screen_adb_unauthorized"],
  ["offline", "screen_adb_offline"],
  ["missing", "screen_adb_offline"],
  ["unknown", "screen_adb_offline"]
]) {
  test(`rejects ${state} before device ownership changes`, () => {
    assert.throws(() => resolveOnlineAdbSerial("TESTAB12", [{ adbSerial: "testab12", state }]), { code });
  });
}

test("unknown, empty and unavailable inventory never guess a lowercase serial", () => {
  for (const requested of ["TESTAB12", "", " "]) {
    assert.throws(() => resolveOnlineAdbSerial(requested, [{ adbSerial: "other", state: "device" }]), { code: "screen_adb_not_found" });
  }
  assert.throws(() => resolveOnlineAdbSerial("TESTAB12", []), { code: "screen_adb_not_found" });
  assert.throws(() => resolveOnlineAdbSerial("TESTAB12", undefined), { code: "screen_adb_inventory_unavailable" });
});

test("case aliases with conflicting transports fail closed even for an exact match", () => {
  const rows = [{ adbSerial: "testab12", state: "device" }, { adbSerial: "TESTAB12", state: "offline" }];
  assert.throws(() => resolveOnlineAdbSerial("testab12", rows), { code: "screen_adb_serial_ambiguous" });
});

test("profile identity correction keeps the original object and every configured value", () => {
  const profile = Object.freeze({ videoBitRate: 5_000_000, maxFps: 30, transportPacketsPerBurst: 2, sourceRecovery: false });
  const profiles = Object.freeze({ TESTAB12: profile });
  assert.equal(adbSerialProfile(profiles, "testab12"), profile);
  assert.equal(adbSerialProfile(profiles, "TESTAB12"), profile);
  assert.equal(adbSerialProfile(profiles, "other"), undefined);
  assert.equal(adbSerialProfile(undefined, "testab12"), undefined);
});

test("conflicting profile aliases are not silently selected", () => {
  assert.throws(() => adbSerialProfile({ TESTAB12: {}, testab12: {} }, "testab12"), { code: "screen_adb_profile_ambiguous" });
});
