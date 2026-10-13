import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { runXhsDataCollection } from "./xhs-data-collection.mjs";

test("actual Agent status serialization carries every collected note and zero count", async () => {
  const source = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs"), "utf8");
  const begin = source.indexOf("function compactTaskResultForStatus(");
  const end = source.indexOf("function normalizeEvidenceForTransport(", begin);
  const serialize = vm.runInNewContext(`${source.slice(begin, end)}; compactTaskResultForStatus`, {
    compactEventDetail: (value) => value, compactScreenshotForTransport: (value) => value
  });
  const collection = { ...snapshot(), notes: [{ title: "作品", list_like_count: 0 }] };
  const result = serialize({ collection });
  assert.equal(result.collection.notes[0].list_like_count, 0);
  assert.equal(result.collection.notes.length, 1);
});

const task = { taskId: "task-1", adbSerial: "TEST_SERIAL", payload: {
  automationJobId: "job-1", deviceName: "测试手机", xhsAppSlot: "app2"
} };
const snapshot = (complete = true) => ({ schema_version: 3, serial: task.adbSerial,
  device_name: "测试手机", app_slot: "app2", window_days: 30, complete, notes: [],
  window_start_date: "2026-09-14", window_end_date: "2026-10-13", stop_reason: complete ? "list_end_visible" : null });

async function harness(t, body) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-data-runner-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const settings = new Map([["screen_off_timeout", "60000"], ["enable_screen_on_proximity_sensor", "1"]]);
  const commands = [];
  const dependencies = {
    config: { pythonCommand: "fake-python", xhsDataCollectionRunnerPath: "fake-script", adbPath: "fake-adb" },
    cacheDir, deviceCachePath: "fake-cache", signal: undefined,
    adb: async (serial, args) => {
      assert.equal(serial, task.adbSerial); commands.push(args);
      if (args[2] === "get") return settings.get(args[4]);
      settings.set(args[4], args[5]); return "";
    },
    run: async (command, args) => {
      assert.equal(command, "fake-python");
      assert.equal(args[args.indexOf("--task-id") + 1], "job-1");
      assert.equal(args[args.indexOf("--app-slot") + 1], "app2");
      await body(args, settings, dependencies);
      return "";
    }
  };
  return { dependencies, settings, commands, outputPath: path.join(cacheDir, "xhs-data-collection", "task-1.json") };
}

test("collector maps a full snapshot and removes the task-private JSON", async (t) => {
  const h = await harness(t, async (args) => fs.writeFile(args.at(-1), JSON.stringify(snapshot())));
  const result = await runXhsDataCollection(task, h.dependencies);
  assert.equal(result.collection.complete, true);
  await assert.rejects(fs.stat(h.outputPath), { code: "ENOENT" });
  assert.equal(h.commands.filter((args) => args[2] === "put").length, 0);
});

test("exit 2 retains incomplete data instead of treating the result as empty", async (t) => {
  const h = await harness(t, async (args) => {
    await fs.writeFile(args.at(-1), JSON.stringify(snapshot(false)));
    throw Object.assign(new Error("bounded scan"), { code: 2 });
  });
  const result = await runXhsDataCollection(task, h.dependencies);
  assert.equal(result.collection.complete, false);
  assert.equal(result.errorCode, "recent_window_not_proven");
});

test("cancellation restores only this phone's temporary settings and preserves cancellation", async (t) => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("automation_task_cancelled"), { code: "automation_task_cancelled" });
  const h = await harness(t, async (_args, settings) => {
    settings.set("screen_off_timeout", "600000"); settings.set("enable_screen_on_proximity_sensor", "0");
    controller.abort(reason); throw reason;
  });
  h.dependencies.signal = controller.signal;
  await assert.rejects(runXhsDataCollection(task, h.dependencies), (error) => error === reason);
  assert.equal(h.settings.get("screen_off_timeout"), "60000");
  assert.equal(h.settings.get("enable_screen_on_proximity_sensor"), "1");
  assert.equal(h.commands.filter((args) => args[2] === "put").length, 2);
});

test("foreign account-slot output is rejected, and stale output cannot be reused", async (t) => {
  const h = await harness(t, async (args) => fs.writeFile(args.at(-1), JSON.stringify({ ...snapshot(), app_slot: "app1" })));
  await assert.rejects(runXhsDataCollection(task, h.dependencies), /output_mismatch/);
  await fs.writeFile(h.outputPath, JSON.stringify(snapshot()));
  h.dependencies.run = async () => { throw Object.assign(new Error("partial without output"), { code: 2 }); };
  await assert.rejects(runXhsDataCollection(task, h.dependencies), { code: "ENOENT" });
});

test("cancellation writes a cooperative marker before force-killing the Python runner", async (t) => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("automation_task_cancelled"), { code: "automation_task_cancelled" });
  let markerSeen = false;
  const h = await harness(t, async (args, _settings, dependencies) => {
    controller.abort(reason);
    const marker = args[args.indexOf("--cancel-file") + 1];
    for (let attempt = 0; attempt < 20; attempt++) {
      try { markerSeen = await fs.readFile(marker, "utf8") === "cancelled"; break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(markerSeen, true);
    throw Object.assign(new Error("Python acknowledged cancellation"), { code: 1 });
  });
  h.dependencies.signal = controller.signal;
  await assert.rejects(runXhsDataCollection(task, h.dependencies), (error) => error === reason);
  assert.equal(markerSeen, true);
});
