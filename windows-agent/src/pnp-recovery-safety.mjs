import {
  isAutomaticAdbTransportRecoveryState,
  isAutomaticPnpRecoveryState
} from "./device-recovery-state.mjs";

export function createPnpRecoverySafety(options = {}) {
  const now = options.now || Date.now;
  const massOutageMinDevices = Math.max(2, Number(options.massOutageMinDevices || 4));
  const massOutageRatio = Math.max(0.01, Math.min(1, Number(options.massOutageRatio || 0.08)));
  const circuitCooldownMs = Math.max(1, Number(options.circuitCooldownMs || 180_000));
  const stableScansToClose = Math.max(1, Number(options.stableScansToClose || 3));
  const maxActionsPerHour = Math.max(1, Number(options.maxActionsPerHour || 20));
  const minimumActionIntervalMs = Math.max(0, Number(options.minimumActionIntervalMs || 0));
  let previousOnline = new Set((options.initialState?.previousOnline || []).map(normalize));
  let circuit = normalizeCircuit(options.initialState?.circuit);
  let acknowledgedActionable = new Set((options.initialState?.acknowledgedActionable || []).map(normalize));
  let stableScans = Number(options.initialState?.stableScans || 0);
  let actionTimestamps = (options.initialState?.actionTimestamps || []).map(Number).filter(Number.isFinite);
  let lastHealth = {
    ...emptyHealth(),
    circuitOpen: circuit.open,
    circuitReason: circuit.reason,
    circuitUntil: circuit.until ? new Date(circuit.until).toISOString() : "",
    blockedReason: circuit.open ? `circuit_${circuit.reason}` : "not_observed",
    stableScans,
    automaticActionsLastHour: actionTimestamps.length,
    maxActionsPerHour,
    rescueSerials: [],
    rescueCanMutate: false
  };

  function observe(observations = [], context = {}) {
    const at = now();
    actionTimestamps = actionTimestamps.filter((value) => at - value < 3_600_000);
    const rows = Array.isArray(observations) ? observations : [];
    const ignoredSerials = new Set(Array.from(context.ignoredSerials || [], normalize));
    const physical = rows.filter((item) => item.physicalPresent);
    const online = new Set(rows.filter((item) => item.state === "adb_device").map((item) => normalize(item.serial)));
    const actionable = rows.filter((item) => !ignoredSerials.has(normalize(item.serial)) && item.physicalPresent && (
      isAutomaticPnpRecoveryState(item.state)
      || isAutomaticAdbTransportRecoveryState(item.state)
    ));
    const actionableKeys = new Set(actionable.map((item) => normalize(item.serial)));
    const newlyLost = [...previousOnline].filter((serial) => !ignoredSerials.has(serial) && !online.has(serial));
    acknowledgedActionable = new Set([...acknowledgedActionable].filter((serial) => actionableKeys.has(serial)));
    const unacknowledgedActionable = actionable.filter((item) => !acknowledgedActionable.has(normalize(item.serial)));
    const ratio = physical.length ? unacknowledgedActionable.length / physical.length : 0;
    // Four failures are already a batch incident on the production host. For
    // smaller installations, two simultaneous failures at or above the ratio
    // threshold also trip the circuit.
    const massOutage = unacknowledgedActionable.length >= massOutageMinDevices
      || (unacknowledgedActionable.length >= 2 && ratio >= massOutageRatio);
    // Once a stable incident has entered degraded recovery, any newly lost
    // formerly-online phone is collateral until proven otherwise. Re-open the
    // circuit immediately instead of waiting for four more phones to vanish.
    const burstOutage = newlyLost.length >= (acknowledgedActionable.size ? 1 : massOutageMinDevices);

    if (circuit.open && ["mass_outage", "burst_outage"].includes(circuit.reason)) {
      let incidentSerials = new Set((circuit.detail?.actionableSerials || []).map(normalize));
      const collateralSerials = new Set((circuit.detail?.collateralLosses || []).map(normalize));
      // Compatibility with state written by the first production release.
      // Capture its current cohort once, without extending the old deadline.
      if (!incidentSerials.size) {
        incidentSerials = new Set(actionableKeys);
        circuit = {
          ...circuit,
          detail: { ...(circuit.detail || {}), actionableSerials: [...incidentSerials] }
        };
      }
      const newIncidentSerials = [...actionableKeys].filter((serial) => !incidentSerials.has(serial));
      // A phone already recorded as a batch-external collateral loss is part
      // of the current incident, not evidence of a second incident. Treating
      // it as newly lost on every observation kept extending the circuit and
      // replaced the collateral cohort before it could complete its stable
      // recovery window.
      const unexpectedNewlyLost = newlyLost.filter((serial) => (
        !incidentSerials.has(serial) && !collateralSerials.has(serial)
      ));
      const incidentExpanded = newIncidentSerials.length > 0 || unexpectedNewlyLost.length > 0;
      if (incidentExpanded) {
        for (const serial of newIncidentSerials) incidentSerials.add(serial);
        openCircuit(unexpectedNewlyLost.length ? "burst_outage" : "mass_outage", at, {
          actionableCount: actionable.length,
          newlyLostCount: unexpectedNewlyLost.length,
          actionableSerials: [...incidentSerials],
          collateralLosses: [...collateralSerials]
        });
        stableScans = 0;
      } else {
        const safeNow = context.inventoryReady !== false && !context.installerBusy;
        // A batch-verification collateral loss is stronger evidence than the
        // generic mass-outage cohort. Never resume PnP just because the timer
        // elapsed: require every batch-external phone to be back in ADB for
        // the full stable-scan window. This prevents one failed recovery wave
        // from manufacturing the next wave of targets.
        const unresolvedCollateral = [...collateralSerials]
          .filter((serial) => !ignoredSerials.has(serial) && !online.has(serial));
        stableScans = safeNow && unresolvedCollateral.length === 0 ? stableScans + 1 : 0;
        if (collateralSerials.size) {
          circuit = {
            ...circuit,
            detail: {
              ...(circuit.detail || {}),
              collateralLosses: [...collateralSerials],
              unresolvedCollateral
            }
          };
        }
        if (at >= circuit.until && stableScans >= stableScansToClose) {
          acknowledgedActionable = new Set(actionableKeys);
          circuit = { open: false, reason: "", openedAt: 0, until: 0, detail: {} };
          stableScans = 0;
        }
      }
    } else if (massOutage || burstOutage) {
      openCircuit(massOutage ? "mass_outage" : "burst_outage", at, {
        actionableCount: actionable.length,
        newlyLostCount: newlyLost.length,
        actionableSerials: [...actionableKeys]
      });
      stableScans = 0;
    } else if (circuit.open) {
      const safeNow = context.inventoryReady !== false && !context.installerBusy;
      stableScans = safeNow ? stableScans + 1 : 0;
      if (at >= circuit.until && stableScans >= stableScansToClose) {
        circuit = { open: false, reason: "", openedAt: 0, until: 0, detail: {} };
        stableScans = 0;
      }
    }
    previousOnline = online;

    const budgetExhausted = actionTimestamps.length >= maxActionsPerHour;
    const lastActionAt = actionTimestamps[actionTimestamps.length - 1] || 0;
    const actionReadyAt = lastActionAt ? lastActionAt + minimumActionIntervalMs : 0;
    const actionCoolingDown = actionReadyAt > at;
    const rescueSerials = circuit.open && ["mass_outage", "burst_outage"].includes(circuit.reason)
      ? [...new Set((circuit.detail?.unresolvedCollateral || circuit.detail?.collateralLosses || [])
        .map(normalize)
        .filter((serial) => actionableKeys.has(serial)))]
      : [];
    const rescueCanMutate = rescueSerials.length > 0
      && context.inventoryReady !== false
      && !context.hostBusy
      && !context.installerBusy
      && !budgetExhausted
      && !actionCoolingDown;
    const blockedReason = circuit.open
      ? `circuit_${circuit.reason}`
      : context.inventoryReady === false
        ? "physical_inventory_unavailable"
      : context.hostBusy
        ? "host_busy"
        : context.installerBusy
          ? "device_install_busy"
          : budgetExhausted
            ? "hourly_budget_exhausted"
            : actionCoolingDown
              ? "action_cooldown"
            : "";
    lastHealth = {
      observedAt: new Date(at).toISOString(),
      circuitOpen: circuit.open,
      circuitReason: circuit.reason,
      circuitUntil: circuit.until ? new Date(circuit.until).toISOString() : "",
      blockedReason,
      physicalCount: physical.length,
      adbDeviceCount: online.size,
      actionableCount: actionable.length,
      newlyLostCount: newlyLost.length,
      unauthorizedCount: rows.filter((item) => item.state === "adb_unauthorized").length,
      offlineCount: rows.filter((item) => item.state === "adb_offline").length,
      absentCount: rows.filter((item) => item.state === "physically_absent").length,
      stableScans,
      automaticActionsLastHour: actionTimestamps.length,
      maxActionsPerHour,
      acknowledgedActionableCount: acknowledgedActionable.size,
      recoveryMode: circuit.open ? "circuit_open" : acknowledgedActionable.size ? "degraded_recovery" : "normal",
      actionReadyAt: actionReadyAt ? new Date(actionReadyAt).toISOString() : "",
      rescueSerials,
      rescueCanMutate
    };
    return { ...lastHealth, actionable, canMutate: !blockedReason };
  }

  function recordAction() {
    const at = now();
    actionTimestamps.push(at);
    actionTimestamps = actionTimestamps.filter((value) => at - value < 3_600_000);
    lastHealth = {
      ...lastHealth,
      observedAt: new Date(at).toISOString(),
      automaticActionsLastHour: actionTimestamps.length,
      maxActionsPerHour
    };
  }

  function recordFailure(reason = "pnp_action_failed", detail = {}) {
    const at = now();
    openCircuit(String(reason || "pnp_action_failed"), at, detail);
    stableScans = 0;
    lastHealth = {
      ...lastHealth,
      observedAt: new Date(at).toISOString(),
      circuitOpen: true,
      circuitReason: circuit.reason,
      circuitUntil: new Date(circuit.until).toISOString(),
      blockedReason: `circuit_${circuit.reason}`,
      stableScans
    };
  }

  function openCircuit(reason, at, detail = {}) {
    const until = at + circuitCooldownMs;
    circuit = {
      open: true,
      reason: String(reason || "unknown"),
      openedAt: circuit.open ? circuit.openedAt : at,
      until: Math.max(Number(circuit.until || 0), until),
      detail: { ...(circuit.detail || {}), ...detail }
    };
  }

  function snapshot() {
    return {
      previousOnline: [...previousOnline],
      circuit,
      acknowledgedActionable: [...acknowledgedActionable],
      stableScans,
      actionTimestamps
    };
  }

  return {
    observe,
    recordAction,
    recordFailure,
    health: () => ({ ...lastHealth }),
    snapshot
  };
}

function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeCircuit(value = {}) {
  return {
    open: Boolean(value?.open),
    reason: String(value?.reason || ""),
    openedAt: Number(value?.openedAt || 0),
    until: Number(value?.until || 0),
    detail: value?.detail && typeof value.detail === "object" ? value.detail : {}
  };
}

function emptyHealth() {
  return {
    observedAt: "",
    circuitOpen: false,
    circuitReason: "",
    circuitUntil: "",
    blockedReason: "not_observed",
    physicalCount: 0,
    adbDeviceCount: 0,
    actionableCount: 0,
    newlyLostCount: 0,
    unauthorizedCount: 0,
    offlineCount: 0,
    absentCount: 0,
    stableScans: 0,
    automaticActionsLastHour: 0,
    maxActionsPerHour: 0,
    acknowledgedActionableCount: 0,
    recoveryMode: "normal",
    actionReadyAt: "",
    rescueSerials: [],
    rescueCanMutate: false
  };
}
