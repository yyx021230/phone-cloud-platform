import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateDeviceProbe,
  parseAdbDevices,
  parseFreeDataKb,
  parseMarkedSections,
  shellProbeScript
} from "../scripts/smsrelay_fleet_preflight.mjs";

test("fleet preflight parses adb states without treating unauthorized as online", () => {
  assert.deepEqual(parseAdbDevices([
    "List of devices attached",
    "phone-1 device product:p model:m transport_id:1",
    "phone-2 unauthorized usb:2",
    ""
  ].join("\n")), [
    { serial: "phone-1", state: "device" },
    { serial: "phone-2", state: "unauthorized" }
  ]);
});

test("fleet preflight parses one bounded shell probe", () => {
  const sections = parseMarkedSections([
    "__MODEL__", "V2357A",
    "__FEATURES__", "feature:android.hardware.telephony", "feature:android.hardware.telephony.gsm",
    "__ROLE_SERVICE__", "Service role: found"
  ].join("\n"));
  assert.equal(sections.MODEL, "V2357A");
  assert.match(sections.FEATURES, /telephony\.gsm/);
  assert.equal(sections.ROLE_SERVICE, "Service role: found");
});

test("fleet preflight accepts armv7 Android 10 because the APK has no native code", () => {
  const result = evaluateDeviceProbe({
    serial: "phone-32",
    state: "device",
    sdk: 29,
    abi: "armeabi-v7a",
    telephony: true,
    roleService: true,
    defaultSmsHandler: "com.android.mms/.Main",
    freeDataKb: 100_000,
    installed: false
  });
  assert.equal(result.compatible, true);
  assert.equal(result.status, "pass");
});

test("fleet preflight does not depend on OEM dumpsys role names", () => {
  const result = evaluateDeviceProbe({
    serial: "oppo-15",
    state: "device",
    sdk: 35,
    abi: "arm64-v8a",
    telephony: true,
    roleService: true,
    defaultSmsHandler: "com.android.mms/.ui.LaunchConversationActivity",
    freeDataKb: 100_000,
    installed: false
  });
  assert.equal(result.compatible, true);
});

test("fleet preflight blocks devices without telephony or enough data space", () => {
  const result = evaluateDeviceProbe({
    serial: "tablet",
    state: "device",
    sdk: 34,
    abi: "arm64-v8a",
    telephony: false,
    roleService: true,
    defaultSmsHandler: "com.android.mms/.Main",
    freeDataKb: 1024,
    installed: false
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.failures, ["telephony_feature_missing", "insufficient_data_space"]);
});

test("fleet preflight parses data partition free space", () => {
  assert.equal(parseFreeDataKb("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-1 1000000 200000 800000 20% /data"), 800000);
});

test("fleet preflight keeps an absent APK from failing the whole shell probe", () => {
  assert.match(shellProbeScript(), /pm path com\.ztqc\.smsrelay 2>\/dev\/null; true$/);
});
