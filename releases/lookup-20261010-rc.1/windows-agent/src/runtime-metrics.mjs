import os from "node:os";

export function createProcessRuntimeMetrics(options = {}) {
  const now = options.now || Date.now;
  const cpuUsage = options.cpuUsage || process.cpuUsage;
  const memoryUsage = options.memoryUsage || process.memoryUsage;
  const totalmem = options.totalmem || os.totalmem;
  const freemem = options.freemem || os.freemem;
  const uptime = options.uptime || process.uptime;
  let previousAt = now();
  let previousCpu = cpuUsage();

  return {
    snapshot() {
      const capturedAt = now();
      const elapsedMs = Math.max(1, capturedAt - previousAt);
      const cpuDelta = cpuUsage(previousCpu);
      const memory = memoryUsage();
      const totalMemory = Math.max(1, Number(totalmem() || 0));
      const freeMemory = Math.max(0, Number(freemem() || 0));
      previousAt = capturedAt;
      previousCpu = cpuUsage();
      return {
        processCpuPercent: round((Number(cpuDelta.user || 0) + Number(cpuDelta.system || 0)) / 1_000 / elapsedMs * 100, 1),
        processRssMb: toMb(memory.rss),
        processHeapUsedMb: toMb(memory.heapUsed),
        hostMemoryUsedPercent: round((1 - Math.min(totalMemory, freeMemory) / totalMemory) * 100, 1),
        hostFreeMemoryMb: toMb(freeMemory),
        uptimeSeconds: Math.max(0, Math.round(Number(uptime() || 0)))
      };
    }
  };
}

function toMb(bytes) {
  return round(Math.max(0, Number(bytes || 0)) / 1024 / 1024, 1);
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}
