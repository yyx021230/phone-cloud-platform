import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("routes per-device ADB commands through the device actor", () => {
  const start = source.indexOf("async function adb(serial, args, options = {})");
  const end = source.indexOf("async function api(", start);
  assert.ok(start >= 0 && end > start);
  const adbFunction = source.slice(start, end);
  assert.match(adbFunction, /deviceActors\.get\(serial\)/);
  assert.match(adbFunction, /runBackgroundAdb|runAutomationAdb|runInteractiveAdb/);
});

test("allows gallery imports to use the active screen-control device channel", () => {
  const start = source.indexOf("async function taskScreenGalleryImport(task)");
  const end = source.indexOf("async function taskXhsQrAirtestPoco", start);
  assert.ok(start >= 0 && end > start);
  const galleryImport = source.slice(start, end);
  assert.match(galleryImport, /assertAdbDeviceOnlineFast\(task\.adbSerial, \{ allowScreenControl: true \}\)/);
  assert.match(galleryImport, /\["shell", "mkdir", "-p", remoteDir\], \{ timeoutMs: 8_000, allowScreenControl: true \}/);
  assert.match(galleryImport, /\["push", localPath, remotePath\], \{ timeoutMs: 60_000, allowScreenControl: true \}/);
  assert.match(galleryImport, /scanMediaFile\(device\.adbSerial, remotePath, \{ allowScreenControl: true \}\)/);
});

test("runs only one automation preflight cycle while scans overlap", () => {
  assert.match(source, /const scheduleAutomationPreflight = createSingleFlightRunner\(runAutomationPreflightCycle\);/);
  assert.match(source, /async function runAutomationPreflightCycle\(devices\)/);
});
