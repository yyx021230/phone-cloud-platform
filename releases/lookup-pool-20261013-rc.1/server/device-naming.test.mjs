import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAdbDeviceName,
  applyAdminDeviceName,
  applyPhoneAgentDeviceName
} from "./device-naming.mjs";

const adbDevice = {
  adbSerial: "IRHIAYVK7XJRJZFI",
  model: "PHJ110",
  manufacturer: "OPPO",
  brand: "OPPO",
  deviceName: "OPPO-IRHIAYVK7XJRJZFI"
};

test("an administrator device name cannot be overwritten by ADB sync", () => {
  const device = { deviceName: "152", deviceNameSource: "admin" };

  applyAdbDeviceName(device, adbDevice, "2026-07-16T08:00:00.000Z");

  assert.equal(device.deviceName, "152");
  assert.equal(device.deviceNameSource, "admin");
});

test("an administrator device name cannot be overwritten by legacy phone Agent heartbeat", () => {
  const device = {
    deviceName: "152",
    deviceNameSource: "admin",
    adb: { serial: "IRHIAYVK7XJRJZFI", model: "PHJ110", manufacturer: "OPPO", brand: "OPPO" }
  };

  applyPhoneAgentDeviceName(device, "PHJ110", "2026-07-16T08:00:00.000Z");

  assert.equal(device.deviceName, "152");
  assert.equal(device.deviceNameSource, "admin");
});

test("a legacy custom name without source metadata is adopted as an administrator name", () => {
  const device = { deviceName: "94" };

  applyAdbDeviceName(device, adbDevice, "2026-07-16T08:00:00.000Z");

  assert.equal(device.deviceName, "94");
  assert.equal(device.deviceNameSource, "admin");
});

test("a custom name echoed back by the Windows Agent is not mistaken for an automatic name", () => {
  const device = { deviceName: "152" };

  applyAdbDeviceName(device, {
    ...adbDevice,
    deviceName: "152"
  }, "2026-07-16T08:00:00.000Z");

  assert.equal(device.deviceName, "152");
  assert.equal(device.deviceNameSource, "admin");
});

test("an automatically generated name can still follow corrected ADB brand data", () => {
  const device = {
    deviceName: "PHJ110-IRHIAYVK7XJRJZFI",
    deviceNameSource: "auto"
  };

  applyAdbDeviceName(device, adbDevice, "2026-07-16T08:00:00.000Z");

  assert.equal(device.deviceName, "OPPO-IRHIAYVK7XJRJZFI");
  assert.equal(device.deviceNameSource, "auto");
});

test("saving a name in the administrator UI marks it as administrator-owned", () => {
  const device = { deviceName: "OPPO-IRHIAYVK7XJRJZFI", deviceNameSource: "auto" };

  applyAdminDeviceName(device, "152", "2026-07-16T08:00:00.000Z");

  assert.equal(device.deviceName, "152");
  assert.equal(device.deviceNameSource, "admin");
  assert.equal(device.deviceNameUpdatedAt, "2026-07-16T08:00:00.000Z");
});
