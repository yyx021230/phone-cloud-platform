import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { waitForXhsDataReservation } from "./xhs-data-collection.mjs";

const task = { type: "xhs_data_collect", taskId: "task-2", adbSerial: "TEST", payload: {
  automationJobId: "job-2", xhsAppSlot: "app2", deviceName: "手机" } };
const own = { kind: "xhs_data_collect", taskId: "job-2", appSlot: "app2" };
const row = occupancy => ({ adb: { serial: "test", state: "device" }, deviceName: "手机", occupancy });
async function fixture(t, devices) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-reservation-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "cache.json");
  const write = value => fs.writeFile(file, JSON.stringify(value));
  await write(devices);
  let elapsed = 0;
  const options = { deviceCachePath: file, timeoutMs: 1000, clock: () => elapsed,
    wait: async ms => { elapsed += ms; } };
  return { file, write, options };
}

test("old app1 reservation waits for exact app2 reservation without changing cache", async t => {
  const f = await fixture(t, [row({ ...own, taskId: "job-1", appSlot: "app1" })]);
  const advance = f.options.wait;
  let polls = 0;
  f.options.wait = async ms => { await advance(ms); polls++; await f.write([row(own)]); };
  assert.equal(await waitForXhsDataReservation(task, f.options), null);
  assert.equal(polls, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), [row(own)]);
});

for (const [name, occupancy] of [["real control session", { kind: "screen_control", taskId: "other" }],
  ["wrong slot", { ...own, appSlot: "app1" }], ["wrong job", { ...own, taskId: "job-other" }], ["not yet visible", null]]) {
  test(`${name} yields a bounded no-phone-action deferral`, async t => {
    const f = await fixture(t, [row(occupancy)]);
    const before = await fs.readFile(f.file, "utf8");
    const result = await waitForXhsDataReservation(task, f.options);
    assert.equal(result.errorCode, "xhs_data_reservation_pending");
    assert.equal(result.diagnostic.collectionStarted, false);
    assert.equal(result.diagnostic.phase, "before_device_actions");
    assert.equal(result.diagnostic.jobId, "job-2");
    assert.equal(result.collection, undefined);
    assert.equal(await fs.readFile(f.file, "utf8"), before);
  });
}

for (const [name, devices, code] of [
  ["offline", [{ ...row(own), adb: { serial: "test", state: "offline" } }], "xhs_data_device_offline"],
  ["unauthorized", [{ ...row(own), adb: { serial: "test", state: "unauthorized" } }], "xhs_data_device_offline"],
  ["duplicate serial", [row(own), row(own)], "xhs_data_inventory_mismatch"],
  ["wrong name", [{ ...row(own), deviceName: "other" }], "xhs_data_inventory_mismatch"],
  ["empty", [], "xhs_data_inventory_mismatch"]]) {
  test(`${name} is not retryable busy`, async t => {
    const f = await fixture(t, devices);
    assert.equal((await waitForXhsDataReservation(task, f.options)).errorCode, code);
  });
}

test("stale or corrupt cache never grants ownership or busy retry", async t => {
  const f = await fixture(t, [row(own)]);
  await fs.utimes(f.file, new Date(0), new Date(0));
  assert.equal((await waitForXhsDataReservation(task, f.options)).errorCode, "xhs_data_inventory_unavailable");
  await fs.writeFile(f.file, "{");
  assert.equal((await waitForXhsDataReservation(task, f.options)).errorCode, "xhs_data_inventory_unavailable");
});

test("cancellation during waiting is preserved and never reported as retry", async t => {
  const f = await fixture(t, [row(null)]), controller = new AbortController();
  const reason = new Error("automation_task_cancelled");
  f.options.signal = controller.signal;
  f.options.wait = async () => controller.abort(reason);
  await assert.rejects(waitForXhsDataReservation(task, f.options), e => e === reason);
});

test("real abortable timer preserves the Agent cancellation reason", async t => {
  const f = await fixture(t, [row(null)]), controller = new AbortController();
  const reason = Object.assign(new Error("automation_task_cancelled"), { code: "automation_task_cancelled" });
  const timer = setTimeout(() => controller.abort(reason), 10);
  t.after(() => clearTimeout(timer));
  await assert.rejects(waitForXhsDataReservation(task, { deviceCachePath: f.file, signal: controller.signal }), e => e === reason);
});

test("actual Agent entry/status path defers with no ADB, Poco, settings, runner or evidence actions", async t => {
  const f = await fixture(t, [row({ kind: "screen_control", taskId: "other" })]);
  const source = await fs.readFile(new URL("./index.mjs", import.meta.url), "utf8");
  const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const forbidden = () => { throw new Error("unexpected phone action"); };
  const reports = [], events = [];
  let uploadFails = false;
  const execute = vm.runInNewContext([
    slice("async function taskXhsDataCollect(", "async function taskXhsPublish("),
    slice("async function runTask(", "function preemptSmsSyncForScreen("),
    slice("function compactTaskResultForStatus(", "function normalizeEvidenceForTransport("),
    "runTask"
  ].join("\n"), {
    config: {}, fileExists: async () => true, deviceScanCachePath: () => f.file,
    waitForXhsDataReservation: () => waitForXhsDataReservation(task, f.options),
    assertAdbDeviceOnlineFast: forbidden, ensureXmlUiAutomatorReady: forbidden,
    runXhsDataCollection: forbidden, captureFailureEvidence: forbidden, scanAndSync: forbidden,
    shouldRunPostTaskDeviceScan: () => false, log: () => {},
    taskEvent: async (...args) => events.push(args), compactTaskResultForEvent: x => x,
    taskStatus: async (task, status, result) => {
      if (uploadFails) throw new Error("status response lost");
      reports.push({ status, result });
    },
    isAutomationTaskCancellation: () => false, isScreenPriorityCancellation: () => false,
    taskFailureResult: forbidden, compactEventDetail: x => x, compactScreenshotForTransport: x => x
  });
  await execute(task);
  assert.equal(reports.length, 1); assert.equal(reports[0].status, "failed");
  assert.equal(reports[0].result.diagnostic.phase, "before_device_actions");
  assert.match(events.at(-1)[3], /等待/);
  const serialize = vm.runInNewContext(`${slice("function compactTaskResultForStatus(", "function normalizeEvidenceForTransport(")};compactTaskResultForStatus`, {
    compactEventDetail: x => x, compactScreenshotForTransport: x => x
  });
  const wire = serialize(reports[0].result);
  assert.equal(wire.errorCode, "xhs_data_reservation_pending");
  assert.equal(wire.diagnostic.collectionStarted, false);
  uploadFails = true;
  await assert.rejects(execute(task), /status response lost/);
  assert.equal(reports.length, 1); // no failure-evidence collection or second status
});
