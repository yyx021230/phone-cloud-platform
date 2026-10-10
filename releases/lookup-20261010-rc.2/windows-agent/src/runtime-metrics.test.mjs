import assert from "node:assert/strict";
import test from "node:test";
import { createProcessRuntimeMetrics } from "./runtime-metrics.mjs";

test("reports bounded process and host resource measurements", () => {
  let now = 1_000;
  let cpu = { user: 1_000, system: 500 };
  const metrics = createProcessRuntimeMetrics({
    now: () => now,
    cpuUsage: (previous) => {
      if (!previous) return cpu;
      return { user: cpu.user - previous.user, system: cpu.system - previous.system };
    },
    memoryUsage: () => ({ rss: 200 * 1024 * 1024, heapUsed: 40 * 1024 * 1024 }),
    totalmem: () => 1_000 * 1024 * 1024,
    freemem: () => 250 * 1024 * 1024,
    uptime: () => 99
  });

  now += 1_000;
  cpu = { user: 501_000, system: 100_500 };
  assert.deepEqual(metrics.snapshot(), {
    processCpuPercent: 60,
    processRssMb: 200,
    processHeapUsedMb: 40,
    hostMemoryUsedPercent: 75,
    hostFreeMemoryMb: 250,
    uptimeSeconds: 99
  });
});
