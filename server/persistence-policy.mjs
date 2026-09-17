export function createPersistencePolicy({
  structuredWritesEnabled,
  saveSnapshot,
  scheduleCheckpoint
} = {}) {
  if (typeof saveSnapshot !== "function") throw new TypeError("saveSnapshot is required");
  if (typeof scheduleCheckpoint !== "function") throw new TypeError("scheduleCheckpoint is required");

  return {
    async persist(structuredWrite) {
      if (!structuredWritesEnabled) return saveSnapshot();
      if (typeof structuredWrite !== "function") throw new TypeError("structuredWrite is required");
      const result = await structuredWrite();
      scheduleCheckpoint();
      return result;
    }
  };
}
