import assert from "node:assert/strict";
import test from "node:test";
import { assertSerialAdbHealthy } from "./serial-adb-health.mjs";

test("verifies the device with a real shell round trip", async () => {
  const calls = [];
  await assertSerialAdbHealthy({
    serial: "phone-1",
    async adb(serial, args, options) {
      calls.push({ serial, args, options });
      return "phone_cloud_adb_ready";
    }
  });

  assert.deepEqual(calls, [{
    serial: "phone-1",
    args: ["shell", "echo", "phone_cloud_adb_ready"],
    options: { timeoutMs: 3_000, allowScreenControl: true }
  }]);
});

test("reports an unhealthy transport when shell does not return the marker", async () => {
  await assert.rejects(
    assertSerialAdbHealthy({ serial: "phone-1", adb: async () => "" }),
    (error) => error.code === "screen_adb_unhealthy"
  );
});

for (const [label, details, code] of [
  ["quoted device not found", { stderr: "adb: device 'TESTAB12' not found" }, "screen_adb_not_found"],
  ["unquoted device not found", { message: "error: device not found" }, "screen_adb_not_found"],
  ["empty server inventory", { stderr: "error: no devices/emulators found" }, "screen_adb_not_found"],
  ["unauthorized", { stderr: "error: device unauthorized" }, "screen_adb_unauthorized"],
  ["offline", { stderr: "error: device offline" }, "screen_adb_offline"],
  ["timeout code", { code: "ETIMEDOUT" }, "screen_adb_shell_timeout"],
  ["execFile timeout", { killed: true, signal: "SIGTERM" }, "screen_adb_shell_timeout"],
  ["timeout message", { message: "operation timed out" }, "screen_adb_shell_timeout"],
  ["other command failure", { code: "EPIPE" }, "screen_adb_shell_failed"],
  ["abort", { code: "ABORT_ERR", name: "AbortError" }, "screen_adb_shell_failed"]
]) {
  test(`distinguishes ${label} from an unresponsive phone`, async () => {
    const cause = Object.assign(new Error("private diagnostic fixture"), details);
    await assert.rejects(assertSerialAdbHealthy({ serial: "TESTAB12", adb: async () => { throw cause; } }), error => {
      assert.equal(error.code, code);
      assert.equal(error.cause, cause);
      assert.ok(error.message.includes("TESTAB12"));
      assert.doesNotMatch(error.message, /private diagnostic|shell 通道无响应/);
      return true;
    });
  });
}
