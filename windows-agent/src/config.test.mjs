import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isDeviceSerialInNotificationFallbackScope,
  loadAgentConfig,
  normalizeDeviceSerialAllowlist
} from "./config.mjs";

test("normalizes the SMS notification canary device allowlist", () => {
  assert.deepEqual(normalizeDeviceSerialAllowlist(), []);
  assert.deepEqual(normalizeDeviceSerialAllowlist("SERIAL-1"), []);
  assert.deepEqual(normalizeDeviceSerialAllowlist([" IRHIAYVK7XJRJZFI ", "", "IRHIAYVK7XJRJZFI", "SECOND"]), [
    "IRHIAYVK7XJRJZFI",
    "SECOND"
  ]);
  assert.deepEqual(normalizeDeviceSerialAllowlist(["lower-case"]), ["LOWER-CASE"]);
});

test("notification fallback is fail-closed unless a canary or explicit all-device switch is configured", () => {
  assert.equal(isDeviceSerialInNotificationFallbackScope({ smsNotificationFallbackEnabled: true }, "SERIAL-1"), false);
  assert.equal(isDeviceSerialInNotificationFallbackScope({
    smsNotificationFallbackEnabled: true,
    smsNotificationFallbackDeviceSerials: ["serial-1"]
  }, "SERIAL-1"), true);
  assert.equal(isDeviceSerialInNotificationFallbackScope({
    smsNotificationFallbackEnabled: true,
    smsNotificationFallbackDeviceSerials: ["serial-1"]
  }, "SERIAL-2"), false);
  assert.equal(isDeviceSerialInNotificationFallbackScope({
    smsNotificationFallbackEnabled: true,
    smsNotificationFallbackAllDevices: true
  }, "SERIAL-2"), true);
});

test("defaults and bounds the delayed collateral observation window", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-config-"));
  const configPath = path.join(agentDir, "config.json");
  try {
    await fs.writeFile(configPath, "{}", "utf8");
    assert.equal((await loadAgentConfig({ agentDir, configPath })).pnpCollateralWatchSeconds, 180);

    await fs.writeFile(configPath, JSON.stringify({ pnpCollateralWatchSeconds: 10 }), "utf8");
    assert.equal((await loadAgentConfig({ agentDir, configPath })).pnpCollateralWatchSeconds, 60);

    await fs.writeFile(configPath, JSON.stringify({ pnpCollateralWatchSeconds: 900 }), "utf8");
    assert.equal((await loadAgentConfig({ agentDir, configPath })).pnpCollateralWatchSeconds, 600);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("warns and remains fail-closed when notification fallback has no rollout scope", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-config-"));
  const configPath = path.join(agentDir, "config.json");
  try {
    await fs.writeFile(configPath, JSON.stringify({ smsNotificationFallbackEnabled: true }), "utf8");
    const config = await loadAgentConfig({ agentDir, configPath });
    assert.equal(config.smsNotificationFallbackAllDevices, false);
    assert.deepEqual(config.smsNotificationFallbackDeviceSerials, []);
    assert.ok(config.configWarnings.includes("sms_notification_fallback_enabled_without_scope"));
    assert.equal(isDeviceSerialInNotificationFallbackScope(config, "SERIAL-1"), false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
