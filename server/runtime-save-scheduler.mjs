export function createRuntimeSaveScheduler(options = {}) {
  const {
    save,
    isBusy = () => false,
    schedule = setTimeout,
    cancel = clearTimeout,
    onError = () => {},
    delayMs = 2_000,
    busyRetryMs = 5_000
  } = options;
  if (typeof save !== "function") throw new Error("runtime_save_required");

  let dirty = false;
  let timer = null;
  let saving = null;

  const arm = (delay) => {
    if (timer || saving) return;
    timer = schedule(() => {
      timer = null;
      return flush();
    }, Math.max(0, Number(delay) || 0));
    timer?.unref?.();
  };

  const flush = async () => {
    if (!dirty) return false;
    if (isBusy()) {
      arm(busyRetryMs);
      return false;
    }
    if (timer) {
      cancel(timer);
      timer = null;
    }
    if (saving) return saving;
    dirty = false;
    saving = Promise.resolve()
      .then(save)
      .then(() => true)
      .catch((error) => {
        dirty = true;
        onError(error);
        return false;
      })
      .finally(() => {
        saving = null;
        if (dirty) arm(delayMs);
      });
    return saving;
  };

  return {
    mark() {
      dirty = true;
      arm(delayMs);
    },
    flush,
    isDirty() {
      return dirty;
    }
  };
}
