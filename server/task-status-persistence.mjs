// Keep the exact failed mutation until a subsequent status ACK can save it.
// Concurrent duplicate reports join the same write; they cannot acknowledge
// an in-memory terminal state ahead of that write.
export function createTaskStatusPersistence() {
  const pending = new Map();
  return {
    async persist(taskId, write) {
      let entry = pending.get(taskId);
      if (!entry) { entry = { write, running: null }; pending.set(taskId, entry); }
      if (!entry.running) {
        entry.running = Promise.resolve().then(entry.write).then((result) => {
          pending.delete(taskId);
          return result;
        }).finally(() => { entry.running = null; });
      }
      return entry.running;
    }
  };
}
