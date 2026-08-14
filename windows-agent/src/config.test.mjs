import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeviceSerialAllowlist } from "./config.mjs";

test("normalizes the SMS notification canary device allowlist", () => {
  assert.deepEqual(normalizeDeviceSerialAllowlist(), []);
  assert.deepEqual(normalizeDeviceSerialAllowlist("SERIAL-1"), []);
  assert.deepEqual(normalizeDeviceSerialAllowlist([" IRHIAYVK7XJRJZFI ", "", "IRHIAYVK7XJRJZFI", "SECOND"]), [
    "IRHIAYVK7XJRJZFI",
    "SECOND"
  ]);
});
