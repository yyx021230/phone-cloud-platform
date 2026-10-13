import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLookupStatusOutbox } from "./lookup-status-outbox.mjs";

test("a lost status ACK retains the exact successful result across restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-status-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sent = [], task = { taskId: "synthetic", adbSerial: "SYNTHETIC" };
  let fail = true;
  const send = async (record) => { sent.push(structuredClone(record)); if (fail) throw Error("lost ACK"); return { ok: true, task: { taskId: record.taskId, status: record.status } }; };
  const first = await createLookupStatusOutbox({ directory, send });
  assert.equal((await first.report(task, "succeeded", { realNameTailCharacter: "甲" })).pending, true);
  assert.deepEqual(first.pendingTasks(), [task]);
  assert.equal((await fs.stat(path.join(directory, (await fs.readdir(directory))[0]))).mode & 0o777, 0o600);
  const restarted = await createLookupStatusOutbox({ directory, send });
  fail = false; await restarted.flush();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[1].status, "succeeded");
  assert.deepEqual(restarted.pendingTasks(), []);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("disk failure cannot discard a name or send an undurable result", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-status-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let fail = true, sends = 0;
  const fileSystem = { ...fs, open: async (...args) => { if (fail) throw Error("disk"); return fs.open(...args); } };
  const box = await createLookupStatusOutbox({ directory, fileSystem, send: async (record) => { sends++; return { ok: true, task: { taskId: record.taskId, status: record.status } }; } });
  await box.report({ taskId: "x", adbSerial: "S" }, "succeeded", { realNameTailCharacter: "甲" });
  assert.equal(sends, 0); assert.equal(box.pendingTasks().length, 1);
  fail = false; await Promise.all([box.flush(), box.flush()]);
  assert.equal(sends, 1); assert.equal(box.pendingTasks().length, 0);
});


test("a malformed or foreign ACK cannot remove the original successful report", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-status-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let ack = {}, sent;
  const box = await createLookupStatusOutbox({ directory, send: async (record) => { sent = record; return ack; } });
  const task = { taskId: "original", adbSerial: "S" };
  await box.report(task, "succeeded", { realNameTailCharacter: "甲" });
  assert.equal(box.pendingTasks().length, 1);
  ack = { ok: true, task: { taskId: "foreign", status: "succeeded" } }; await box.flush();
  assert.equal(box.pendingTasks().length, 1);
  await box.report(task, "failed", { error: "late failure" });
  assert.equal(sent.status, "succeeded"); assert.equal(sent.result.realNameTailCharacter, "甲");
  ack = { ok: true, task: { taskId: "original", status: "succeeded" } }; await box.flush();
  assert.equal(box.pendingTasks().length, 0);
});


test("one phone's slow ACK cannot delay another phone's report or duplicate an in-flight send", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-status-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let release, began;
  const started = new Promise((resolve) => { began = resolve; });
  const sends = [];
  const box = await createLookupStatusOutbox({ directory, send: async (record) => {
    sends.push(record.taskId);
    if (record.taskId === "slow") { began(); await new Promise((resolve) => { release = resolve; }); }
    return { ok: true, task: { taskId: record.taskId, status: record.status } };
  } });
  const slow = box.report({ taskId: "slow", adbSerial: "SLOW" }, "succeeded", {});
  await started;
  await box.report({ taskId: "fast", adbSerial: "FAST" }, "succeeded", {});
  assert.deepEqual(box.pendingTasks(), [{ taskId: "slow", adbSerial: "SLOW" }]);
  const concurrentFlush = box.flush();
  release(); await Promise.all([slow, concurrentFlush]);
  assert.deepEqual(sends, ["slow", "fast"]);
  assert.deepEqual(box.pendingTasks(), []);
});


test("unreadable or corrupt lookup storage disables lookup without aborting Agent initialization", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-status-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let sends = 0;
  const brokenDisk = await createLookupStatusOutbox({ directory,
    fileSystem: { ...fs, mkdir: async () => { throw Error("unreadable"); } }, send: async () => { sends++; } });
  assert.equal(brokenDisk.isAvailable(), false);
  await fs.writeFile(path.join(directory, "a".repeat(64) + ".json"), "invalid JSON");
  const corrupt = await createLookupStatusOutbox({ directory, send: async () => { sends++; } });
  assert.equal(corrupt.isAvailable(), false);
  await assert.rejects(corrupt.report({ taskId: "x", adbSerial: "S" }, "succeeded", {}), /lookup_status_storage_unavailable/);
  await corrupt.flush(); assert.equal(sends, 0);
  assert.equal((await fs.readdir(directory)).length, 1, "corrupt evidence is never deleted silently");
});
