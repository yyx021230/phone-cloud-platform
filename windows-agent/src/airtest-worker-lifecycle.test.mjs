import assert from "node:assert/strict";
import test from "node:test";
import {
  airtestWorkerLastActivityAt,
  isAirtestWorkerEvictable,
  selectAirtestWorkerEvictionCandidate,
  selectIdleAirtestWorkerSerials
} from "./airtest-worker-lifecycle.mjs";

test("uses last use time before process start time", () => {
  assert.equal(airtestWorkerLastActivityAt({ startedAt: 100, lastUsedAt: 200 }), 200);
  assert.equal(airtestWorkerLastActivityAt({ startedAt: 100 }), 100);
});

test("never evicts a busy, foreground, screen-controlled or preflight worker", () => {
  assert.equal(isAirtestWorkerEvictable({ serial: "busy", worker: { pending: {} } }), false);
  assert.equal(isAirtestWorkerEvictable({ serial: "task", worker: {}, activeSerials: new Set(["task"]) }), false);
  assert.equal(isAirtestWorkerEvictable({ serial: "screen", worker: {}, screenControlledSerials: new Set(["screen"]) }), false);
  assert.equal(isAirtestWorkerEvictable({ serial: "preflight", worker: {}, preflightSerials: new Set(["preflight"]) }), false);
  assert.equal(isAirtestWorkerEvictable({ serial: "idle", worker: {} }), true);
});

test("resident cap evicts the oldest cold worker before a warm lookup worker", () => {
  const workers = new Map([
    ["warm-old", { lastUsedAt: 100 }],
    ["cold-new", { lastUsedAt: 300 }],
    ["incoming", { lastUsedAt: 400 }]
  ]);
  const candidate = selectAirtestWorkerEvictionCandidate({
    workers,
    incomingSerial: "incoming",
    warmUntilBySerial: new Map([["warm-old", 10_000]]),
    now: 1_000
  });
  assert.equal(candidate.serial, "cold-new");
});

test("resident cap can recycle the least recently used warm worker when every idle worker is warm", () => {
  const workers = new Map([
    ["warm-old", { lastUsedAt: 100 }],
    ["warm-new", { lastUsedAt: 300 }]
  ]);
  const candidate = selectAirtestWorkerEvictionCandidate({
    workers,
    warmUntilBySerial: new Map([["warm-old", 10_000], ["warm-new", 10_000]]),
    now: 1_000
  });
  assert.equal(candidate.serial, "warm-old");
});

test("idle cleanup keeps warm sessions and all protected workers", () => {
  const workers = new Map([
    ["expired", { lastUsedAt: 100 }],
    ["warm", { lastUsedAt: 100 }],
    ["active", { lastUsedAt: 100 }],
    ["screen", { lastUsedAt: 100 }],
    ["preflight", { lastUsedAt: 100 }],
    ["recent", { lastUsedAt: 950 }]
  ]);
  assert.deepEqual(selectIdleAirtestWorkerSerials({
    workers,
    idleMs: 500,
    activeSerials: new Set(["active"]),
    screenControlledSerials: new Set(["screen"]),
    preflightSerials: new Set(["preflight"]),
    warmUntilBySerial: new Map([["warm", 2_000]]),
    now: 1_000
  }), ["expired"]);
});
