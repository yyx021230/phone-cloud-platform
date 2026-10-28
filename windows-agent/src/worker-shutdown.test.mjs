import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pocoForwardLocals, stopWorkerWithFallback, waitForWorkerExit } from "./worker-shutdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("waits for a worker to exit without killing its ADB child", async () => {
  const worker = { exited: false };
  setTimeout(() => { worker.exited = true; }, 10);
  assert.equal(await waitForWorkerExit(worker, 100), true);
});

test("times out when a worker does not exit", async () => {
  assert.equal(await waitForWorkerExit({ exited: false }, 15), false);
});

test("gracefully stops a worker without invoking the forced fallback", async () => {
  const worker = { exited: false };
  let forced = 0;
  const result = await stopWorkerWithFallback(worker, {
    gracefulTimeoutMs: 50,
    pollMs: 1,
    requestStop() { worker.exited = true; },
    forceStop() { forced += 1; }
  });
  assert.deepEqual(result, { exited: true, forced: false });
  assert.equal(forced, 0);
});

test("force-stops a worker that ignores the graceful exit request", async () => {
  const worker = { exited: false };
  let forced = 0;
  const result = await stopWorkerWithFallback(worker, {
    gracefulTimeoutMs: 5,
    forcedTimeoutMs: 50,
    pollMs: 1,
    forceStop() {
      forced += 1;
      worker.exited = true;
    }
  });
  assert.deepEqual(result, { exited: true, forced: true });
  assert.equal(forced, 1);
});

test("coalesces concurrent stop requests for the same worker", async () => {
  const worker = { exited: false };
  let requests = 0;
  const options = {
    gracefulTimeoutMs: 50,
    pollMs: 1,
    async requestStop() {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      worker.exited = true;
    }
  };
  const [first, second] = await Promise.all([
    stopWorkerWithFallback(worker, options),
    stopWorkerWithFallback(worker, options)
  ]);
  assert.deepEqual(first, { exited: true, forced: false });
  assert.deepEqual(second, first);
  assert.equal(requests, 1);
});

test("selects only Poco forwards for one exact device", () => {
  const output = [
    "serial-a tcp:12001 tcp:10080",
    "serial-a tcp:12002 tcp:10081",
    "serial-a tcp:12003 localabstract:scrcpy_1",
    "serial-b tcp:22001 tcp:10080",
    "serial-a tcp:12001 tcp:10080"
  ].join("\r\n");
  assert.deepEqual(pocoForwardLocals(output, "serial-a"), ["tcp:12001", "tcp:12002"]);
});

test("the Python worker explicitly stops Poco with bounded ADB cleanup", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_airtest_poco.py"), "utf8");
  assert.match(source, /finally:\s*\n\s*try:\s*\n\s*if verify_lookup_stop:[\s\S]*?stop_stable_poco\(poco, adb_path, serial, verify=True\)[\s\S]*?else:\s*\n\s*stop_stable_poco\(poco, adb_path, serial\)/);
  assert.match(source, /packages = \("com\.netease\.open\.pocoservice", "com\.netease\.open\.pocoservice\.test"\)/);
  assert.match(source, /for package_name in packages:\s*try:\s*run_adb\(adb_path, serial, \["shell", "am", "force-stop", package_name\], timeout=5\)/);
  assert.match(source, /run_adb\(adb_path, serial, \["forward", "--remove", local\], timeout=1\)/);
  assert.doesNotMatch(source, /poco\.remove_forwards\(\)/);
});

test("the Python worker disables Poco's unbounded instrumentation keepalive", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_airtest_poco.py"), "utf8");
  assert.match(source, /class DisabledKeepRunningInstrumentationThread/);
  assert.match(source, /uiautomation\.KeepRunningInstrumentationThread = DisabledKeepRunningInstrumentationThread/);
  assert.match(source, /create_stable_poco\(use_airtest_input=True, screenshot_each_action=False\)/);
});

test("the QR flow treats a foregrounded XHS launch wait timeout as recoverable", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_airtest_poco.py"), "utf8");
  assert.match(source, /def start_xhs_activity\(/);
  assert.match(source, /except subprocess\.TimeoutExpired/);
  assert.match(source, /am_start_wait_timeout_but_foreground_ready/);
  assert.match(source, /start_xhs_without_wait/);
});

test("the QR flow scopes popup permissions and avoids a fixed gallery tap first", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_airtest_poco.py"), "utf8");
  assert.match(source, /permission_prompt = any\(/);
  assert.match(source, /notification_prompt = any\(/);
  assert.match(source, /免流量升级/);
  assert.match(source, /Never tap a generic "确认" here/);
  assert.match(source, /Prefer a real gallery thumbnail/);
  assert.doesNotMatch(source, /album_first_image_coordinate_fallback/);
  assert.doesNotMatch(source, /click_me_bottom_right_fallback/);
  assert.match(source, /dry_run_album_ready/);
  assert.match(source, /设备仍处于锁屏状态/);
  assert.match(source, /wm", "dismiss-keyguard/);
  assert.match(source, /reset_launch_surface/);
  assert.match(source, /start_xhs_foreground_retry/);
});
