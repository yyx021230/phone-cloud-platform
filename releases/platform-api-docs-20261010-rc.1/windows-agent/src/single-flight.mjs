export function createSingleFlightRunner(run) {
  let active = null;

  return (...args) => {
    if (active) return active;
    active = Promise.resolve()
      .then(() => run(...args))
      .finally(() => {
        active = null;
      });
    return active;
  };
}
