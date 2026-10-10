import assert from "node:assert/strict";
import test from "node:test";
import {
  SCREEN_IDLE_DECISION_MS,
  SCREEN_IDLE_TIMEOUT_MS,
  ScreenInactivityGuard
} from "../public/screen-inactivity-guard.js";

class FakeClock {
  currentTime = 0;
  nextId = 1;
  tasks = new Map();

  now = () => this.currentTime;

  setTimeout = (callback, delay) => this.#schedule(callback, delay, 0);

  clearTimeout = (id) => this.tasks.delete(id);

  setInterval = (callback, delay) => this.#schedule(callback, delay, Math.max(1, delay));

  clearInterval = (id) => this.tasks.delete(id);

  advance(ms) {
    const targetTime = this.currentTime + ms;
    while (true) {
      const nextTask = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= targetTime)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!nextTask) break;
      const [id, task] = nextTask;
      this.currentTime = task.at;
      if (task.interval > 0) task.at += task.interval;
      else this.tasks.delete(id);
      task.callback();
    }
    this.currentTime = targetTime;
  }

  jump(ms) {
    this.currentTime += ms;
  }

  #schedule(callback, delay, interval) {
    const id = this.nextId++;
    this.tasks.set(id, {
      at: this.currentTime + Math.max(0, delay),
      callback,
      interval
    });
    return id;
  }
}

function createGuard(clock, overrides = {}) {
  return new ScreenInactivityGuard({
    now: clock.now,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    setTicker: clock.setInterval,
    clearTicker: clock.clearInterval,
    ...overrides
  });
}

test("screen inactivity defaults to a ten-minute idle window and ten-second decision window", () => {
  assert.equal(SCREEN_IDLE_TIMEOUT_MS, 600_000);
  assert.equal(SCREEN_IDLE_DECISION_MS, 10_000);
});

test("real activity restarts the ten-minute idle deadline", () => {
  const clock = new FakeClock();
  const warnings = [];
  const guard = createGuard(clock, { onWarning: (warning) => warnings.push(warning) });

  guard.start();
  clock.advance(599_000);
  assert.equal(warnings.length, 0);
  assert.equal(guard.activity(), true);
  clock.advance(599_999);
  assert.equal(warnings.length, 0);
  clock.advance(1);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].open, true);
  assert.equal(warnings[0].seconds, 10);
});

test("an unanswered warning disconnects once after ten seconds", () => {
  const clock = new FakeClock();
  const warnings = [];
  const countdowns = [];
  let timeoutCount = 0;
  const guard = createGuard(clock, {
    onWarning: (warning) => warnings.push(warning),
    onCountdown: (countdown) => countdowns.push(countdown.seconds),
    onTimeout: () => { timeoutCount += 1; }
  });

  guard.start();
  clock.advance(SCREEN_IDLE_TIMEOUT_MS);
  assert.equal(warnings.at(-1).open, true);
  assert.equal(countdowns[0], 10);
  clock.advance(SCREEN_IDLE_DECISION_MS - 1);
  assert.equal(timeoutCount, 0);
  clock.advance(1);

  assert.equal(timeoutCount, 1);
  assert.equal(warnings.at(-1).open, false);
  clock.advance(30_000);
  assert.equal(timeoutCount, 1);
});

test("continue control is the only warning action that renews the session", () => {
  const clock = new FakeClock();
  const warnings = [];
  let timeoutCount = 0;
  const guard = createGuard(clock, {
    onWarning: (warning) => warnings.push(warning),
    onTimeout: () => { timeoutCount += 1; }
  });

  guard.start();
  clock.advance(SCREEN_IDLE_TIMEOUT_MS);
  clock.advance(4_000);
  assert.equal(guard.activity(), false, "background activity must not dismiss an open warning");
  assert.equal(guard.continueSession(), true);
  assert.equal(warnings.at(-1).open, false);
  clock.advance(SCREEN_IDLE_DECISION_MS);
  assert.equal(timeoutCount, 0);
  clock.advance(SCREEN_IDLE_TIMEOUT_MS - SCREEN_IDLE_DECISION_MS);
  assert.equal(warnings.at(-1).open, true, "continuing starts a fresh ten-minute window");
});

test("reconcile expires an overdue warning after browser timer throttling", () => {
  const clock = new FakeClock();
  let timeoutCount = 0;
  const guard = createGuard(clock, { onTimeout: () => { timeoutCount += 1; } });

  guard.start();
  clock.jump(SCREEN_IDLE_TIMEOUT_MS);
  guard.reconcile();
  clock.jump(SCREEN_IDLE_DECISION_MS);
  guard.reconcile();

  assert.equal(timeoutCount, 1);
});
