import { createAdbPriorityQueue } from "./adb-priority-queue.mjs";

const PRIORITY = {
  screen: 100,
  interactive: 80,
  automation: 50,
  background: 10
};

export function createDeviceActorManager(options = {}) {
  const actors = new Map();

  const get = (serial) => {
    const key = String(serial || "").trim();
    if (!key) throw new Error("device_actor_serial_required");
    if (!actors.has(key)) actors.set(key, createDeviceActor(key, options));
    return actors.get(key);
  };

  return {
    get,
    health() {
      return [...actors.values()].map((actor) => actor.health());
    },
    close(reason) {
      for (const actor of actors.values()) actor.close(reason);
      actors.clear();
    }
  };
}

function createDeviceActor(serial, options) {
  const queue = createAdbPriorityQueue(options);
  const run = (operation, priority, runOptions = {}) => queue.enqueue(operation, {
    ...runOptions,
    priority,
    label: runOptions.label || "adb"
  });
  return {
    serial,
    runScreenLifecycle: (operation, runOptions) => run(operation, PRIORITY.screen, runOptions),
    runInteractiveAdb: (operation, runOptions) => run(operation, PRIORITY.interactive, runOptions),
    runAutomationAdb: (operation, runOptions) => run(operation, PRIORITY.automation, runOptions),
    runBackgroundAdb: (operation, runOptions) => run(operation, PRIORITY.background, runOptions),
    health() {
      return { serial, ...queue.health() };
    },
    close: (reason) => queue.close(reason)
  };
}
