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
