import assert from "node:assert/strict";
import test from "node:test";
import { smsOrderProbeDecision } from "./sms-order-probe.mjs";

const device = {
  deviceId: "adb:serial-a",
  adb: { agentId: "agent-a", serial: "serial-a", state: "device" }
};

test("queues an immediate probe for a waiting order on an online device", () => {
  const decision = smsOrderProbeDecision({ order: { status: "waiting" }, device, nowMs: 10_000 });
  assert.equal(decision.queue, true);
  assert.equal(decision.adbSerial, "serial-a");
});

test("deduplicates against targeted probes and full user refreshes", () => {
  for (const type of ["sms_code_probe", "sms_sync_now"]) {
    const decision = smsOrderProbeDecision({
      order: { status: "waiting" },
      device,
      tasks: [{ agentId: "agent-a", adbSerial: "serial-a", type, status: "running" }]
    });
    assert.equal(decision.queue, false);
    assert.equal(decision.reason, "collection_already_active");
  }
});

test("applies a short per-order cooldown without blocking another device", () => {
  const decision = smsOrderProbeDecision({
    order: { status: "waiting", smsProbeLastQueuedAt: new Date(9_000).toISOString() },
    device,
    tasks: [{ agentId: "agent-a", adbSerial: "serial-b", type: "sms_code_probe", status: "running" }],
    nowMs: 10_000,
    intervalMs: 2_500
  });
  assert.equal(decision.queue, false);
  assert.equal(decision.reason, "probe_cooldown");
  assert.equal(decision.retryAfterMs, 1_500);
});

test("does not queue against an offline or terminal order", () => {
  assert.equal(smsOrderProbeDecision({ order: { status: "received" }, device }).reason, "order_not_waiting");
  assert.equal(smsOrderProbeDecision({
    order: { status: "waiting" },
    device: { ...device, adb: { ...device.adb, state: "offline" } }
  }).reason, "device_not_adb_online");
});
