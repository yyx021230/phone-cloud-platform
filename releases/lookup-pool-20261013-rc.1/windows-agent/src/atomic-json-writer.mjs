import fs from "node:fs/promises";
import path from "node:path";

export function createAtomicJsonWriter(targetPath, options = {}) {
  const target = String(targetPath || "").trim();
  if (!target) throw new Error("atomic_json_target_required");

  const fileSystem = options.fileSystem || fs;
  const mode = options.mode ?? 0o600;
  let writeChain = Promise.resolve();
  let sequence = 0;

  return function writeJson(value) {
    // Capture the caller's state now. The queued write must not observe later
    // mutations made by another device sync while it is waiting its turn.
    const payload = JSON.stringify(value, null, 2);
    const job = writeChain.then(async () => {
      const temporary = `${target}.tmp-${process.pid}-${++sequence}`;
      await fileSystem.mkdir(path.dirname(target), { recursive: true });
      try {
        await fileSystem.writeFile(temporary, payload, { mode });
        await fileSystem.rename(temporary, target);
      } catch (error) {
        await fileSystem.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    // A failed write must not poison every later cursor save.
    writeChain = job.catch(() => {});
    return job;
  };
}
