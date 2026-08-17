import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "index.mjs"), "utf8");

test("a task rebuilds a missing Poco worker from a fresh successful preflight", () => {
  const block = source.match(/const cachedReady = automationPreflightBySerial[\s\S]*?if \(automationPreflightRunning\.has\(serial\)\)/)?.[0] || "";
  assert.match(block, /cachedReady\?\.ok/);
  assert.match(block, /await getAirtestWorker\(serial\);/);
  assert.doesNotMatch(block, /if \(worker && !worker\.exited\)/);
});

test("a cold foreground task probes a worker before running the full preflight", () => {
  const block = source.match(/if \(options\.task\) \{[\s\S]*?const cachedReady = automationPreflightBySerial/)?.[0] || "";
  assert.match(block, /const startup = getAirtestWorker\(serial\)/);
  assert.match(block, /delay\(10_000\)/);
  assert.match(block, /await probeAirtestWorker\(worker\)/);
  assert.match(block, /falling back to full preflight/);
});

test("a foreground QR task does not wait 60 seconds behind background preflight", () => {
  const block = source.match(/if \(automationPreflightRunning\.has\(serial\)\)[\s\S]*?automationPreflightRunning\.add\(serial\)/)?.[0] || "";
  assert.match(block, /Date\.now\(\) \+ 8_000/);
  assert.match(block, /await delay\(250\)/);
  assert.match(block, /foreground task bypassed background automation preflight wait/);
  assert.doesNotMatch(block, /Date\.now\(\) \+ 60_000/);
});

test("a new Poco worker clears only its device's stale instrumentation", () => {
  const python = fs.readFileSync(path.resolve(here, "../scripts/xhs_airtest_poco.py"), "utf8");
  const workerBlock = python.match(/def run_worker\(serial, adb_path\):[\s\S]*?\n\ndef main/)?.[0] || "";
  assert.match(python, /def reset_stale_poco_instrumentation/);
  assert.match(python, /"com\.netease\.open\.pocoservice\.test"/);
  assert.match(workerBlock, /reset_stale_poco_instrumentation\(adb_path, serial\)/);
});
