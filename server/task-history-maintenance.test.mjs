import assert from "node:assert/strict";
import test from "node:test";
import { compactTaskPayload, maintainTaskHistory, normalizeLoadedTaskHistory, trimTaskEventHistory } from "./task-history-maintenance.mjs";

test("unchanged histories are not read, copied or serialized by repeated maintenance", () => {
  const event = { get detail() { assert.fail("maintenance must not inspect event payloads"); } };
  const result = { get detail() { assert.fail("maintenance must not inspect results"); } };
  const events = [event];
  const task = { status: "succeeded", events, result };
  for (let i = 0; i < 20; i++) maintainTaskHistory([task]);
  assert.equal(task.events, events);
  assert.equal(task.events[0], event);
  assert.equal(task.result, result);
});

test("payload cleanup preserves running inputs and terminal evidence", () => {
  for (const status of ["queued", "running", "stalled", "succeeded", "failed", "expired", "cancelled"]) {
    const task = { status, qrImageDataUrl: "input", imageDataUrls: ["input"], payload: { qrImageDataUrl: "input", imageDataUrl: "input", imageDataUrls: ["input"], xhsTaskId: "linked" }, result: { screenshot: { dataUrl: "evidence" } } };
    compactTaskPayload(task);
    assert.equal(task.payload.xhsTaskId, "linked");
    assert.equal(task.result.screenshot.dataUrl, "evidence");
    assert.equal(Boolean(task.qrImageDataUrl), ["queued", "running", "stalled"].includes(status));
    assert.equal(Boolean(task.payload.imageDataUrl), ["queued", "running", "stalled"].includes(status));
  }
});

test("event cap exactly retains legacy newest-100 ordering, including ties and invalid dates", () => {
  const events = Array.from({ length: 130 }, (_, i) => ({ eventId: i, createdAt: i % 13 === 0 ? "invalid" : new Date((i % 30) * 1000).toISOString() }));
  const toTime = v => { const t = new Date(v || 0).getTime(); return Number.isFinite(t) ? t : 0; };
  const expected = events.slice().sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt)).slice(0, 100).reverse();
  const task = { events };
  trimTaskEventHistory(task);
  assert.deepEqual(task.events, expected);
  const retained = task.events;
  trimTaskEventHistory(task);
  assert.equal(task.events, retained);
});

test("no permanent visited cache: later appends, replacements and terminal transitions are handled", () => {
  const task = { status: "running", events: [], payload: { imageDataUrl: "input" } };
  maintainTaskHistory([task]);
  task.events.push(...Array.from({ length: 101 }, (_, i) => ({ createdAt: new Date(i * 1000).toISOString() })));
  task.status = "failed";
  maintainTaskHistory([task]);
  assert.equal(task.events.length, 100);
  assert.equal(task.payload.imageDataUrl, undefined);
  task.status = "running";
  task.payload.imageDataUrl = "new-input";
  task.events = [{ createdAt: new Date().toISOString(), detail: { revision: 1 } }];
  maintainTaskHistory([task]);
  task.events[0].detail.revision = 2;
  maintainTaskHistory([task]);
  assert.equal(task.payload.imageDataUrl, "new-input");
  assert.equal(task.events[0].detail.revision, 2);
});

test("legacy initialization sanitizes retained events once and yields by work budget", async () => {
  const task = { status: "failed", result: { secretShape: "synthetic" }, events: Array.from({ length: 103 }, (_, i) => ({ createdAt: new Date(i * 1000).toISOString(), message: "x".repeat(3000), detail: { revision: 1 } })) };
  let events = 0, results = 0, yields = 0, time = 0;
  await normalizeLoadedTaskHistory([[task]], {
    sanitizeEvent: e => { events++; time++; return { ...e, message: e.message.slice(0, 2000), detail: { ...e.detail } }; },
    sanitizeResult: r => { results++; return { normalized: true }; },
    now: () => time, budgetMs: 4,
    yieldTurn: async () => { yields++; }
  });
  assert.equal(events, 100);
  assert.equal(results, 1);
  assert.equal(yields, 25);
  assert.equal(task.events[0].message.length, 2000);
  assert.deepEqual(task.result, { normalized: true });
  maintainTaskHistory([task]);
  assert.equal(events, 100);
});

test("initialization yields even for many empty tasks, without changing active results", async () => {
  const result = { recoveredAt: "synthetic" };
  const tasks = Array.from({ length: 201 }, () => ({ status: "running", events: [], result }));
  let yields = 0;
  await normalizeLoadedTaskHistory([tasks, undefined], {
    sanitizeEvent: e => e, sanitizeResult: () => assert.fail("active result must be preserved"),
    now: () => 0, yieldTurn: async () => { yields++; }
  });
  assert.equal(yields, 2);
  assert.equal(tasks[0].result, result);
});
