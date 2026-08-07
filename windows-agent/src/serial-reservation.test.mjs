import assert from "node:assert/strict";
import test from "node:test";
import { isSerialReservedForBackgroundWork } from "./serial-reservation.mjs";

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
