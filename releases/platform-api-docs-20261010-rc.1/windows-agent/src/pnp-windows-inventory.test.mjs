import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPhysicalAndroidUsbInventoryScript,
  parsePhysicalAndroidUsbInventory,
  usbHubInterfacePath
} from "./pnp-windows-inventory.mjs";

test("inventory script recognizes generic WinUSB ADB signatures", () => {
  const script = buildPhysicalAndroidUsbInventoryScript(["12d1", "2D95", "unsafe"]);
  assert.match(script, /Subclass_42&Prot_01/);
  assert.match(script, /Class_ff&SubClass_42&Prot_01/);
  assert.match(script, /MS_COMP_WINUSB/);
  assert.match(script, /'12D1','2D95'/);
  assert.doesNotMatch(script, /unsafe/);
  assert.doesNotMatch(script, /};\s*elseif/);
});

test("parses the ADB interface kind and exact downstream port mapping", () => {
  const [row] = parsePhysicalAndroidUsbInventory([
    "4TBBB25730100808",
    "USB\\VID_1A40&PID_0101\\9&188f348e&0&2",
    "USB\\VID_12D1&PID_107D\\4TBBB25730100808",
    "OK",
    "CM_PROB_NONE",
    "USB\\VID_12D1&PID_107D&MI_02\\B&121EDA97&7&0002",
    "OK",
    "CM_PROB_NONE",
    "False",
    "True",
    "generic_winusb_adb",
    "4"
  ].join("\t"));
  assert.equal(row.serial, "4TBBB25730100808");
  assert.equal(row.adbInterfaceKind, "generic_winusb_adb");
  assert.equal(row.portNumber, 4);
  assert.equal(row.hubInterfacePath, "\\\\?\\USB#VID_1A40&PID_0101#9&188f348e&0&2#{f18a0e88-c30c-11d0-8815-00a0c906bed8}");
});

test("does not construct a hub path from an unsafe or empty instance id", () => {
  assert.equal(usbHubInterfacePath(""), "");
  assert.equal(usbHubInterfacePath("PCI\\ROOT"), "");
});
