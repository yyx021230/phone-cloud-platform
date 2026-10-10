import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Lookup terminal reports only. Retrying this mailbox never executes Android
// work, and a pending report reserves only its original serial/task.
export async function createLookupStatusOutbox({ directory, send, fileSystem = fs }) {
  const records = new Map();
  const durable = new Set();
  const inFlight = new Map();
  let available = true;
  const file = (id) => path.join(directory, `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
  try {
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of await fileSystem.readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = JSON.parse(await fileSystem.readFile(path.join(directory, name), "utf8"));
      if (!record.taskId || !record.adbSerial || !["succeeded", "failed", "cancelled"].includes(record.status)
        || file(record.taskId) !== path.join(directory, name)) throw new Error("lookup_status_outbox_invalid");
      records.set(record.taskId, record); durable.add(record.taskId);
    }
  } catch { available = false; }
  async function save(record) {
    if (durable.has(record.taskId)) return;
    const target = file(record.taskId), tmp = `${target}.tmp`;
    const handle = await fileSystem.open(tmp, "w", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    await fileSystem.rename(tmp, target);
    durable.add(record.taskId);
  }
  function flushOne(id) {
    if (!available) return Promise.resolve();
    if (inFlight.has(id)) return inFlight.get(id);
    const record = records.get(id);
    if (!record) return Promise.resolve();
    const attempt = (async () => {
      try {
        await save(record);
        const ack = await send(record);
        if (ack?.ok !== true || ack.task?.taskId !== id
          || !["succeeded", "failed", "cancelled", "expired"].includes(ack.task.status)) {
          throw new Error("lookup_terminal_ack_unconfirmed");
        }
        await fileSystem.rm(file(id), { force: true });
        durable.delete(id); records.delete(id);
      } catch { /* Preserve unknown ACKs and the original terminal result. */ }
    })().finally(() => { inFlight.delete(id); });
    inFlight.set(id, attempt);
    return attempt;
  }
  function flush() {
    return Promise.all([...records.keys()].map(flushOne));
  }
  return {
    isAvailable: () => available,
    async report(task, status, result) {
      if (!available) throw Object.assign(new Error("lookup_status_storage_unavailable"), { code: "lookup_status_storage_unavailable" });
      if (!records.has(task.taskId)) records.set(task.taskId, {
        taskId: task.taskId, adbSerial: task.adbSerial, status, result
      });
      // A local disk failure stays pending in memory and is retried by flush;
      // it must never turn a successful lookup into a business failure.
      await flushOne(task.taskId);
      return { pending: records.has(task.taskId) };
    },
    flush,
    pendingTasks: () => [...records.values()].map(({ taskId, adbSerial }) => ({ taskId, adbSerial }))
  };
}
