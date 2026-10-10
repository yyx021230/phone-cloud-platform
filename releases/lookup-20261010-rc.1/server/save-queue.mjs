export function createSaveQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(operation) {
      const run = tail.catch(() => {}).then(operation);
      tail = run;
      return run;
    }
  };
}
