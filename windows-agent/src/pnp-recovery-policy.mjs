export const ANDROID_USB_VENDOR_IDS = Object.freeze([
  "2D95", // vivo
  "2717", // Xiaomi
  "22D9", // OPPO/OnePlus
  "12D1", // Huawei
  "339B", // Honor
  "18D1", // Android/Google composite gadget
  "1782"  // Unisoc/Spreadtrum Android gadget
]);

export const PNP_RECOVERY_POLICY_VERSION = 5;

export function normalizePnpRecoveryTargetState(value = {}, serial = "") {
  const previous = value && typeof value === "object" ? value : {};
  const previousPolicyVersion = Number(previous.policyVersion || 0);
  if (![PNP_RECOVERY_POLICY_VERSION, 2, 3, 4].includes(previousPolicyVersion)) {
    return {
      serial: String(serial || previous.serial || "").trim(),
      policyVersion: PNP_RECOVERY_POLICY_VERSION,
      attempts: 0,
      actionHistory: [],
      lastMode: "",
      lastAttemptAt: 0,
      nextRetryAt: 0
    };
  }
  const previousHistory = (Array.isArray(previous.actionHistory) ? previous.actionHistory : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (previousPolicyVersion === 4) {
    // V4 persisted terminal/quarantine states indefinitely. Reopen them once
    // on upgrade; the live coordinator will finish the old ladder, apply the
    // fixed cooldown and start a fresh bounded cycle. Preserve action evidence
    // so the transition remains explainable in the recovery console.
    return {
      ...previous,
      serial: String(serial || previous.serial || "").trim(),
      policyVersion: PNP_RECOVERY_POLICY_VERSION,
      attempts: Math.max(0, Number(previous.attempts || 0)),
      actionHistory: previousHistory,
      quarantinedAt: 0,
      nextRetryAt: 0,
      inProgress: false
    };
  }
  if (previousPolicyVersion === 2 || previousPolicyVersion === 3) {
    // V2 could consume the whole retry budget by repeatedly restarting the
    // same stale ADB child. V3 turns the next step into an exact remove + root
    // rescan. Collapse only those duplicate restarts, preserve every other
    // completed action, and reopen only a target which was blocked by that
    // obsolete repetition. This avoids globally clearing recovery history.
    let retainedAdbRestart = false;
    const migratedHistory = previousHistory.filter((mode) => {
      if (mode !== "restart_adb_interface") return true;
      if (retainedAdbRestart) return false;
      retainedAdbRestart = true;
      return true;
    });
    const removedDuplicateRestarts = migratedHistory.length < previousHistory.length;
    const obsoleteTerminal = [
      "system_adb_maintenance_required",
      "usb_gadget_adb_not_exposed"
    ].includes(String(previous.lastMode || ""));
    const reopenForV4 = removedDuplicateRestarts || obsoleteTerminal;
    return {
      ...previous,
      serial: String(serial || previous.serial || "").trim(),
      policyVersion: PNP_RECOVERY_POLICY_VERSION,
      attempts: reopenForV4
        ? migratedHistory.length
        : Math.max(0, Number(previous.attempts || 0)),
      actionHistory: migratedHistory,
      quarantinedAt: 0,
      inProgress: false,
      ...(reopenForV4 ? {
        nextRetryAt: 0,
        lastMode: migratedHistory.at(-1) || ""
      } : {})
    };
  }
  return {
    ...previous,
    serial: String(serial || previous.serial || "").trim(),
    policyVersion: PNP_RECOVERY_POLICY_VERSION,
    attempts: Math.max(0, Number(previous.attempts || 0)),
    // Keep duplicates: actionHistory is also the persisted count of completed
    // bounded retries. De-duplicating it made one successful PnP request look
    // like the entire retry budget had already been consumed.
    actionHistory: previousHistory
  };
}

export function planPnpRecoveryAction({ observation = {}, previous = {}, maxAttempts = 8 } = {}) {
  const physical = observation?.physical || {};
  const state = String(observation?.state || "");
  const attempt = Math.max(1, Number(previous?.attempts || 0) + 1);
  const limit = Math.max(1, Number(maxAttempts || 8));
  const adbInterfaceId = String(physical.adbInterfaceInstanceId || "").trim();
  const rootId = String(physical.rootInstanceId || "").trim();
  const upstreamId = String(physical.upstreamInstanceId || "").trim();
  const hubInterfacePath = String(physical.hubInterfacePath || "").trim();
  const portNumber = Number(physical.portNumber || 0);
  const adbInterfaceIsRoot = Boolean(adbInterfaceId && rootId
    && adbInterfaceId.toUpperCase() === rootId.toUpperCase());
  const adbTargetType = physical.adbInterfaceKind === "generic_winusb_adb"
    ? "generic_winusb_adb_interface"
    : "adb_interface";
  const actions = [];

  if (state === "adb_offline") {
    actions.push(action("adb_reconnect", "adb_transport", { maxUses: 3 }));
    if (adbInterfaceId) {
      actions.push(action("restart_adb_interface", adbTargetType, {
        instanceId: adbInterfaceId,
        scanInstanceId: rootId,
        upstreamInstanceId: adbInterfaceIsRoot ? upstreamId : "",
        advanced: adbInterfaceIsRoot,
        maxUses: 1
      }));
      if (rootId && !adbInterfaceIsRoot) {
        actions.push(action("recreate_adb_interface", adbTargetType, { instanceId: adbInterfaceId, scanInstanceId: rootId, maxUses: 1 }));
      } else if (rootId && upstreamId && rootId.toUpperCase() !== upstreamId.toUpperCase()) {
        actions.push(action("recreate_adb_root", "adb_root", {
          instanceId: rootId,
          scanInstanceId: upstreamId,
          upstreamInstanceId: upstreamId,
          advanced: true,
          maxUses: 1
        }));
      }
    }
    return selectAction(actions, previous, attempt, limit, "system_adb_maintenance_required");
  }

  if (["adb_interface_pnp_error", "adb_interface_ready_transport_missing"].includes(state)) {
    if (adbInterfaceId) {
      // Production evidence on 2026-08-13 showed that repeatedly restarting a
      // stale WinUSB child did not rebuild its ADB transport. Escalate after
      // one low-risk restart by removing only that child and scanning the
      // phone root which owns it. Some vivo gadgets expose ADB directly as the
      // root node; after one restart, rebuild only that exact root and scan its
      // proven upstream instead of quarantining it forever.
      actions.push(action("restart_adb_interface", adbTargetType, {
        instanceId: adbInterfaceId,
        scanInstanceId: rootId,
        upstreamInstanceId: adbInterfaceIsRoot ? upstreamId : "",
        advanced: adbInterfaceIsRoot,
        maxUses: 1
      }));
      if (rootId && !adbInterfaceIsRoot) {
        actions.push(action("recreate_adb_interface", adbTargetType, { instanceId: adbInterfaceId, scanInstanceId: rootId, maxUses: 2 }));
      } else if (rootId && upstreamId && rootId.toUpperCase() !== upstreamId.toUpperCase()) {
        actions.push(action("recreate_adb_root", "adb_root", {
          instanceId: rootId,
          scanInstanceId: upstreamId,
          upstreamInstanceId: upstreamId,
          advanced: true,
          maxUses: 1
        }));
      }
    }
    if (!actions.length) {
      const interfaceRecoveryUses = completedActionCount(previous, "restart_adb_interface")
        + completedActionCount(previous, "recreate_adb_interface");
      if (attempt > limit || interfaceRecoveryUses >= 3) {
        return terminalAction("system_adb_maintenance_required", attempt);
      }
      return deferredAction("await_exact_adb_interface", "adb_interface", attempt);
    }
    return selectAction(actions, previous, attempt, limit, "system_adb_maintenance_required");
  }

  if (["usb_root_pnp_error", "usb_present_mtp_only", "usb_composite_no_adb_interface"].includes(state)) {
    // A PnP-error root may need one exact restart. A healthy MTP/composite
    // root does not: restarting it cannot make Android expose an ADB gadget.
    const rootRestartLimit = state === "usb_root_pnp_error" ? 2 : 0;
    const portCycleLimit = state === "usb_root_pnp_error" ? 2 : 1;
    const rootRestartUses = completedActionCount(previous, "restart_usb_root");
    const portCycleUses = completedActionCount(previous, "cycle_usb_port");
    const compositeRecreateUses = completedActionCount(previous, "recreate_usb_composite");
    const adbInterfaceWasJustObserved = completedActionCount(previous, "restart_adb_interface") > 0
      || completedActionCount(previous, "recreate_adb_interface") > 0;
    if (rootId && rootRestartUses < rootRestartLimit) {
      actions.push(action("restart_usb_root", "usb_root", {
        instanceId: rootId,
        scanInstanceId: rootId,
        upstreamInstanceId: upstreamId,
        advanced: true,
        maxUses: 2
      }));
    }
    // A phone which degrades from an exact ADB child to MTP-only after a
    // bounded child action may rebuild immediately. A long-term MTP-only phone
    // first gets one exact port cycle; production evidence on 2026-08-14 showed
    // that repeating the cycle did not expose ADB, while one exact Composite
    // rebuild restored the phone without collateral loss.
    if (state !== "usb_root_pnp_error"
      && (adbInterfaceWasJustObserved || portCycleUses >= portCycleLimit)
      && compositeRecreateUses < 1
      && rootId
      && upstreamId
      && rootId !== upstreamId) {
      actions.push(action("recreate_usb_composite", "usb_composite", {
        instanceId: rootId,
        scanInstanceId: upstreamId,
        upstreamInstanceId: upstreamId,
        advanced: true,
        maxUses: 1
      }));
    }
    if (portCycleUses < portCycleLimit && rootId && upstreamId && hubInterfacePath && Number.isInteger(portNumber) && portNumber > 0) {
      actions.push(action("cycle_usb_port", "usb_downstream_port", {
        instanceId: rootId,
        upstreamInstanceId: upstreamId,
        hubInterfacePath,
        portNumber,
        advanced: true,
        maxUses: portCycleLimit
      }));
    }
    if (!actions.length && rootId) {
      const exhausted = attempt > limit || (rootRestartUses >= rootRestartLimit && portCycleUses >= portCycleLimit);
      if (!exhausted) return deferredAction("await_exact_usb_mapping", "usb_downstream_port", attempt);
    }
    return selectAction(actions, previous, attempt, limit, "usb_gadget_adb_not_exposed");
  }

  return terminalAction("unsupported_recovery_state", attempt);
}

export function isAdvancedPnpRecoveryMode(mode) {
  return ["restart_usb_root", "cycle_usb_port", "recreate_adb_root", "recreate_usb_composite"].includes(String(mode || ""));
}

export function isAutomaticRecoveryAction(plan = {}) {
  return Boolean(plan.automatic && plan.mode && !plan.terminal);
}

export function isDeferredPnpRecoveryPlan(plan = {}) {
  return Boolean(plan.deferred && plan.mode && !plan.automatic && !plan.terminal);
}

export function selectPnpRecoveryBatch(plannedTargets = [], attemptsBySerial = new Map(), maxTargets = 1) {
  const limit = Math.max(1, Number(maxTargets || 1));
  const automaticPlans = plannedTargets.filter((item) => isAutomaticRecoveryAction(item?.plan));
  const normalTargets = automaticPlans.filter((item) => !item.plan.advanced && !isAdvancedPnpRecoveryMode(item.plan.mode));
  const advancedTargets = automaticPlans.filter((item) => item.plan.advanced || isAdvancedPnpRecoveryMode(item.plan.mode));
  const deferredTargets = plannedTargets.filter((item) => isDeferredPnpRecoveryPlan(item?.plan));
  const terminalTargets = plannedTargets.filter((item) => {
    if (isAutomaticRecoveryAction(item?.plan) || isDeferredPnpRecoveryPlan(item?.plan)) return false;
    const key = String(item?.serial || "").trim().toUpperCase();
    const previous = normalizePnpRecoveryTargetState(attemptsBySerial.get(key), item?.serial);
    return !previous.quarantinedAt || previous.lastMode !== item?.plan?.mode;
  });
  const runnable = normalTargets.length ? normalTargets : selectIndependentAdvancedTargets(advancedTargets, limit);
  return [
    ...runnable,
    ...deferredTargets.slice(0, Math.max(0, limit - runnable.length)),
    ...terminalTargets.slice(0, Math.max(0, limit - runnable.length - deferredTargets.length))
  ].slice(0, limit);
}

function selectIndependentAdvancedTargets(targets, limit) {
  const selected = [];
  const usedUpstreams = new Set();
  for (const item of targets) {
    const upstream = String(item?.plan?.upstreamInstanceId || item?.plan?.scanInstanceId || "").trim().toUpperCase();
    const isolationKey = upstream || "__UNKNOWN_UPSTREAM__";
    if (usedUpstreams.has(isolationKey)) continue;
    usedUpstreams.add(isolationKey);
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function pnpTargetRecoveryMode(attempt, maxAttempts = 8) {
  // Kept for compatibility with historical callers. New code must use
  // planPnpRecoveryAction(), which treats the configured limit as a total
  // action budget instead of repeating this one mode blindly.
  return Number(attempt) <= Math.max(1, Number(maxAttempts || 8)) ? "restart" : "cooldown";
}

export function pnpTargetRecoveryBackoffMs(attempt, baseMs, capMs) {
  const normalizedBase = Math.max(1, Number(baseMs || 1));
  const normalizedCap = Math.max(normalizedBase, Number(capMs || normalizedBase));
  const exponent = Math.max(0, Math.min(8, Number(attempt || 1) - 1));
  return Math.min(normalizedCap, normalizedBase * (2 ** exponent));
}

export function pnpRecoveryActionBackoffMs(previous = {}, mode = "", baseMs, capMs) {
  // Backoff belongs to the current recovery action, not to the entire phone
  // lifecycle. Once a phone advances from port recovery to ADB-child recovery,
  // the first child action must not inherit a 120-second delay from earlier
  // port attempts. Failed commands are not in actionHistory, so they retain
  // the first-use delay while DeviceInstall single-flight prevents stacking.
  const actionUse = completedActionCount(previous, String(mode || "")) + 1;
  return pnpTargetRecoveryBackoffMs(actionUse, baseMs, capMs);
}

export function isPnpRecoveryTargetDue(previous = {}, at = Date.now()) {
  if (previous?.inProgress || previous?.quarantinedAt) return false;
  return Number(previous?.nextRetryAt || 0) <= Number(at || 0);
}

export function beginNextPnpRecoveryCycle(previous = {}, options = {}) {
  const at = Math.max(1, Number(options.at || Date.now()));
  const cooldownMs = Math.max(1, Number(options.cooldownMs || 30_000));
  return {
    ...previous,
    serial: String(options.serial || previous.serial || "").trim(),
    policyVersion: PNP_RECOVERY_POLICY_VERSION,
    attempts: 0,
    actionHistory: [],
    lastMode: "recovery_cycle_cooldown",
    lastTerminalMode: String(options.terminalMode || previous.lastMode || ""),
    lastAttemptAt: at,
    nextRetryAt: at + cooldownMs,
    inProgress: false,
    quarantinedAt: 0,
    recoveryCycle: Math.max(0, Number(previous.recoveryCycle || 0)) + 1
  };
}

export function orderPnpRecoveryTargets(serials, attemptsBySerial) {
  return [...serials].sort((left, right) => {
    const leftState = attemptsBySerial.get(String(left).toUpperCase()) || {};
    const rightState = attemptsBySerial.get(String(right).toUpperCase()) || {};
    const attemptDelta = Number(leftState.attempts || 0) - Number(rightState.attempts || 0);
    if (attemptDelta) return attemptDelta;
    const timeDelta = Number(leftState.lastAttemptAt || 0) - Number(rightState.lastAttemptAt || 0);
    if (timeDelta) return timeDelta;
    return String(left).localeCompare(String(right));
  });
}

function action(mode, targetType, extra = {}) {
  return {
    mode,
    targetType,
    automatic: true,
    terminal: false,
    advanced: Boolean(extra.advanced),
    instanceId: String(extra.instanceId || ""),
    scanInstanceId: String(extra.scanInstanceId || ""),
    upstreamInstanceId: String(extra.upstreamInstanceId || ""),
    hubInterfacePath: String(extra.hubInterfacePath || ""),
    portNumber: Number(extra.portNumber || 0),
    maxUses: Math.max(1, Number(extra.maxUses || 1))
  };
}

function selectAction(actions, previous, attempt, limit, terminalMode) {
  if (attempt > limit) return terminalAction(terminalMode, attempt);
  const history = (Array.isArray(previous?.actionHistory) ? previous.actionHistory : []).map(String);
  const next = actions.find((item) => history.filter((mode) => mode === item.mode).length < item.maxUses);
  if (next) return { ...next, attempt };
  return terminalAction(terminalMode, Math.min(attempt, limit + 1));
}

function completedActionCount(previous, expectedMode) {
  return (Array.isArray(previous?.actionHistory) ? previous.actionHistory : [])
    .map(String)
    .filter((mode) => mode === expectedMode)
    .length;
}

function terminalAction(mode, attempt) {
  return {
    mode,
    targetType: "manual_maintenance",
    automatic: false,
    terminal: true,
    advanced: false,
    attempt: Math.max(1, Number(attempt || 1)),
    instanceId: "",
    scanInstanceId: "",
    upstreamInstanceId: "",
    hubInterfacePath: "",
    portNumber: 0
  };
}

function deferredAction(mode, targetType, attempt) {
  return {
    mode,
    targetType,
    automatic: false,
    terminal: false,
    deferred: true,
    advanced: false,
    attempt: Math.max(1, Number(attempt || 1)),
    instanceId: "",
    scanInstanceId: "",
    upstreamInstanceId: "",
    hubInterfacePath: "",
    portNumber: 0
  };
}
