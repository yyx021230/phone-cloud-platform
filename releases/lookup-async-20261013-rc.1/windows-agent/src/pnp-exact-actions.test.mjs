import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDistinctExactUsbInstances,
  assertExactUsbInstanceId,
  buildRemoveExactPnpArgs
} from "./pnp-exact-actions.mjs";

test("builds a child-only PnP remove command by default", () => {
  assert.deepEqual(
    buildRemoveExactPnpArgs("USB\\VID_2D95&PID_6013&MI_02\\B&310C4C86&0&0002"),
    ["/remove-device", "USB\\VID_2D95&PID_6013&MI_02\\B&310C4C86&0&0002"]
  );
});

test("adds subtree removal only for an explicitly requested phone root rebuild", () => {
  assert.deepEqual(
    buildRemoveExactPnpArgs("USB\\VID_2D95&PID_6013\\10AF2G1F5Z009QL", { subtree: true }),
    ["/remove-device", "USB\\VID_2D95&PID_6013\\10AF2G1F5Z009QL", "/subtree"]
  );
});

test("rejects broad, non-USB and unresolved PnP targets", () => {
  for (const target of ["", "USB\\*", "ROOT\\SYSTEM", "USB", "USB\\VID_2D95&PID_6013\\PHONE; pnputil /scan-devices"]) {
    assert.throws(() => assertExactUsbInstanceId(target), /unsafe exact PnP instance id/);
  }
});

test("requires a distinct exact scan parent for a destructive rebuild", () => {
  assert.deepEqual(
    assertDistinctExactUsbInstances("USB\\PHONE\\CHILD", "USB\\PHONE\\ROOT"),
    { target: "USB\\PHONE\\CHILD", scan: "USB\\PHONE\\ROOT" }
  );
  assert.throws(
    () => assertDistinctExactUsbInstances("USB\\PHONE\\ROOT", "usb\\phone\\root", "same node"),
    /same node/
  );
});
