import assert from "node:assert/strict";
import test from "node:test";
import { isSerialReservedForBackgroundWork, shouldScheduleSmsBackground } from "./serial-reservation.mjs";

test("blocks background ADB work while a task owns the device", () => {
  assert.equal(
    isSerialReservedForBackgroundWork("device-a", new Set(["device-a"]), new Set()),
    true
  );
});

test("blocks background ADB work while screen control owns the device", () => {
  assert.equal(
    isSerialReservedForBackgroundWork("device-a", new Set(), new Set(["device-a"])),
    true
  );
});

test("does not block unrelated devices", () => {
  assert.equal(
    isSerialReservedForBackgroundWork("device-b", new Set(["device-a"]), new Set(["device-c"])),
    false
  );
});

test("keeps healthy phones syncing while another phone is waiting for recovery", () => {
  assert.equal(shouldScheduleSmsBackground({
    enabled: true,
    skipSms: false,
    activeAutomationTask: false,
    recoveryPending: true
  }), true);
});

test("foreground automation and explicit scan options still block background SMS", () => {
  assert.equal(shouldScheduleSmsBackground({ enabled: true, activeAutomationTask: true }), false);
  assert.equal(shouldScheduleSmsBackground({ enabled: true, skipSms: true }), false);
  assert.equal(shouldScheduleSmsBackground({ enabled: false }), false);
});
