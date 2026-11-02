// Fixture-only typed observer. Expected fault is tightly scoped to the first
// proxy client and recorded wire fault; other client/pool errors still throw.
export function createFaultClientObserver({ readWire, mode }) {
  if (typeof readWire !== "function" || !["before_commit", "after_commit"].includes(mode)) throw Error("fixture_fault_observer_config");
  let firstClient = null; const seen = new WeakSet(), records = [];
  const add = entry => { if (records.length >= 8) throw Error("fixture_fault_observation_bound"); records.push(Object.freeze(entry)); };
  function wireFault() {
    const wire = readWire();
    if (wire?.mode !== mode || wire.faultSpent !== true || !Array.isArray(wire.events)) return false;
    return wire.events.some(e => e.connectionId === 1 && (mode === "before_commit" ? e.event === "dropped_before_commit"
      : e.event === "backend_commit_completion" && e.commitConfirmedFromBackend === true && e.commandTag === "COMMIT"
        && e.commandCompleteCount === 1 && e.readyForQuery === "I" && e.errorResponseCount === 0));
  }
  return Object.freeze({
    attach(client) {
      if (seen.has(client)) throw Error("fixture_fault_observer_duplicate");
      seen.add(client); firstClient ||= client;
      const onError = error => {
        // pg-pool removed idleListener during checkout. This fixture adds one
        // observer; the remaining listener during the fault must still exist.
        const otherErrorListeners = client.listeners("error").filter(fn => fn !== onError).length;
        const sameClient = client === firstClient, knownWireFault = wireFault();
        const recognized = error instanceof Error && error.message === "Connection terminated unexpectedly";
        const expected = sameClient && knownWireFault && recognized && otherErrorListeners === 1;
        add({ event: "client_error", backendPid: client.processID, originalFaultClient: sameClient, knownWireFault,
          category: recognized ? "unexpected_connection_end" : "other", otherErrorListeners, expected });
        if (!expected) throw new Error("fixture_unexpected_client_error", { cause: error });
      };
      client.on("error", onError);
      client.once("end", () => client.removeListener("error", onError));
    },
    poolError(error, client) {
      add({ event: "idle_pool_error", backendPid: client?.processID ?? null, expected: false });
      throw new Error("fixture_unexpected_idle_pool_error", { cause: error });
    },
    snapshot: () => structuredClone(records)
  });
}
