export function createPersistencePolicy({
  structuredWritesEnabled,
  saveSnapshot,
  scheduleCheckpoint
} = {}) {
  if (typeof saveSnapshot !== "function") throw new TypeError("saveSnapshot is required");
  if (typeof scheduleCheckpoint !== "function") throw new TypeError("scheduleCheckpoint is required");

  const deferredWrites = new Set();

  const policy = {
    async persist(structuredWrite) {
      if (!structuredWritesEnabled) return saveSnapshot();
      if (typeof structuredWrite !== "function") throw new TypeError("structuredWrite is required");
      const result = await structuredWrite();
      scheduleCheckpoint();
      return result;
    },

    persistDeferred(structuredWrite, { onError } = {}) {
      if (!structuredWritesEnabled) return policy.persist(structuredWrite);
      if (typeof structuredWrite !== "function") throw new TypeError("structuredWrite is required");
      const pending = Promise.resolve()
        .then(structuredWrite)
        .then((result) => {
          scheduleCheckpoint();
          return result;
        })
        .catch((error) => {
          if (typeof onError === "function") {
            onError(error);
            return undefined;
          }
          throw error;
        })
        .finally(() => deferredWrites.delete(pending));
      deferredWrites.add(pending);
      return pending;
    },

    async flushDeferred() {
      await Promise.all([...deferredWrites]);
    },

    deferredCount() {
      return deferredWrites.size;
    }
  };

  return policy;
}
