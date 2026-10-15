import {hydrateManagedLookupTask,MANAGED_LOOKUP_PROTOCOL} from './managed-lookup-delivery.mjs';
import {randomUUID} from "node:crypto";
const lookupRuntimeId=randomUUID();
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeviceSerialInNotificationFallbackScope, loadAgentConfig } from "./config.mjs";
import { cachedAdbSerials, indexCachedDevices, mergeCachedDeviceScanRow } from "./device-scan-cache.mjs";
import { runXhsDataCollection } from "./xhs-data-collection.mjs";
import { galleryImportFileName, parseGalleryImportImage } from "./gallery-import.mjs";
import {
  hydrateLeasedWindowsTask,
  SCREEN_GALLERY_DELIVERY_PROTOCOL,
  XHS_PUBLISH_DELIVERY_PROTOCOL
} from "./gallery-task-delivery.mjs";
import { createSerialAdbActivityTracker } from "./serial-adb-activity.mjs";
import { assertSerialAdbHealthy } from "./serial-adb-health.mjs";
import { createSerialDelayScheduler } from "./serial-delay-scheduler.mjs";
import { isSerialReservedForBackgroundWork, shouldScheduleSmsBackground } from "./serial-reservation.mjs";
import { shouldRunPostTaskDeviceScan } from "./post-task-scan-policy.mjs";
import {
  isRetryableAlipayPocoStartFailure,
  shouldFallbackAlipayPocoFailure
} from "./alipay-poco-fallback-policy.mjs";
import { restartLookupQueryOnce } from "./lookup-page-recovery.mjs";
import { createLookupStatusOutbox } from "./lookup-status-outbox.mjs";
import { runLookupWithAccountPolicy } from "./lookup-account-policy.mjs";
import { createDeviceActorManager } from "./device-actor.mjs";
import { acquireAgentInstanceLock } from "./agent-instance-lock.mjs";
import { createScreenStreamManager } from "./screen-stream.mjs";
import { createProcessRuntimeMetrics } from "./runtime-metrics.mjs";
import { createSingleFlightRunner } from "./single-flight.mjs";
import { createAtomicJsonWriter } from "./atomic-json-writer.mjs";
import { pocoForwardLocals, stopWorkerWithFallback, waitForWorkerExit } from "./worker-shutdown.mjs";
import {
  selectAirtestWorkerEvictionCandidate,
  selectIdleAirtestWorkerSerials
} from "./airtest-worker-lifecycle.mjs";
import { createAdbServerRecovery } from "./adb-server-recovery.mjs";
import { createPnpMissingDeviceRecovery } from "./pnp-missing-device-recovery.mjs";
import {
  ANDROID_USB_VENDOR_IDS,
  isDeferredPnpRecoveryPlan,
  isAutomaticRecoveryAction,
  beginNextPnpRecoveryCycle,
  isPnpRecoveryTargetDue,
  normalizePnpRecoveryTargetState,
  orderPnpRecoveryTargets,
  planPnpRecoveryAction,
  pnpRecoveryActionBackoffMs,
  selectPnpRecoveryBatch,
} from "./pnp-recovery-policy.mjs";
import { createPnpScreenCoordinator } from "./pnp-screen-coordinator.mjs";
import {
  DEVICE_RECOVERY_STATES,
  buildDeviceRecoveryObservations,
  isAutomaticAdbTransportRecoveryState,
  isAutomaticPnpRecoveryState
} from "./device-recovery-state.mjs";
import { createPnpRecoverySafety } from "./pnp-recovery-safety.mjs";
import { buildRecoveryQueue, createRecoveryEventJournal } from "./recovery-observability.mjs";
import { observeAdbRecoveryVerification, observePhysicalAbsence } from "./pnp-recovery-verification.mjs";
import { buildPhysicalAndroidUsbInventoryScript, parsePhysicalAndroidUsbInventory } from "./pnp-windows-inventory.mjs";
import {
  assertDistinctExactUsbInstances,
  assertExactUsbInstanceId,
  buildRemoveExactPnpArgs
} from "./pnp-exact-actions.mjs";
import { createGuardedTaskRunner } from "./guarded-task-runner.mjs";
import { pnpRecoveryAdmissionReason } from "./pnp-recovery-admission.mjs";
import { createWindowsDeviceInstallProbe } from "./windows-device-install-probe.mjs";
import { classifyHumanVerificationXml, createLookupHumanObserver } from "./lookup-human-observer.mjs";
import { createPnpRecoveryWakeScheduler } from "./pnp-recovery-wake-scheduler.mjs";
import {
  scopePnpRecoveryPlansForSafety,
  summarizePnpRecoveryBatchResults
} from "./pnp-recovery-wave.mjs";
import { buildSmsContentQueryArgs } from "./sms-content-query.mjs";
import {
  buildSmsRelayHealthArgs,
  buildSmsRelayRecoverArgs,
  missingSmsRelayHealth,
  parseSmsRelayHealth,
  shouldRecoverSmsRelay,
  usesSmsRelayManagedSmsPath
} from "./sms-relay-health.mjs";
import { assignSmsSlotIndexes, parseSubscriptionSlotMap } from "./sms-subscription-map.mjs";
import {
  buildDefaultSmsSendToResolveArgs,
  buildLegacyDefaultSmsPackageArgs,
  buildSmsNotificationDumpArgs,
  buildSmsPackageDumpArgs,
  buildSmsRelatedPackageListArgs,
  buildSmsRoleHolderArgs,
  parseDefaultSmsRoleHolders,
  parseInstalledPackageNames,
  parseLegacyDefaultSmsPackage,
  parseResolvedDefaultSmsPackage,
  parseSmsPackageTrustEvidence,
  parseSmsNotificationDump,
  selectTrustedSmsNotificationPackages,
  selectUnsentSmsNotifications
} from "./sms-notification-source.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.dirname(__dirname);
const configPath = process.env.PHONE_CLOUD_AGENT_CONFIG || path.join(agentDir, "config.json");
const config = await loadAgentConfig({ agentDir, configPath });
const logDir = config.logDir || path.join(agentDir, "logs");
const cacheDir = config.cacheDir || path.join(agentDir, "cache");
const dataDir = config.dataDir || path.join(agentDir, "data");
await fs.mkdir(logDir, { recursive: true });
await fs.mkdir(path.join(cacheDir, "apk"), { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
const pnpRecoveryStatePath = path.join(dataDir, "pnp-recovery-state.json");
const persistedPnpRecoveryState = await loadPnpRecoveryState(pnpRecoveryStatePath);
const agentInstanceLock = await acquireAgentInstanceLock({
  lockPath: path.join(dataDir, "agent-instance.lock"),
  agentId: config.agentId
});

const lookupStatusOutbox = await createLookupStatusOutbox({
  directory: path.join(dataDir, "lookup-status-outbox"),
  send: (record) => api(`/api/v1/windows-agent-tasks/${encodeURIComponent(record.taskId)}/status`, {
    method: "POST", body: { status: record.status, result: record.result, managedLookupGeneration:record.managedLookupGeneration }
  })
});

let lastDevices = [];
let lastDevicesScannedAt = 0;
let lastAdbVersion = "";
let smsSyncCursors = await loadSmsSyncCursors();
const writeSmsSyncCursors = createAtomicJsonWriter(smsCursorPath());
let lastServerDevicesById = await loadDeviceScanCache();
const lastSmsLibrarySyncBySerial = new Map();
const backgroundSmsAbortControllersBySerial = new Map();
const backgroundSmsNotificationAbortControllersBySerial = new Map();
const smsSubscriptionSlotMapBySerial = new Map();
let backgroundSmsSyncPromise = null;
let backgroundSmsNotificationSyncPromise = null;
let backgroundSmsNotificationLoopTimer = null;
let backgroundSmsNotificationLoopStopped = false;
let backgroundSmsNotificationLoopDevices = [];
const lastSmsNotificationSyncBySerial = new Map();
const uploadedSmsNotificationKeysBySerial = new Map();
const defaultSmsPackageBySerial = new Map();
const smsNotificationPackageProfileBySerial = new Map();
const simInfoCacheBySerial = new Map();
const initialSimReadBySerial = new Set();
for (const serial of cachedAdbSerials(lastServerDevicesById)) {
  initialSimReadBySerial.add(serial);
  const sims = lastServerDevicesById.get(`adb:${serial}`)?.sims;
  if (Array.isArray(sims)) simInfoCacheBySerial.set(serial, { sims, checkedAtMs: Date.now() });
}
const lastBatteryRefreshBySerial = new Map();
const lastSmsRelayHealthBySerial = new Map();
const lastSmsRelayRecoveryBySerial = new Map();
const automationPreflightBySerial = new Map();
const automationPreflightRunning = new Set();
const scheduleAutomationPreflight = createSingleFlightRunner(runAutomationPreflightCycle);
let automationStatusSyncTimer = null;
let automationStatusSyncInFlight = false;
let automationStatusSyncRequested = false;
const airtestWorkersBySerial = new Map();
const airtestLookupWarmUntilBySerial = new Map();
let airtestWorkerAdmissionChain = Promise.resolve();
let airtestWorkerCleanupTimer = null;
const activeTasksById = new Map();
const activeTaskAbortControllersById = new Map();
const activeTaskSerials = new Set();
const screenControlledSerials = new Set();
const pnpScreenCoordinator = createPnpScreenCoordinator({ maxConcurrent: config.pnpTargetRecoveryConcurrency });
const runtimeMetrics = createProcessRuntimeMetrics();
const qrRemoteDirReadyBySerial = new Set();
const galleryRemoteDirReadyBySerial = new Set();
let taskPollWakeTimer = null;
let screenStreamManager = null;
const deviceActors = createDeviceActorManager();
const adbServerRecovery = createAdbServerRecovery({
  recoverAfterFailures: config.adbScanRecoveryFailures,
  hardRecoverAfterFailures: config.adbHardRecoveryFailures,
  cooldownMs: config.adbRecoveryCooldownSeconds * 1000
});
const pnpMissingDeviceRecovery = createPnpMissingDeviceRecovery({
  rescanAfterMissingScans: config.pnpRescanAfterMissingScans,
  resetAfterMissingScans: config.pnpTargetResetAfterMissingScans,
  rescanCooldownMs: config.pnpRescanCooldownSeconds * 1000,
  resetCooldownMs: config.pnpTargetResetCooldownSeconds * 1000,
  trackingWindowMs: config.pnpMissingDeviceTrackingSeconds * 1000,
  absentRetryMs: config.pnpTargetAbsentRetrySeconds * 1000
});
let lastPhysicalPnpCandidateScanAt = 0;
let lastPhysicallyPresentAndroidUsbSerials = [];
let lastPhysicalPnpInventory = [];
let lastSuccessfulPhysicalPnpInventoryAt = 0;
let lastPhysicalPnpInventoryError = "not_scanned";
let lastDeviceRecoveryObservations = [];
const pnpTargetRecoveryAttempts = new Map((persistedPnpRecoveryState.targets || [])
  .map((item) => {
    const serial = String(item?.serial || "").trim();
    const normalized = normalizePnpRecoveryTargetState(item, serial);
    // Continuous mode must also reopen a V5 state written while the optional
    // legacy mode was enabled. An Agent restart is not allowed to resurrect a
    // quarantine or a stale in-progress marker.
    return [serial.toUpperCase(), config.pnpContinuousRecoveryEnabled
      ? { ...normalized, quarantinedAt: 0, inProgress: false }
      : normalized];
  })
  .filter(([key]) => key));
const pnpRecoveryJournal = createRecoveryEventJournal({
  initialEvents: persistedPnpRecoveryState.events,
  initialStates: persistedPnpRecoveryState.observedStates
});
const pnpRecoverySafety = createPnpRecoverySafety({
  continuousRecovery: config.pnpContinuousRecoveryEnabled,
  massOutageMinDevices: config.pnpMassOutageMinDevices,
  massOutageRatio: config.pnpMassOutageRatio,
  circuitCooldownMs: config.pnpMassOutageCooldownSeconds * 1_000,
  stableScansToClose: config.pnpMassOutageStableScans,
  maxActionsPerHour: config.pnpMaxAutomaticActionsPerHour,
  minimumActionIntervalMs: 0,
  postActionWatchMs: config.pnpCollateralWatchSeconds * 1_000,
  initialState: persistedPnpRecoveryState.safety
});
let lastPnpRecoveryHealth = pnpRecoverySafety.health();
let lastPnpRecoverySafetyLogKey = "";
let lastPnpRecoveryCircuitKey = [lastPnpRecoveryHealth.circuitOpen, lastPnpRecoveryHealth.circuitReason].join(":");
let pnpRecoveryStateSaveTimer = null;
let pnpRecoveryStateWriteChain = Promise.resolve();
let lastSavedPnpRecoveryState = "";
// Keep recently assigned phones under observation across an agent restart.  A
// USB phone can reappear after the first ADB-missing recovery attempt, so only
// tracking devices seen in this process leaves it permanently invisible.
pnpMissingDeviceRecovery.seed(cachedAdbSerials(lastServerDevicesById).filter((serial) => {
  const cached = lastServerDevicesById.get(`adb:${serial}`) || {};
  return cached.listed !== false && cached.adb?.agentId === config.agentId;
}));
let health = await buildHealth("starting", null);
const guardedTasks = createGuardedTaskRunner({
  onError(error, name) {
    log(`${name} failed`, error?.message || String(error));
  }
});
const inspectWindowsDeviceInstallActivity = createWindowsDeviceInstallProbe({ run });
let pnpRecoveryWakeScheduler = null;
pnpRecoveryWakeScheduler = createPnpRecoveryWakeScheduler({
  retryDelayMs: 1_000,
  async run(reason) {
    // Poll only the process list while Windows DeviceInstall is active. A
    // hundred-device inventory every five seconds would make recovery faster
    // on paper but add exactly the PnP pressure this guard is meant to avoid.
    const installer = await inspectWindowsDeviceInstallActivity();
    if (installer.busy) {
      log("pnp recovery wake deferred", {
        reason: installer.reason, probeState: installer.state,
        probeDurationMs: installer.durationMs, probeCheckedAt: installer.checkedAt,
        probeErrorCode: installer.errorCode, probeTimedOut: installer.timedOut,
        processCount: installer.processes.length, processes: installer.processes.slice(0, 8)
      });
      pnpRecoveryWakeScheduler.schedule(config.pnpDeviceInstallPollSeconds * 1_000, installer.reason);
      return { deferred: true };
    }
    return await scanAndSync({
      forcePnpInventory: true,
      skipSms: false,
      skipPreflight: true,
      reason: reason || "pnp_recovery_followup"
    });
  },
  onError(error, reason) {
    log("pnp recovery wake failed", { reason, error: error?.message || String(error) });
  }
});
const serialAdbActivity = createSerialAdbActivityTracker();
const automationResumeScheduler = createSerialDelayScheduler({
  delayMs: 15_000,
  action: resumeAutomationAfterScreenControl,
  onError(error, serial) {
    log("delayed automation resume failed", { serial, error: error?.message || String(error) });
  }
});

process.on("uncaughtException", (error) => {
  log("uncaught exception", error?.stack || error?.message || error);
});
process.on("unhandledRejection", (error) => {
  log("unhandled rejection", error?.stack || error?.message || error);
});
process.on("exit", () => agentInstanceLock.releaseSync());

log("starting", { agentId: config.agentId, serverBaseUrl: config.serverBaseUrl });
log("health", health);

screenStreamManager = createScreenStreamManager({
  config,
  agentDir,
  log,
  preemptSerial(serial) {
    return preemptSmsSyncForScreen(serial);
  },
  reserveSerial(serial) {
    if (isDeviceSerialReserved(serial)) return false;
    screenControlledSerials.add(serial);
    return true;
  },
  releaseSerial(serial) {
    screenControlledSerials.delete(serial);
  },
  async waitForSerialIdle(serial) {
    const pnpIdle = await pnpScreenCoordinator.waitForIdle(serial, 45_000);
    if (!pnpIdle.idle) {
      const error = new Error(`等待 Windows USB 枚举完成超时：${serial}`);
      error.code = "screen_pnp_timeout";
      throw error;
    }
    if (pnpIdle.waitedMs >= 100) {
      log("screen start waited for pnp recovery", { serial, waitedMs: pnpIdle.waitedMs });
    }
    const idle = await serialAdbActivity.waitForIdle(serial, 15_000);
    if (!idle) {
      const error = new Error(`等待设备 ADB 通道空闲超时：${serial}`);
      error.code = "screen_adb_timeout";
      throw error;
    }
  },
  async beforeSessionStart(serial) {
    automationResumeScheduler.cancel(serial);
    await pauseAutomationForScreenControl(serial);
  },
  async afterSessionEnd(serial) {
    if (hasActiveAirtestLookupWarmLease(serial)) {
      automationResumeScheduler.schedule(serial);
      log("automation resume scheduled for active lookup session", { serial, delayMs: 15_000 });
      return;
    }
    markAutomationReadyOnDemand(serial, "screen_control_ended");
    log("automation remains on demand after screen control", { serial });
  }
});
screenStreamManager.start();

const failedHumanProbeWorkers = new WeakSet();
const lookupHumanObserver = createLookupHumanObserver({
  request: api,
  agentId: config.agentId,
  canObserve: (probe) => !pnpScreenCoordinator.active && !activeTaskSerials.has(probe.adbSerial)
    && lastDevices.some((device) => device.adbSerial === probe.adbSerial && device.state === "device"),
  observe: observeLookupHumanVerification
});
const lookupStatusOutboxTimer = setInterval(() => {
  lookupStatusOutbox.flush().catch(() => log("lookup terminal report remains pending"));
}, 3_000);
const lookupHumanObserverTimer = setInterval(
  () => runGuardedInterval("lookup human observation", () => lookupHumanObserver.poll()), 3_000
);

setInterval(() => runGuardedInterval("heartbeat", () => heartbeat()), config.heartbeatIntervalSeconds * 1000);
setInterval(() => scanAndSync(), config.scanIntervalSeconds * 1000);
setInterval(() => runGuardedInterval("task poll", () => pollTask()), config.taskPollIntervalSeconds * 1000);
airtestWorkerCleanupTimer = setInterval(
  () => runGuardedInterval("airtest worker cleanup", () => cleanupIdleAirtestWorkers()),
  config.airtestWorkerCleanupIntervalSeconds * 1000
);

await runGuardedInterval("heartbeat", () => heartbeat()).catch((error) => log("startup heartbeat failed", error?.message || String(error)));
await scanAndSync().catch((error) => log("startup scan failed", error?.message || String(error)));
scheduleTaskPoll(100);

process.stdin.resume();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    lookupHumanObserver.stop();
    clearInterval(lookupHumanObserverTimer);
    clearInterval(lookupStatusOutboxTimer);
    backgroundSmsNotificationLoopStopped = true;
    if (airtestWorkerCleanupTimer) {
      clearInterval(airtestWorkerCleanupTimer);
      airtestWorkerCleanupTimer = null;
    }
    if (backgroundSmsNotificationLoopTimer) {
      clearTimeout(backgroundSmsNotificationLoopTimer);
      backgroundSmsNotificationLoopTimer = null;
    }
    pnpRecoveryWakeScheduler?.cancel();
    await screenStreamManager?.close().catch(() => {});
    await stopAllAirtestWorkers("agent_shutdown").catch((error) => {
      log("airtest worker shutdown failed", { error: error?.message || String(error) });
    });
    deviceActors.close("agent_shutdown");
    if (pnpRecoveryStateSaveTimer) {
      clearTimeout(pnpRecoveryStateSaveTimer);
      pnpRecoveryStateSaveTimer = null;
    }
    await flushPnpRecoveryState().catch(() => {});
    await agentInstanceLock.release();
    process.exit(0);
  });
}

function isDeviceSerialReserved(serial) {
  return isSerialReservedForBackgroundWork(serial, activeTaskSerials, screenControlledSerials);
}

function isSmsNotificationFallbackEnabledForSerial(serial) {
  return isDeviceSerialInNotificationFallbackScope(config, serial);
}

async function runGuardedInterval(name, fn) {
  const timeoutMs = name === "scan" ? 120_000 : name.includes("task poll") ? 30_000 : 45_000;
  return await guardedTasks.run(name, fn, timeoutMs);
}

async function buildHealth(reason, previousHealth = null) {
  const [adbCheck, logDirCheck, cacheDirCheck, airtestCheck, collectionProtocolCheck] = await Promise.allSettled([
    adbVersion(),
    checkWritableDir(logDir),
    checkWritableDir(cacheDir),
    checkAirtestStatus(),
    run(config.pythonCommand, [config.xhsDataCollectionRunnerPath, "--protocol"], { timeoutMs: 8_000 })
  ]);
  const adbOk = adbCheck.status === "fulfilled";
  const logOk = logDirCheck.status === "fulfilled" && logDirCheck.value.ok;
  const cacheOk = cacheDirCheck.status === "fulfilled" && cacheDirCheck.value.ok;
  const warnings = [...config.configWarnings];
  if (!adbOk) warnings.push("adb_unavailable");
  if (!logOk) warnings.push("log_dir_not_writable");
  if (!cacheOk) warnings.push("cache_dir_not_writable");
  if (config.airtestEnabled && !(airtestCheck.status === "fulfilled" && airtestCheck.value.ok)) warnings.push("airtest_unavailable");
  return {
    status: warnings.length ? "warn" : "ok",
    reason,
    checkedAt: new Date().toISOString(),
    warnings,
    adb: {
      ok: adbOk,
      path: config.adbPath,
      version: adbOk ? adbCheck.value : "",
      error: adbOk ? "" : adbCheck.reason.message
    },
    xhsDataCollect: {
      protocol: "xhs_data_collect_v1",
      ready: adbOk && collectionProtocolCheck.status === "fulfilled"
        && collectionProtocolCheck.value === "xhs_data_collect_v1"
    },
    airtest: {
      enabled: config.airtestEnabled,
      ok: airtestCheck.status === "fulfilled" && airtestCheck.value.ok,
      pythonCommand: config.pythonCommand,
      autoInstall: config.autoInstallAirtest,
      runnerPath: config.airtestRunnerPath,
      packages: config.airtestPackages,
      lastError: airtestCheck.status === "fulfilled" ? airtestCheck.value.error || "" : airtestCheck.reason.message,
      checkedAt: new Date().toISOString()
    },
    screenControl: screenStreamManager?.health() || {
      enabled: config.screenStreamEnabled,
      connected: false,
      activeSessions: 0,
      serverJarReady: false
    },
    runtime: runtimeMetrics.snapshot(),
    deviceActors: deviceActors.health().slice(0, 200),
    deviceRecovery: currentPnpRecoveryHealth(),
    directories: {
      logDir: { path: logDir, ok: logOk, error: logDirCheck.status === "fulfilled" ? logDirCheck.value.error : logDirCheck.reason.message },
      cacheDir: { path: cacheDir, ok: cacheOk, error: cacheDirCheck.status === "fulfilled" ? cacheDirCheck.value.error : cacheDirCheck.reason.message }
    },
    lastScan: previousHealth?.lastScan || null
  };
}

async function checkWritableDir(targetDir) {
  const probe = path.join(targetDir, `.write-test-${Date.now()}`);
  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function heartbeat() {
  health = await buildHealth("heartbeat", health);
  if (!lastAdbVersion) lastAdbVersion = health.adb.ok ? health.adb.version : `adb unavailable: ${health.adb.error}`;
  await api("/api/v1/windows-agents/heartbeat", {
    method: "POST",
    body: {
      agentId: config.agentId,
      agentName: config.agentName,
      hostname: os.hostname(),
      version: "0.1.0",
      platform: os.platform(),
      arch: os.arch(),
      adbVersion: lastAdbVersion,
      managedLookupProtocol: MANAGED_LOOKUP_PROTOCOL, lookupRuntimeId,
      maxConcurrentAdbTasks: config.maxConcurrentAdbTasks,
      deviceTaskConcurrency: config.deviceTaskConcurrency,
      health
    }
  });
}

async function scanAndSync(options = {}) {
  // Every caller, including post-task scans, owns the same guard until the
  // actual scan/recovery/verification settles, even after its timeout report.
  return runGuardedInterval("scan", () => performDeviceScanAndSync(options));
}

async function performDeviceScanAndSync(options = {}) {
  const activeAutomationTask = hasActiveAutomationTask();
  let devices = [];
  try {
    devices = await scanAdbDevices();
    health.lastScan = {
      ok: true,
      at: new Date().toISOString(),
      error: "",
      activeAutomationTask,
      reason: options.reason || ""
    };
  } catch (error) {
    health.lastScan = { ok: false, at: new Date().toISOString(), error: error.message };
    await heartbeat().catch((heartbeatError) => log("heartbeat after scan failure failed", heartbeatError.message));
    throw error;
  }
  // Release stale Poco/ADB forwards before any exact PnP restart. Kernel-PnP
  // event 225 showed adb-related processes holding device removal paths open.
  await cleanupOfflineAutomationWorkers(devices).catch((error) => log("automation worker cleanup failed", error.message));
  await requestSafePnpRescanForMissingDevices(devices, { forceInventory: options.forcePnpInventory === true });
  health.deviceRecovery = currentPnpRecoveryHealth();
  markAutomationPreflightPending(devices);
  lastDevices = devices;
  lastDevicesScannedAt = Date.now();
  annotateDeviceAutomationStatus(devices);
  const syncResult = await syncDevicesToPlatform(devices);
  rememberServerDevices(syncResult.devices || []);
  await saveDeviceScanCache(syncResult.devices || []).catch((error) => log("device scan cache save failed", error.message));
  log("synced devices", devices.map((device) => `${device.adbSerial}:${device.state}`).join(", ") || "none");
  const recoveryPending = Number(health.deviceRecovery?.actionableCount || 0) > 0;
  if (!activeAutomationTask && !recoveryPending && !options.skipPreflight) {
    scheduleAutomationPreflight(devices)
      .then((updated) => {
        if (updated) scheduleAutomationStatusSync();
      })
      .catch((error) => log("automation preflight failed", error.message));
  } else if (activeAutomationTask) {
    log("automation preflight skipped during active task");
  }
  if (shouldScheduleSmsBackground({
    enabled: config.smsLibraryBackgroundSyncEnabled,
    skipSms: options.skipSms,
    activeAutomationTask
  })) {
    scheduleBackgroundSmsSync(devices);
  } else {
    log("sms library background sync skipped", {
      enabled: Boolean(config.smsLibraryBackgroundSyncEnabled),
      activeAutomationTask,
      recoveryPending,
      skipSms: Boolean(options.skipSms),
      reason: options.reason || ""
    });
  }
  if (shouldScheduleSmsBackground({
    enabled: config.smsNotificationFallbackEnabled,
    skipSms: options.skipSms,
    activeAutomationTask
  })) {
    scheduleBackgroundSmsNotificationSync(devices);
  }
}

async function syncDevicesToPlatform(devices) {
  return api(`/api/v1/windows-agents/${encodeURIComponent(config.agentId)}/devices/sync`, {
    method: "POST",
    body: {
      agent: {
        agentId: config.agentId,
        agentName: config.agentName,
        hostname: os.hostname(),
        version: "0.1.0",
        platform: os.platform(),
        arch: os.arch(),
        adbVersion: lastAdbVersion,
        managedLookupProtocol: MANAGED_LOOKUP_PROTOCOL, lookupRuntimeId,
        health
      },
      devices
    }
  });
}

function scheduleAutomationStatusSync() {
  automationStatusSyncRequested = true;
  if (automationStatusSyncTimer || automationStatusSyncInFlight) return;
  automationStatusSyncTimer = setTimeout(() => {
    automationStatusSyncTimer = null;
    flushAutomationStatusSync().catch((error) => log("automation status sync failed", error.message));
  }, 250);
}

async function flushAutomationStatusSync() {
  if (automationStatusSyncInFlight) return;
  automationStatusSyncInFlight = true;
  try {
    while (automationStatusSyncRequested) {
      automationStatusSyncRequested = false;
      annotateDeviceAutomationStatus(lastDevices);
      const syncResult = await syncDevicesToPlatform(lastDevices);
      rememberServerDevices(syncResult.devices || []);
      await saveDeviceScanCache(syncResult.devices || []).catch((error) => log("device scan cache save failed", error.message));
    }
  } finally {
    automationStatusSyncInFlight = false;
    if (automationStatusSyncRequested) scheduleAutomationStatusSync();
  }
}

function scheduleBackgroundSmsSync(devices) {
  if (backgroundSmsSyncPromise) {
    log("sms library background sync already running");
    return;
  }
  backgroundSmsSyncPromise = syncAdbSmsLibraries(devices)
    .catch((error) => log("sms library sync failed", error.message))
    .finally(() => {
      backgroundSmsSyncPromise = null;
    });
}

function scheduleBackgroundSmsNotificationSync(devices) {
  backgroundSmsNotificationLoopDevices = Array.isArray(devices) ? [...devices] : [];
  if (backgroundSmsNotificationSyncPromise || backgroundSmsNotificationLoopTimer) return;
  startBackgroundSmsNotificationCycle();
}

function scheduleNextBackgroundSmsNotificationCycle(delayMs = 0) {
  if (backgroundSmsNotificationLoopStopped || backgroundSmsNotificationLoopTimer || backgroundSmsNotificationSyncPromise) return;
  backgroundSmsNotificationLoopTimer = setTimeout(() => {
    backgroundSmsNotificationLoopTimer = null;
    startBackgroundSmsNotificationCycle();
  }, Math.max(0, Number(delayMs || 0)));
}

function startBackgroundSmsNotificationCycle() {
  if (backgroundSmsNotificationLoopStopped || backgroundSmsNotificationSyncPromise) return;
  const startedAt = Date.now();
  let completedTargetCount = 0;
  backgroundSmsNotificationSyncPromise = syncAdbSmsNotifications(backgroundSmsNotificationLoopDevices)
    .then((summary) => {
      completedTargetCount = Number(summary?.targetCount || 0);
      log("sms notification fallback cycle completed", {
        ...summary,
        durationMs: Date.now() - startedAt,
        concurrency: config.smsNotificationBackgroundConcurrency,
        continuous: config.smsNotificationContinuousScanEnabled
      });
      return summary;
    })
    .catch((error) => {
      log("sms notification fallback sync failed", cleanLogText(error?.message || error).slice(0, 300));
      return { targetCount: 0, failed: 1 };
    })
    .finally(() => {
      backgroundSmsNotificationSyncPromise = null;
      if (config.smsNotificationContinuousScanEnabled && completedTargetCount > 0) {
        scheduleNextBackgroundSmsNotificationCycle(0);
      }
    });
}

function markAutomationPreflightPending(devices) {
  const now = Date.now();
  for (const device of devices) {
    const serial = device.adbSerial;
    if (!serial) continue;
    if (device.state !== "device") {
      automationPreflightBySerial.set(serial, {
        serial,
        ok: false,
        status: "offline",
        checkedAt: new Date().toISOString(),
        lastError: device.state === "unauthorized" ? "ADB 未授权" : `ADB 状态：${device.state || "missing"}`,
        nextCheckAt: 0
      });
      continue;
    }
    if (!config.automationPreflightEnabled || !config.airtestEnabled) {
      automationPreflightBySerial.set(serial, {
        serial,
        ok: true,
        status: "adb_ready",
        checkedAt: new Date().toISOString(),
        checkedAtMs: now,
        airtestReady: false,
        pocoReady: false,
        helpersReady: false,
        xhsInstalled: true,
        lastError: "airtest_disabled",
        nextCheckAt: now + config.automationPreflightIntervalSeconds * 1000
      });
      continue;
    }
    const cached = automationPreflightBySerial.get(serial);
    const worker = airtestWorkersBySerial.get(serial);
    const workerReady = Boolean(worker && !worker.exited && !worker.stopping);
    if (cached && !cached.ok && cached.nextCheckAt && now < cached.nextCheckAt) continue;
    if (cached && cached.status === "ready" && workerReady && now - Number(cached.checkedAtMs || 0) < config.automationPreflightIntervalSeconds * 1000) {
      continue;
    }
    if (cached?.ok && !workerReady) {
      automationPreflightBySerial.set(serial, {
        ...cached,
        serial,
        ok: true,
        status: "ready_on_demand",
        lastError: "自动化组件已就绪，任务开始时按需启动 Poco worker"
      });
      continue;
    }
    if (cached && (cached.status === "preparing" || cached.status === "queued")) continue;
    automationPreflightBySerial.set(serial, {
      ...(cached || {}),
      serial,
      ok: Boolean(cached?.ok && workerReady),
      status: cached?.ok && workerReady ? "ready" : "queued",
      checkedAt: cached?.checkedAt || "",
      checkedAtMs: cached?.checkedAtMs || 0,
      lastError: workerReady ? (cached?.lastError || "") : "等待启动常驻自动化 worker",
      nextCheckAt: cached?.nextCheckAt || 0
    });
  }
}

async function cleanupOfflineAutomationWorkers(devices) {
  const online = new Set(devices.filter((device) => device.state === "device").map((device) => device.adbSerial).filter(Boolean));
  for (const serial of airtestWorkersBySerial.keys()) {
    if (online.has(serial)) continue;
    airtestLookupWarmUntilBySerial.delete(serial);
    await stopAirtestWorker(serial, "device_offline").catch((error) => log("airtest worker cleanup failed", { serial, error: error.message }));
  }
}

function annotateDeviceAutomationStatus(devices) {
  for (const device of devices) {
    if (!device.adbSerial) continue;
    device.automation = automationStatusForSerial(device.adbSerial);
  }
}

function automationStatusForSerial(serial) {
  const cached = automationPreflightBySerial.get(serial);
  if (!cached) {
    return {
      ok: false,
      status: "unknown",
      checkedAt: "",
      airtestReady: false,
      pocoReady: false,
      helpersReady: false,
      xhsInstalled: false,
      androidSdk: 0,
      phantomProcessLimit: "",
      phantomProcessConfigured: false,
      accessibilityServices: [],
      accessibilityConflicts: [],
      lastError: "等待 Windows 管理器预检"
    };
  }
  return {
    ok: Boolean(cached.ok),
    status: cached.status || "unknown",
    checkedAt: cached.checkedAt || "",
    airtestReady: Boolean(cached.airtestReady),
    pocoReady: Boolean(cached.pocoReady),
    helpersReady: Boolean(cached.helpersReady),
    xhsInstalled: Boolean(cached.xhsInstalled),
    xhsPackageName: config.xhsPackageName,
    androidSdk: Number(cached.androidSdk || 0),
    phantomProcessLimit: cached.phantomProcessLimit || "",
    phantomProcessConfigured: Boolean(cached.phantomProcessConfigured),
    accessibilityServices: cached.accessibilityServices || [],
    accessibilityConflicts: cached.accessibilityConflicts || [],
    repairAction: cached.repairAction || "",
    lastError: cached.lastError || ""
  };
}

async function runAutomationPreflightCycle(devices) {
  if (!config.automationPreflightEnabled || !config.airtestEnabled) return false;
  const targets = devices.filter((device) => shouldRunAutomationPreflight(device));
  await runLimited(targets, config.automationPreflightConcurrency, async (device) => {
    await ensureDeviceAutomationReady(device).catch((error) => {
      log("device automation preflight failed", { serial: device.adbSerial, error: error.message });
    });
    scheduleAutomationStatusSync();
  });
  return targets.length > 0;
}

function shouldRunAutomationPreflight(device) {
  const serial = device.adbSerial;
  if (!serial || device.state !== "device") return false;
  if (automationResumeScheduler.isPending(serial)) return false;
  if (isDeviceSerialReserved(serial)) return false;
  if (automationPreflightRunning.has(serial)) return false;
  const cached = automationPreflightBySerial.get(serial);
  if (!cached) return true;
  if (cached.status === "preparing") return false;
  const age = Date.now() - Number(cached.checkedAtMs || 0);
  if (cached.ok && age < config.automationPreflightIntervalSeconds * 1000) return false;
  if (!cached.ok && cached.nextCheckAt && Date.now() < cached.nextCheckAt) return false;
  const worker = airtestWorkersBySerial.get(serial);
  if (!worker || worker.exited || worker.stopping) return true;
  return true;
}

async function ensureDeviceAutomationReady(device, options = {}) {
  const serial = String(device.adbSerial || device.serial || "").trim();
  if (!serial) throw new Error("缺少 ADB 序列号，无法预检自动化环境");
  if (options.task) automationResumeScheduler.cancel(serial);
  const existingWorker = airtestWorkersBySerial.get(serial);
  if (options.task && existingWorker && !existingWorker.exited && !existingWorker.stopping) {
    await existingWorker.readyPromise;
    const now = Date.now();
    const cached = automationPreflightBySerial.get(serial) || {};
    automationPreflightBySerial.set(serial, {
      ...cached,
      serial,
      ok: true,
      status: "ready",
      checkedAt: new Date(now).toISOString(),
      checkedAtMs: now,
      airtestReady: true,
      pocoReady: true,
      helpersReady: true,
      repairAction: "",
      lastError: ""
    });
    return automationStatusForSerial(serial);
  }
  if (options.task) {
    // A foreground QR task must not perform the full install/accessibility
    // preflight merely because this Agent process has just restarted and its
    // in-memory cache is empty. Start and probe the per-device worker first;
    // a missing helper/package naturally fails this bounded fast path and then
    // falls through to the repair-capable full preflight below.
    try {
      const startup = getAirtestWorker(serial);
      const worker = await Promise.race([
        startup,
        delay(10_000).then(() => { throw new Error(`foreground_worker_start_timeout:${serial}`); })
      ]);
      await probeAirtestWorker(worker);
      const now = Date.now();
      const cached = automationPreflightBySerial.get(serial) || {};
      automationPreflightBySerial.set(serial, {
        ...cached,
        serial,
        ok: true,
        status: "ready",
        checkedAt: new Date(now).toISOString(),
        checkedAtMs: now,
        airtestReady: true,
        pocoReady: true,
        helpersReady: true,
        repairAction: "",
        lastError: ""
      });
      log("foreground task worker fast start passed", { serial });
      return automationStatusForSerial(serial);
    } catch (error) {
      log("foreground task worker fast start failed, falling back to full preflight", {
        serial,
        error: error?.message || String(error)
      });
      await stopAirtestWorker(serial, "foreground_fast_start_failed").catch(() => {});
    }
  }
  const cachedReady = automationPreflightBySerial.get(serial);
  if (options.task && cachedReady?.ok && Date.now() - Number(cachedReady.checkedAtMs || 0) < config.automationPreflightIntervalSeconds * 1000) {
    // A timed-out Poco operation intentionally kills only that device's
    // worker.  The installed helpers and recent preflight result are still
    // valid, so rebuild the worker directly instead of repeating the full
    // package/accessibility/Android-limit preflight (about 60–70 seconds on
    // the production OPPO fleet).
    await getAirtestWorker(serial);
    return automationStatusForSerial(serial);
  }
  if (automationPreflightRunning.has(serial)) {
    if (!options.task) return automationStatusForSerial(serial);
    // A foreground QR task must not sit behind the full background preflight.
    // The production 152 run showed that the worker became ready near the
    // beginning of preflight but the task still waited the old fixed 60-second
    // loop.  Observe the single worker briefly and take it as soon as it is
    // usable; after the bound, let the task path call getAirtestWorker(), whose
    // own single-flight safely joins or creates that same worker.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const worker = airtestWorkersBySerial.get(serial);
      if (worker && !worker.exited && !worker.stopping) {
        await worker.readyPromise;
        const now = Date.now();
        const cached = automationPreflightBySerial.get(serial) || {};
        automationPreflightBySerial.set(serial, {
          ...cached,
          serial,
          ok: true,
          status: "ready",
          checkedAt: new Date(now).toISOString(),
          checkedAtMs: now,
          airtestReady: true,
          pocoReady: true,
          helpersReady: true,
          repairAction: "",
          lastError: ""
        });
        return automationStatusForSerial(serial);
      }
      await delay(250);
    }
    if (automationPreflightRunning.has(serial)) {
      log("foreground task bypassed background automation preflight wait", { serial, waitedMs: 8_000 });
      return automationStatusForSerial(serial);
    }
  }
  automationPreflightRunning.add(serial);
  const startedAt = Date.now();
  automationPreflightBySerial.set(serial, {
    ...(automationPreflightBySerial.get(serial) || {}),
    serial,
    ok: false,
    status: "preparing",
    checkedAt: new Date().toISOString(),
    checkedAtMs: Date.now(),
    lastError: "",
    repairAction: "checking"
  });
  try {
    await assertAdbDeviceOnline(serial);
    const airtestStatus = await ensureAirtestReady(options.task || null);
    const androidSdk = await androidSdkVersion(serial).catch(() => 0);
    const phantom = await configureAndroidAutomationLimits(serial, androidSdk, options.task || null);
    const accessibility = await inspectAccessibilityServices(serial);
    if (options.task && accessibility.conflicts.length) {
      await taskEvent(options.task, "airtest", "warn", "检测到可能冲突的无障碍服务，可能影响 Poco 控件识别", {
        adbSerial: serial,
        accessibilityConflicts: accessibility.conflicts
      });
    }
    let repairAction = "";
    let helpers = await airtestDeviceHelpers(serial);
    if (!helpers.pocoReady && airtestStatus.ok) {
      repairAction = "prewarming_airtest_poco";
      await prepareAdbInstallPolicy(serial);
      await prewarmAirtestPoco(serial, options.task || null);
      helpers = await airtestDeviceHelpers(serial);
    }
    if (airtestStatus.ok && helpers.pocoReady) {
      repairAction = repairAction || "starting_airtest_worker";
      await getAirtestWorker(serial);
      repairAction = "";
    }
    const xhsInstalled = await isPackageInstalled(serial, config.xhsPackageName);
    const ok = Boolean(airtestStatus.ok && helpers.pocoReady);
    const lastError = ok ? "" : "Airtest/Poco 自动化环境未就绪";
    const status = ok ? "ready" : "failed";
    automationPreflightBySerial.set(serial, {
      serial,
      ok,
      status,
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now(),
      airtestReady: Boolean(airtestStatus.ok),
      pocoReady: Boolean(helpers.pocoReady),
      yosemiteReady: Boolean(helpers.yosemiteReady),
      helpersReady: Boolean(helpers.pocoReady),
      xhsInstalled,
      androidSdk,
      phantomProcessLimit: phantom.value,
      phantomProcessConfigured: phantom.configured,
      accessibilityServices: accessibility.services,
      accessibilityConflicts: accessibility.conflicts,
      repairAction: ok ? "" : repairAction,
      lastError,
      durationMs: Date.now() - startedAt,
      nextCheckAt: ok ? 0 : Date.now() + Math.max(5 * 60_000, config.automationPreflightIntervalSeconds * 1000)
    });
    return automationStatusForSerial(serial);
  } catch (error) {
    const friendlyError = friendlyAutomationPreflightError(error);
    const xhsInstalled = await isPackageInstalled(serial, config.xhsPackageName).catch(() => false);
    const accessibility = await inspectAccessibilityServices(serial).catch(() => ({ services: [], conflicts: [] }));
    automationPreflightBySerial.set(serial, {
      serial,
      ok: false,
      status: "failed",
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now(),
      airtestReady: false,
      pocoReady: false,
      helpersReady: false,
      xhsInstalled,
      androidSdk: await androidSdkVersion(serial).catch(() => 0),
      phantomProcessLimit: "",
      phantomProcessConfigured: false,
      accessibilityServices: accessibility.services,
      accessibilityConflicts: accessibility.conflicts,
      repairAction: /INSTALL_FAILED_ABORTED|INSTALL_FAILED_USER_RESTRICTED|User rejected permissions|Install canceled by user/i.test(error.message) ? "adb_install_permission_required" : "failed",
      lastError: friendlyError,
      durationMs: Date.now() - startedAt,
      nextCheckAt: Date.now() + Math.max(5 * 60_000, config.automationPreflightIntervalSeconds * 1000)
    });
    throw error;
  } finally {
    automationPreflightRunning.delete(serial);
  }
}

async function androidSdkVersion(serial) {
  const output = await adb(serial, ["shell", "getprop", "ro.build.version.sdk"], { timeoutMs: 5000 });
  const sdk = Number(String(output || "").trim());
  return Number.isFinite(sdk) ? sdk : 0;
}

async function configureAndroidAutomationLimits(serial, androidSdk = 0, task = null) {
  const sdk = Number(androidSdk || 0);
  if (sdk < 31) {
    return { configured: false, value: "", reason: "android_below_12" };
  }
  const desired = "2147483647";
  let before = await adb(serial, ["shell", "device_config", "get", "activity_manager", "max_phantom_processes"], { timeoutMs: 5000 })
    .then((value) => String(value || "").trim())
    .catch(() => "");
  if (before !== desired) {
    await adb(serial, ["shell", "device_config", "put", "activity_manager", "max_phantom_processes", desired], { timeoutMs: 8000 }).catch((error) => {
      log("android phantom process config failed", { serial, androidSdk: sdk, error: error.message });
    });
  }
  const after = await adb(serial, ["shell", "device_config", "get", "activity_manager", "max_phantom_processes"], { timeoutMs: 5000 })
    .then((value) => String(value || "").trim())
    .catch(() => before);
  const configured = after === desired;
  if (task && configured && before !== desired) {
    await taskEvent(task, "airtest", "info", "已放宽 Android 12+ 后台进程限制，提升自动化 worker 稳定性", {
      adbSerial: serial,
      androidSdk: sdk,
      maxPhantomProcesses: after
    });
  }
  return { configured, value: after, before, reason: configured ? "" : "device_config_not_applied" };
}

async function inspectAccessibilityServices(serial) {
  const output = await adb(serial, ["shell", "settings", "get", "secure", "enabled_accessibility_services"], { timeoutMs: 5000 }).catch(() => "");
  const raw = String(output || "").trim();
  const services = raw && raw !== "null"
    ? raw.split(":").map((item) => item.trim()).filter(Boolean)
    : [];
  const conflicts = services.filter((service) => isAccessibilityConflict(service));
  if (conflicts.length) {
    log("accessibility conflict detected", { serial, conflicts });
  }
  return { raw, services, conflicts };
}

function isAccessibilityConflict(service) {
  const text = String(service || "");
  return /com\.ztqc\.smsrelay\/com\.ztqc\.smsrelay\.ScanAccessibilityService/i.test(text);
}

async function pollTask() {
  let picked = 0;
  let cancellationChecked = false;
  while (!cancellationChecked || activeTasksById.size < config.maxConcurrentAdbTasks) {
    const excludeSerials = [...new Set([...activeTaskSerials, ...screenControlledSerials, ...lookupStatusOutbox.pendingTasks().map((item) => item.adbSerial)])]
      .filter(Boolean)
      .map(encodeURIComponent)
      .join(",");
    const screenGallerySerials = [...screenControlledSerials].filter(Boolean).map(encodeURIComponent).join(",");
    const activeTaskIds = [...new Set([...activeTasksById.keys(), ...lookupStatusOutbox.pendingTasks().map((item) => item.taskId)])].filter(Boolean).map(encodeURIComponent).join(",");
    const params = new URLSearchParams();
    if (excludeSerials) params.set("excludeSerials", excludeSerials);
    if (screenGallerySerials) params.set("screenGallerySerials", screenGallerySerials);
    if (activeTaskIds) params.set("activeTaskIds", activeTaskIds);
    params.set("managedLookupDelivery", MANAGED_LOOKUP_PROTOCOL);
    params.set("galleryDelivery", SCREEN_GALLERY_DELIVERY_PROTOCOL);
    params.set("xhsPublishDelivery", XHS_PUBLISH_DELIVERY_PROTOCOL);
    const suffix = params.size ? `?${params.toString()}` : "";
    const payload = await api(`/api/v1/windows-agents/${encodeURIComponent(config.agentId)}/tasks/next${suffix}`);
    cancellationChecked = true;
    abortCancelledAutomationTasks(payload.cancelledTaskIds || []);
    if (!payload.task) break;
    const prepared = payload.task.payload?.managedLookup ? await hydrateManagedLookupTask(payload.task,{request:api}) : await hydrateLeasedWindowsTask(payload.task, { request: api });
    if (!prepared.acknowledged) {
      log("task acknowledgement uncertain", {
        taskId: prepared.task.taskId,
        type: prepared.task.type,
        error: prepared.acknowledgementError?.message || String(prepared.acknowledgementError || "")
      });
      // Gallery import is idempotent enough to finish after a lost ACK
      // response. Publishing is an external side effect: never click publish
      // unless the server has confirmed ownership of this delivery.
      if (prepared.task.type === "xhs_publish" || prepared.task.payload?.managedLookup) continue;
    }
    startTask(prepared.task);
    picked += 1;
  }
  if (picked) log("tasks dispatched", { picked, active: activeTasksById.size, maxConcurrentAdbTasks: config.maxConcurrentAdbTasks });
}

function abortCancelledAutomationTasks(taskIds = []) {
  let aborted = 0;
  for (const taskId of taskIds) {
    const controller = activeTaskAbortControllersById.get(String(taskId || ""));
    if (!controller || controller.signal.aborted) continue;
    controller.abort(automationTaskCancellationError());
    aborted += 1;
  }
  if (aborted) log("cancelled automation tasks interrupted", { count: aborted });
  return aborted;
}

function scheduleTaskPoll(delayMs = 250) {
  if (taskPollWakeTimer) return;
  taskPollWakeTimer = setTimeout(() => {
    taskPollWakeTimer = null;
    runGuardedInterval("task poll wake", () => pollTask()).catch((error) => {
      log("task poll wake failed", error?.message || String(error));
    });
  }, Math.max(50, Number(delayMs) || 250));
}

function startTask(task) {
  const taskId = String(task?.taskId || "");
  if (!taskId || activeTasksById.has(taskId)) return;
  const taskSerial = String(task.adbSerial || "").trim();
  const controller = new AbortController();
  activeTasksById.set(taskId, task);
  activeTaskAbortControllersById.set(taskId, controller);
  if (taskSerial) activeTaskSerials.add(taskSerial);
  runTask(task, { signal: controller.signal })
    .catch((error) => log("task runner crashed", { taskId, adbSerial: taskSerial, error: error?.stack || error?.message || error }))
    .finally(() => {
      activeTasksById.delete(taskId);
      activeTaskAbortControllersById.delete(taskId);
      if (taskSerial) activeTaskSerials.delete(taskSerial);
      scheduleTaskPoll(100);
    });
}

async function runTask(task, options = {}) {
  const isLookup = task.type.startsWith("alipay_name_");
  let lookupTerminal = null;
  log("task picked", { taskId: task.taskId, type: task.type, adbSerial: task.adbSerial });
  taskEvent(task, "start", "info", `开始执行 ${task.type}`)
    .catch((error) => log("task start event failed", { taskId: task.taskId, error: error.message }));
  try {
    if (isLookup && task.type !== "alipay_name_stop" && !lookupStatusOutbox.isAvailable()) {
      throw Object.assign(new Error("查名结果存储不可用，当前任务未操作手机；请检查存储后重试。"), { code: "lookup_status_storage_unavailable" });
    }
    let result;
    if (task.type === "adb_install_apk") result = await taskInstallApk(task);
    else if (task.type === "adb_grant_permissions") result = await taskGrantPermissions(task);
    else if (task.type === "adb_start_agent") result = await taskStartAgent(task);
    else if (task.type === "adb_collect_diagnostics") result = await taskCollectDiagnostics(task);
    else if (task.type === "adb_restart_server") result = await taskRestartAdb(task);
    else if (task.type === "sms_sync_now") result = await taskSmsSyncNow(task, options);
    else if (task.type === "sms_code_probe") result = await taskSmsCodeProbe(task, options);
    else if (task.type === "screen_gallery_import") result = await taskScreenGalleryImport(task);
    else if (task.type === "xhs_qr_appium") result = await taskXhsQrAirtestPoco(task);
    else if (task.type === "xhs_publish") result = await taskXhsPublish(task);
    else if (task.type === "xhs_data_collect") result = await taskXhsDataCollect(task, options);
    else if (task.type === "kuaishou_lead") result = await taskKuaishouLead(task, options);
    else if (["alipay_name_start", "alipay_name_query", "alipay_name_switch", "alipay_name_stop"].includes(task.type)) result = await taskAlipayNameLookupWithAccounts(task, options);
    else throw new Error(`unsupported task type: ${task.type}`);
    const collectionIncomplete = task.type === "xhs_data_collect" && result.collection?.complete !== true;
    await taskEvent(task, "finish", collectionIncomplete ? "warn" : "info", collectionIncomplete ? "已保存部分采集结果" : "执行成功", compactTaskResultForEvent(result))
      .catch((error) => log("task finish event failed", { taskId: task.taskId, error: error.message }));
    if (isLookup) lookupTerminal = { status: "succeeded", result };
    else await taskStatus(task, collectionIncomplete ? "failed" : "succeeded", result);
  } catch (error) {
    if (isAutomationTaskCancellation(error)) {
      taskEvent(task, "cancelled", "info", "用户已结束会话，当前自动化任务已停止", { reason: "automation_task_cancelled" })
        .catch((eventError) => log("task cancellation event failed", { taskId: task.taskId, error: eventError.message }));
      taskStatus(task, "cancelled", { code: "automation_task_cancelled", message: "用户已结束会话，当前自动化任务已停止" })
        .catch((statusError) => log("task cancellation status failed", { taskId: task.taskId, error: statusError.message }));
      return;
    }
    if (isScreenPriorityCancellation(error)) {
      taskEvent(task, "cancelled", "info", "投屏优先，已暂停短信同步", { reason: "screen_control_priority" })
        .catch((eventError) => log("task cancellation event failed", { taskId: task.taskId, error: eventError.message }));
      taskStatus(task, "cancelled", { code: "screen_control_priority", message: "投屏优先，已暂停短信同步" })
        .catch((statusError) => log("task cancellation status failed", { taskId: task.taskId, error: statusError.message }));
      return;
    }
    const evidence = error.code === "lookup_status_storage_unavailable" ? {} : await captureFailureEvidence(task).catch((evidenceError) => ({
      evidenceError: evidenceError?.message || String(evidenceError)
    }));
    const failure = { ...taskFailureResult(error), ...evidence };
    await taskEvent(task, "finish", "error", error.message, compactTaskResultForEvent(failure))
      .catch((eventError) => log("task failure event failed", { taskId: task.taskId, error: eventError.message }));
    if (isLookup) lookupTerminal = { status: "failed", result: failure };
    else await taskStatus(task, "failed", failure);
  } finally {
    if (options.signal?.aborted) {
      log("post-task scan skipped after task cancellation", {
        taskId: task.taskId,
        adbSerial: task.adbSerial,
        reason: options.signal.reason?.code || options.signal.reason?.message || "cancelled"
      });
    } else if (shouldRunPostTaskDeviceScan(task.type)) {
      await scanAndSync({ force: true, skipSms: true, reason: "post_task" }).catch((error) => log("post-task scan failed", error.message));
    } else {
      log("post-task device scan skipped", {
        taskId: task.taskId,
        type: task.type,
        adbSerial: task.adbSerial,
        reason: "device_inventory_unchanged"
      });
    }
  }
  // Reporting faults are not Android execution failures.
  if (lookupTerminal) await taskStatus(task, lookupTerminal.status, lookupTerminal.result);
}

function preemptSmsSyncForScreen(serial) {
  const adbSerial = String(serial || "").trim();
  if (!adbSerial) return;
  const backgroundController = backgroundSmsAbortControllersBySerial.get(adbSerial);
  if (backgroundController && !backgroundController.signal.aborted) {
    log("screen control preempted background sms sync", { adbSerial });
    backgroundController.abort();
  }
  const notificationController = backgroundSmsNotificationAbortControllersBySerial.get(adbSerial);
  if (notificationController && !notificationController.signal.aborted) {
    log("screen control preempted sms notification fallback", { adbSerial });
    notificationController.abort();
  }
  for (const [taskId, task] of activeTasksById) {
    if (!["sms_sync_now", "sms_code_probe"].includes(task?.type) || String(task.adbSerial || "").trim() !== adbSerial) continue;
    const controller = activeTaskAbortControllersById.get(taskId);
    if (!controller || controller.signal.aborted) continue;
    log("screen control preempted sms sync", { taskId, adbSerial });
    controller.abort();
  }
}

async function preemptBackgroundSmsSyncForPnpRecovery(serials = []) {
  const targets = new Set((Array.isArray(serials) ? serials : [])
    .map((serial) => String(serial || "").trim().toUpperCase())
    .filter(Boolean));
  if (!targets.size) return;
  if (!backgroundSmsSyncPromise && !backgroundSmsNotificationSyncPromise) return;
  let aborted = 0;
  for (const controllers of [backgroundSmsAbortControllersBySerial, backgroundSmsNotificationAbortControllersBySerial]) {
    for (const [serial, controller] of controllers) {
      if (!targets.has(String(serial || "").trim().toUpperCase()) || controller.signal.aborted) continue;
      controller.abort();
      aborted += 1;
    }
  }
  if (aborted) log("pnp recovery preempted exact-device sms sync", { devices: aborted, serials: [...targets] });
  const released = () => [...targets].every((serial) => (
    ![...backgroundSmsAbortControllersBySerial.keys()].some((value) => String(value || "").trim().toUpperCase() === serial)
    && ![...backgroundSmsNotificationAbortControllersBySerial.keys()].some((value) => String(value || "").trim().toUpperCase() === serial)
  ));
  const deadline = Date.now() + 5_000;
  while (!released() && Date.now() < deadline) await delay(50);
}

function screenPriorityCancellationError() {
  const error = new Error("screen_control_priority");
  error.code = "screen_control_priority";
  return error;
}

function automationTaskCancellationError() {
  const error = new Error("automation_task_cancelled");
  error.code = "automation_task_cancelled";
  return error;
}

function throwIfScreenPriorityCancellation(signal) {
  if (signal?.aborted) throw screenPriorityCancellationError();
}

function isScreenPriorityCancellation(error) {
  return error?.code === "screen_control_priority" || error?.message === "screen_control_priority";
}

function isAutomationTaskCancellation(error) {
  return error?.code === "automation_task_cancelled" || error?.message === "automation_task_cancelled";
}

async function captureFailureEvidence(task) {
  const serial = String(task?.adbSerial || "").trim();
  if (!serial) return {};
  const capturedAt = new Date().toISOString();
  const evidence = { capturedAt };
  const focusText = await adb(serial, ["shell", "dumpsys", "window"], { timeoutMs: 8000 }).catch(() => "");
  const focusLines = String(focusText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /mCurrentFocus|mFocusedApp/i.test(line));
  if (focusLines.length) {
    evidence.currentActivity = focusLines.join("\n").slice(0, 1000);
    evidence.packageName = packageNameFromFocusLines(focusLines);
  }
  const hierarchy = await adb(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"], {
    timeoutMs: 15_000,
    maxBuffer: 2 * 1024 * 1024
  }).catch(() => "");
  const uiHierarchy = normalizeUiHierarchyDump(hierarchy);
  if (uiHierarchy) {
    evidence.uiHierarchy = uiHierarchy;
    evidence.uiSnapshot = uiHierarchy.slice(0, 8000);
  }
  const png = await runBuffer(config.adbPath, ["-s", serial, "exec-out", "screencap", "-p"], {
    timeoutMs: 12_000,
    maxBuffer: 12 * 1024 * 1024
  }).catch(() => null);
  if (png?.length) {
    evidence.screenshot = await buildScreenshotEvidence(serial, png, capturedAt);
  }
  return evidence;
}

async function buildScreenshotEvidence(serial, png, capturedAt) {
  const compressed = await compressScreenshotEvidence(serial, png).catch((error) => {
    log("screenshot compression failed", { serial, error: error?.message || String(error) });
    return null;
  });
  if (compressed?.length) {
    return {
      mimeType: "image/jpeg",
      dataUrl: `data:image/jpeg;base64,${compressed.toString("base64")}`,
      capturedAt,
      adbSerial: serial,
      sizeBytes: compressed.length,
      originalSizeBytes: png.length,
      compressed: true
    };
  }
  return {
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    capturedAt,
    adbSerial: serial,
    sizeBytes: png.length,
    compressed: false
  };
}

async function compressScreenshotEvidence(serial, png) {
  const evidenceDir = path.join(cacheDir, "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  const safeSerial = String(serial || "device").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputPath = path.join(evidenceDir, `${safeSerial}-${stamp}.png`);
  const outputPath = path.join(evidenceDir, `${safeSerial}-${stamp}.jpg`);
  await fs.writeFile(inputPath, png);
  const script = [
    "import sys",
    "from PIL import Image, ImageOps",
    "src, dst = sys.argv[1], sys.argv[2]",
    "img = Image.open(src)",
    "img = ImageOps.exif_transpose(img).convert('RGB')",
    "max_w = 900",
    "if img.width > max_w:",
    "    h = int(img.height * max_w / img.width)",
    "    img = img.resize((max_w, h))",
    "img.save(dst, 'JPEG', quality=68, optimize=True)"
  ].join("\n");
  try {
    await run(config.pythonCommand, ["-c", script, inputPath, outputPath], { timeoutMs: 15_000, maxBuffer: 1024 * 1024 });
    return await fs.readFile(outputPath);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

function normalizeUiHierarchyDump(value) {
  const text = String(value || "").replace(/\r/g, "").trim();
  if (!text) return "";
  const xmlStart = text.indexOf("<?xml");
  if (xmlStart >= 0) return text.slice(xmlStart).trim();
  const hierarchyStart = text.indexOf("<hierarchy");
  if (hierarchyStart >= 0) return text.slice(hierarchyStart).trim();
  return text;
}

function packageNameFromFocusLines(lines = []) {
  const text = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  const match = text.match(/\s([a-zA-Z][\w]*(?:\.[\w]+)+)\//);
  return match ? match[1] : "";
}

function hasActiveAutomationTask() {
  for (const task of activeTasksById.values()) {
    if (task?.type === "xhs_qr_appium") return true;
  }
  return false;
}

async function taskInstallApk(task) {
  const apkPath = await resolveApkPath(task);
  if (!apkPath) throw new Error("未配置 apkPath");
  try {
    const output = await adb(task.adbSerial, ["install", "-r", "-g", apkPath], { timeoutMs: 180_000 });
    return { apkPath, grantAllRuntimePermissions: true, output };
  } catch (error) {
    const diagnostic = classifyAdbInstallFailure(error.message);
    const installError = new Error(diagnostic.message);
    installError.diagnostic = diagnostic;
    installError.cause = error;
    throw installError;
  }
}

async function resolveApkPath(task) {
  if (task.payload?.apkPath) return task.payload.apkPath;
  if (config.apkPath) return config.apkPath;
  const release = task.payload?.release || await latestRelease();
  const downloadUrl = task.payload?.apkUrl || release?.downloadUrl;
  if (!downloadUrl) throw new Error("平台未配置最新 APK 下载地址");
  return await downloadApk(downloadUrl, release);
}

async function latestRelease() {
  try {
    const payload = await api("/api/v1/app-release/latest");
    return payload.release || null;
  } catch (error) {
    throw new Error(`获取平台最新 APK 失败：${error.message}`);
  }
}

async function downloadApk(downloadUrl, release = {}) {
  const absoluteUrl = downloadUrl.startsWith("http")
    ? downloadUrl
    : `${config.serverBaseUrl}${downloadUrl.startsWith("/") ? "" : "/"}${downloadUrl}`;
  const fileName = safeFileName(release.apkFile || `phone-agent-${release.versionCode || "latest"}.apk`);
  const target = path.join(cacheDir, "apk", fileName);
  const response = await fetch(absoluteUrl, {
    headers: {
      authorization: `Bearer ${config.agentToken}`
    }
  });
  if (!response.ok) throw new Error(`下载 APK 失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (release.sha256) {
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== release.sha256) throw new Error(`APK sha256 校验失败：${sha256}`);
  }
  await fs.writeFile(target, bytes);
  return target;
}

async function taskGrantPermissions(task) {
  const packageName = task.payload?.packageName || "com.ztqc.smsrelay";
  const permissions = task.payload?.permissions || [
    "android.permission.RECEIVE_SMS",
    "android.permission.READ_SMS",
    "android.permission.READ_PHONE_STATE",
    "android.permission.POST_NOTIFICATIONS"
  ];
  const results = [];
  for (const permission of permissions) {
    try {
      const output = await adb(task.adbSerial, ["shell", "pm", "grant", packageName, permission]);
      results.push({ permission, ok: true, output });
    } catch (error) {
      results.push({ permission, ok: false, error: error.message });
    }
  }
  return { packageName, results };
}

async function taskStartAgent(task) {
  const component = task.payload?.component || "com.ztqc.smsrelay/.MainActivity";
  const serverUrl = String(task.payload?.serverUrl || config.serverBaseUrl).replace(/\/$/, "");
  const token = String(task.payload?.deviceToken || task.payload?.token || config.deviceToken || "");
  const deviceId = String(task.payload?.deviceId || task.deviceId || (task.adbSerial ? `adb:${task.adbSerial}` : ""));
  const deviceName = String(task.payload?.deviceName || task.deviceId || task.adbSerial || "");
  const reverse = await ensureReverseForLoopbackServer(task.adbSerial, serverUrl);
  const output = await adb(task.adbSerial, [
    "shell", "am", "start", "-n", component,
    "--es", "serverUrl", serverUrl,
    "--es", "token", token,
    "--es", "deviceId", deviceId,
    "--es", "deviceName", deviceName
  ]);
  return { component, serverUrl, deviceId, deviceName, reverse, output };
}

async function taskCollectDiagnostics(task) {
  const [battery, focus] = await Promise.allSettled([
    adb(task.adbSerial, ["shell", "dumpsys", "battery"]),
    adb(task.adbSerial, ["shell", "dumpsys", "window"])
  ]);
  return {
    battery: battery.status === "fulfilled" ? battery.value.slice(0, 4000) : battery.reason.message,
    window: focus.status === "fulfilled" ? focus.value.match(/mCurrentFocus.*|mFocusedApp.*/g)?.slice(0, 5) || [] : focus.reason.message
  };
}

async function taskRestartAdb() {
  await run(config.adbPath, ["kill-server"]);
  await run(config.adbPath, ["start-server"]);
  lastAdbVersion = await adbVersion().catch((error) => `adb unavailable: ${error.message}`);
  return { adbVersion: lastAdbVersion };
}

async function taskSmsSyncNow(task, options = {}) {
  const device = await assertAdbDeviceOnlineFast(task.adbSerial, options);
  if (usesSmsRelayManagedSmsPath(device.smsRelay)) {
    let appWakeRequested = false;
    let appWakeError = "";
    try {
      await adb(device.adbSerial, buildSmsRelayRecoverArgs(), { timeoutMs: 8_000, maxBuffer: 64 * 1024 });
      appWakeRequested = true;
    } catch (error) {
      appWakeError = cleanLogText(error?.message || error).slice(0, 200);
    }
    await taskEvent(task, "sms_relay_health", "info", "SmsRelay 已接管，Windows 仅返回 APK 健康状态", {
      adbSerial: device.adbSerial,
      status: device.smsRelay.status || "unknown",
      serviceAlive: Boolean(device.smsRelay.serviceAlive),
      pendingUploadCount: Number(device.smsRelay.pendingUploadCount || 0),
      appWakeRequested,
      appWakeError
    });
    return {
      action: "SmsRelay 已接管，已请求 APK 自身同步，Windows 未读取系统短信库或通知",
      source: "sms-relay-health",
      appWakeRequested,
      appWakeError,
      smsRelay: device.smsRelay
    };
  }
  if (!config.smsLibrarySyncEnabled) throw new Error("短信库同步未启用，请检查 Windows 管理器 config.json");
  await taskEvent(task, "sms_sync", "info", "开始主动读取手机短信库", { adbSerial: device.adbSerial });
  lastSmsLibrarySyncBySerial.delete(device.adbSerial);
  // A user-triggered refresh is also a reconciliation operation.  Incremental
  // cursors cannot recover messages that an OEM exposes later (for example,
  // after ColorOS verification-code protection is disabled).
  const result = await syncAdbSmsLibrary(device, { ...options, forceFull: true });
  let notification = { enabled: false, status: "disabled", received: 0, sent: 0 };
  if (isSmsNotificationFallbackEnabledForSerial(device.adbSerial)) {
    try {
      notification = await syncAdbSmsNotification(device, { ...options, forceFull: true });
    } catch (error) {
      notification = {
        enabled: true,
        status: "degraded",
        received: 0,
        sent: 0,
        error: cleanLogText(error?.message || error).slice(0, 160)
      };
      await taskEvent(task, "sms_notification_fallback", "warn", "通知补全不可用，系统短信同步已完成", {
        adbSerial: device.adbSerial,
        error: notification.error
      });
    }
  }
  lastSmsLibrarySyncBySerial.set(device.adbSerial, Date.now());
  return {
    action: "短信库已主动同步",
    ...result,
    notification
  };
}

async function taskSmsCodeProbe(task, options = {}) {
  const device = await assertAdbDeviceOnlineFast(task.adbSerial, options);
  const startedAt = Date.now();
  if (usesSmsRelayManagedSmsPath(device.smsRelay)) {
    let appWakeRequested = false;
    let appWakeError = "";
    try {
      await adb(device.adbSerial, buildSmsRelayRecoverArgs(), { timeoutMs: 8_000, maxBuffer: 64 * 1024 });
      appWakeRequested = true;
    } catch (error) {
      appWakeError = cleanLogText(error?.message || error).slice(0, 200);
    }
    return {
      action: "验证码订单定向唤醒 SmsRelay",
      source: "sms-relay-health",
      smsOrderId: task.payload?.smsOrderId || "",
      appWakeRequested,
      appWakeError,
      diagnostic: {
        source: "sms-relay-health",
        smsOrderId: task.payload?.smsOrderId || "",
        appWakeRequested,
        appWakeError
      },
      durationMs: Date.now() - startedAt
    };
  }

  let provider = { status: "disabled", queried: 0, scanned: 0, sent: 0 };
  let notification = { enabled: false, status: "disabled", received: 0, sent: 0 };
  if (config.smsLibrarySyncEnabled) {
    try {
      provider = await syncAdbSmsLibrary(device, options);
      lastSmsLibrarySyncBySerial.set(device.adbSerial, Date.now());
    } catch (error) {
      if (isScreenPriorityCancellation(error)) throw error;
      provider = {
        status: "degraded",
        queried: 0,
        scanned: 0,
        sent: 0,
        error: cleanLogText(error?.message || error).slice(0, 200)
      };
    }
  }
  if (isSmsNotificationFallbackEnabledForSerial(device.adbSerial)) {
    try {
      notification = await syncAdbSmsNotification(device, options);
    } catch (error) {
      if (isScreenPriorityCancellation(error)) throw error;
      notification = {
        enabled: true,
        status: "degraded",
        received: 0,
        sent: 0,
        error: cleanLogText(error?.message || error).slice(0, 200)
      };
    }
  }
  if (provider.status === "disabled" && notification.status === "disabled") {
    throw new Error("短信库同步与通知补全均未启用");
  }
  const result = {
    action: "验证码订单定向采集完成",
    smsOrderId: task.payload?.smsOrderId || "",
    durationMs: Date.now() - startedAt,
    provider,
    notification,
    diagnostic: {
      smsOrderId: task.payload?.smsOrderId || "",
      providerStatus: provider.status || "ok",
      providerSent: Number(provider.sent || 0),
      notificationStatus: notification.status || "disabled",
      notificationSent: Number(notification.sent || 0)
    }
  };
  log("sms order targeted probe completed", {
    adbSerial: device.adbSerial,
    smsOrderId: result.smsOrderId,
    durationMs: result.durationMs,
    providerStatus: provider.status || "ok",
    providerSent: Number(provider.sent || 0),
    notificationStatus: notification.status || "disabled",
    notificationSent: Number(notification.sent || 0)
  });
  return result;
}

async function taskScreenGalleryImport(task) {
  const device = await assertAdbDeviceOnlineFast(task.adbSerial, { allowScreenControl: true });
  const image = parseGalleryImportImage(task.payload?.imageDataUrl);
  const dir = path.join(cacheDir, "gallery-imports");
  const fileName = galleryImportFileName(task.taskId, image.extension);
  const localPath = path.join(dir, fileName);
  const remoteDir = "/sdcard/Pictures/PhoneCloud";
  const remotePath = `${remoteDir}/${fileName}`;
  const timings = {};
  const startedAt = Date.now();
  try {
    await fs.mkdir(dir, { recursive: true });
    const writeStartedAt = Date.now();
    await fs.writeFile(localPath, image.bytes);
    timings.writeMs = Date.now() - writeStartedAt;
    if (!galleryRemoteDirReadyBySerial.has(device.adbSerial)) {
      const mkdirStartedAt = Date.now();
      await adb(device.adbSerial, ["shell", "mkdir", "-p", remoteDir], { timeoutMs: 8_000, allowScreenControl: true });
      timings.mkdirMs = Date.now() - mkdirStartedAt;
      galleryRemoteDirReadyBySerial.add(device.adbSerial);
    } else {
      timings.mkdirMs = 0;
      timings.mkdirCached = true;
    }
    const pushStartedAt = Date.now();
    await adb(device.adbSerial, ["push", localPath, remotePath], { timeoutMs: 60_000, allowScreenControl: true });
    timings.pushMs = Date.now() - pushStartedAt;
    const scanStartedAt = Date.now();
    const scan = await scanMediaFile(device.adbSerial, remotePath, { allowScreenControl: true });
    timings.scanMs = Date.now() - scanStartedAt;
    timings.totalMs = Date.now() - startedAt;
    const result = {
      action: "图片已导入手机图库",
      message: "图片已导入手机图库",
      remotePath,
      bytes: image.bytes.length,
      scan,
      timings
    };
    await taskEvent(task, "gallery_import", "info", "图片已导入手机图库", result);
    return result;
  } finally {
    await fs.unlink(localPath).catch(() => {});
  }
}

async function taskXhsQrAirtestPoco(task) {
  const taskStartedAt = Date.now();
  const executionMode = task.payload?.executionMode === "windows_xml_uiautomator"
    ? "windows_xml_uiautomator"
    : "windows_airtest_poco";
  const preRunTimings = {};
  let phaseStartedAt = Date.now();
  const device = await assertAdbDeviceOnlineFast(task.adbSerial);
  preRunTimings.assertDeviceMs = Date.now() - phaseStartedAt;
  preRunTimings.onlineCheck = device.onlineCheck || null;
  phaseStartedAt = Date.now();
  if (!(await isPackageInstalled(task.adbSerial, config.xhsPackageName))) {
    throw new Error(`这台手机未安装小红书：${config.xhsPackageName}`);
  }
  preRunTimings.packageCheckMs = Date.now() - phaseStartedAt;
  phaseStartedAt = Date.now();
  const qr = await prepareQrImage(task);
  preRunTimings.prepareQrMs = Date.now() - phaseStartedAt;
  try {
    taskEvent(task, "debug", "info", executionMode === "windows_xml_uiautomator"
      ? "执行 XML UIAutomator 小红书扫码链路"
      : "执行 Airtest + Poco 小红书扫码链路", {
      workflowVersion: executionMode === "windows_xml_uiautomator" ? "xml-uiautomator-xhs-20260729" : "airtest-poco-xhs-20260727",
      executionMode,
      clickMode: executionMode === "windows_xml_uiautomator" ? "XML 元素定位 + ADB touch" : "Poco element定位 + ADB touch",
      runtime: executionMode === "windows_xml_uiautomator" ? "xml_uiautomator" : "airtest_poco"
    }).catch((error) => log("xhs debug event failed", { taskId: task.taskId, error: error.message }));
    phaseStartedAt = Date.now();
    if (executionMode === "windows_xml_uiautomator") {
      await ensureXmlUiAutomatorReady(task.adbSerial);
    } else {
      await ensureDeviceAutomationReady(device, { task });
    }
    preRunTimings.ensureAutomationMs = Date.now() - phaseStartedAt;
    preRunTimings.beforeRunnerMs = Date.now() - taskStartedAt;
    const result = executionMode === "windows_xml_uiautomator"
      ? await runXhsXmlUiAutomatorWorkflow(task, qr)
      : await runXhsAirtestPocoWorkflow(task, qr);
    return {
      action: "小红书扫码任务完成",
      executionMode,
      xhsTaskId: task.payload?.xhsTaskId || "",
      qrRemotePath: qr.remotePath,
      qrTimings: qr.timings,
      qrScan: qr.scan,
      preRunTimings,
      durationMs: Date.now() - taskStartedAt,
      runner: result
    };
  } catch (error) {
    error.diagnostic = {
      ...(error.diagnostic || {}),
      driver: executionMode === "windows_xml_uiautomator" ? "xml_uiautomator" : "airtest_poco",
      qrRemotePath: qr.remotePath
    };
    throw error;
  } finally {
    await fs.unlink(qr.localPath).catch(() => {});
  }
}

async function taskXhsDataCollect(task, options = {}) {
  if (!(await fileExists(config.xhsDataCollectionRunnerPath))) throw new Error("小红书数据采集脚本不存在，请更新 Windows 管理器");
  await assertAdbDeviceOnlineFast(task.adbSerial);
  await ensureXmlUiAutomatorReady(task.adbSerial);
  await taskEvent(task, "xhs_data_collect", "info", "开始读取最近30天作品列表", { xhsAppSlot: task.payload?.xhsAppSlot, days: 30 });
  try {
    return await runXhsDataCollection(task, {
      config, run, adb, cacheDir, deviceCachePath: deviceScanCachePath(), signal: options.signal
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason || error;
    const runnerReason = String(error.stderr || error.message || "").slice(0, 600);
    const message = runnerReason.includes("could not prove") ? "无法进入作品分析，请确认账号已登录且数据权限已开通"
      : runnerReason.includes("stayed blank") ? "作品列表未加载，请稍后重试"
      : runnerReason.includes("occupied") ? "手机被其他任务占用，采集已停止"
      : "小红书数据采集失败，已保留诊断信息";
    error.code = "xhs_data_collection_failed";
    error.diagnostic = { code: error.code, message, runnerReason, restorationErrors: error.restorationErrors || [] };
    error.message = message;
    throw error;
  }
}

async function taskXhsPublish(task) {
  const startedAt = Date.now();
  if (!(await fileExists(config.xhsPublishRunnerPath))) throw new Error(`小红书发布执行器不存在：${config.xhsPublishRunnerPath}`);
  const device = await assertAdbDeviceOnlineFast(task.adbSerial);
  if (!(await isPackageInstalled(task.adbSerial, config.xhsPackageName))) {
    throw new Error(`这台手机未安装小红书：${config.xhsPackageName}`);
  }
  await ensureDeviceAutomationReady(device, { task });
  const prepared = await preparePublishImages(task);
  const payloadPath = path.join(cacheDir, "xhs-publish", safeFileName(`publish-${task.taskId}.json`));
  const payload = {
    serial: task.adbSerial,
    adbPath: config.adbPath,
    xhsPackageName: config.xhsPackageName,
    xhsAppSlot: task.payload?.xhsAppSlot === "app2" ? "app2" : "app1",
    title: String(task.payload?.title || ""),
    content: String(task.payload?.content || ""),
    remotePaths: prepared.map((item) => item.remotePath),
    taskId: task.taskId
  };
  await fs.mkdir(path.dirname(payloadPath), { recursive: true });
  await fs.writeFile(payloadPath, JSON.stringify(payload), "utf8");
  await taskEvent(task, "xhs_publish", "info", "启动小红书图文发布流程", {
    xhsAppSlot: payload.xhsAppSlot,
    imageCount: payload.remotePaths.length,
    clickMode: "Poco 元素定位"
  });
  try {
    const output = await run(config.pythonCommand, [config.xhsPublishRunnerPath, "--payload", payloadPath], {
      timeoutMs: Math.max(180_000, config.xhsTaskTimeoutSeconds * 1000),
      maxBuffer: 10 * 1024 * 1024,
      cwd: agentDir,
      env: airtestEnv()
    });
    const parsed = parseAirtestRunnerOutput(output);
    await replayAirtestEvents(task, parsed.log || []);
    if (!parsed.ok) throw new Error(parsed.error || "小红书发布流程失败");
    return {
      action: "小红书图文发布完成",
      message: "已点击发布并确认发布结果",
      executionMode: "windows_airtest_poco",
      remotePaths: payload.remotePaths,
      publishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      runner: parsed
    };
  } finally {
    await fs.unlink(payloadPath).catch(() => {});
    await Promise.all(prepared.map((item) => fs.unlink(item.localPath).catch(() => {})));
  }
}

function kuaishouLeadEventMessage(event = {}) {
  if (event.event === "candidate_selected") return `已选择飞书第 ${event.row || "?"} 行，准备录入 ${event.phone || "号码"}`;
  if (event.event === "row_claimed") return `已占用飞书第 ${event.row || "?"} 行，正在操作手机`;
  if (event.event === "row_finalized") return `飞书第 ${event.row || "?"} 行已更新为“${event.status || "已处理"}”`;
  if (event.event === "row_skipped") return `飞书第 ${event.row || "?"} 行领取状态已变化，未操作手机并继续扫描`;
  if (event.event === "queue_empty") return "当前没有未处理或可安全重试的数据，继续等待新行";
  if (event.event === "waiting_for_new_rows") return `等待 ${event.seconds || 0} 秒后再次扫描飞书`;
  if (event.event === "waiting_for_queue_retry") return `飞书读取暂时失败，等待 ${event.seconds || 0} 秒后重试`;
  if (event.event === "waiting_after_row_skip") return `等待 ${event.seconds || 0} 秒后继续扫描飞书`;
  if (event.event === "queue_read_failed") return `飞书读取暂时失败：${event.error || "网络异常"}`;
  if (event.event === "waiting") return `等待 ${event.seconds || 0} 秒后处理下一条`;
  if (event.event === "consumer_stopped") return "快手录入消费器已停止";
  return "快手录入任务运行中";
}

function runStreamingJsonLines(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      shell: options.shell ?? needsShell(file),
      cwd: options.cwd,
      env: options.env,
      detached: options.killTree === true,
      stdio: [options.controlStdin ? "pipe" : "ignore", "pipe", "pipe"]
    });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let stopRequested = false;
    let forceStopTimer = null;
    let eventQueue = Promise.resolve();
    const enqueueLine = (line) => {
      const text = String(line || "").trim();
      if (!text) return;
      eventQueue = eventQueue.then(async () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { event: "runner_output", message: text.slice(0, 500) }; }
        await options.onLine?.(parsed);
      }).catch((error) => log("streaming child event relay failed", { error: error.message }));
    };
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk || "");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) enqueueLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk || "")}`.slice(-4000);
    });
    child.stdin?.on("error", () => {});
    const forceStop = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") {
        try {
          const terminator = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore"
          });
          terminator.on("error", () => {
            try { child.kill("SIGKILL"); } catch {}
          });
          terminator.unref();
          return;
        } catch {}
      } else if (options.killTree) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {}
      }
      try { child.kill("SIGKILL"); } catch {}
    };
    const stop = () => {
      if (stopRequested || child.exitCode !== null) return;
      stopRequested = true;
      if (options.controlStdin && child.stdin?.writable) {
        try { child.stdin.end("stop\n"); } catch {}
        forceStopTimer = setTimeout(forceStop, Math.max(500, Number(options.forceStopAfterMs || 3_000)));
        forceStopTimer.unref?.();
        return;
      }
      forceStop();
    };
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (forceStopTimer) clearTimeout(forceStopTimer);
      options.signal?.removeEventListener("abort", stop);
      reject(options.signal?.aborted ? (options.signal.reason || automationTaskCancellationError()) : error);
    });
    child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      if (forceStopTimer) clearTimeout(forceStopTimer);
      options.signal?.removeEventListener("abort", stop);
      if (stdoutBuffer.trim()) enqueueLine(stdoutBuffer);
      await eventQueue;
      if (options.signal?.aborted) {
        reject(options.signal.reason || automationTaskCancellationError());
        return;
      }
      if (code !== 0) {
        const error = new Error(`快手录入消费器异常退出 (exit=${code}, signal=${signal || "none"})${stderr ? `: ${stderr}` : ""}`);
        error.code = "kuaishou_lead_runner_failed";
        reject(error);
        return;
      }
      resolve({ code, signal });
    });
  });
}

async function taskKuaishouLead(task, options = {}) {
  if (!config.kuaishouLeadEnabled) throw new Error("当前 Windows 管理器未启用快手录入");
  for (const [label, target] of [
    ["快手录入消费器", config.kuaishouLeadRunnerPath],
    ["快手手机执行器", config.kuaishouVehicleLeadRunnerPath]
  ]) {
    if (!(await fileExists(target))) throw new Error(`${label}不存在：${target}`);
  }
  if (!(await fileExists(config.kuaishouLeadCredentialsPath)) && (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET)) {
    throw new Error(`飞书凭据文件不存在：${config.kuaishouLeadCredentialsPath}`);
  }
  const device = await assertAdbDeviceOnlineFast(task.adbSerial);
  if (!(await isPackageInstalled(task.adbSerial, config.kuaishouPackageName))) {
    throw new Error(`这台手机未安装快手：${config.kuaishouPackageName}`);
  }
  await ensureDeviceAutomationReady(device, { task });
  const minDelaySeconds = Math.max(30, Number(task.payload?.minDelaySeconds || 240));
  const maxDelaySeconds = Math.max(minDelaySeconds, Math.min(3600, Number(task.payload?.maxDelaySeconds || 420)));
  const args = [
    config.kuaishouLeadRunnerPath,
    "run",
    "--credentials", config.kuaishouLeadCredentialsPath,
    "--wiki-token", config.kuaishouLeadWikiToken,
    "--serial", task.adbSerial,
    "--adb", config.adbPath,
    "--python", config.pythonCommand,
    "--vehicle-runner", config.kuaishouVehicleLeadRunnerPath,
    "--min-delay", String(minDelaySeconds),
    "--max-delay", String(maxDelaySeconds),
    "--heartbeat-seconds", String(config.kuaishouLeadHeartbeatSeconds),
    "--control-stdin"
  ];
  await taskEvent(task, "kuaishou_lead", "info", "快手录入已启动，将持续扫描飞书直到用户停止", {
    minDelaySeconds,
    maxDelaySeconds,
    executionMode: "windows_airtest_poco"
  });
  await runStreamingJsonLines(process.execPath, args, {
    cwd: agentDir,
    env: airtestEnv(),
    signal: options.signal,
    controlStdin: true,
    killTree: true,
    onLine: async (event) => {
      const queueEvent = String(event?.event || "runner_output");
      if (queueEvent === "consumer_heartbeat") {
        await taskEvent(task, "heartbeat", "info", "快手录入任务心跳", { queueEvent });
        return;
      }
      await taskEvent(task, "kuaishou_lead", queueEvent.includes("failed") ? "warn" : "info", kuaishouLeadEventMessage(event), {
        ...event,
        queueEvent
      });
    }
  });
  throw Object.assign(new Error("快手录入消费器意外结束"), { code: "kuaishou_lead_unexpected_exit" });
}

function alipayAccountSwitchReasonFromError(rawMessage = "") {
  const raw = String(rawMessage || "");
  if (raw.includes("alipay_access_denied_account_switch_required")) return "access_denied";
  const match = raw.match(/alipay_account_restriction_switch_required:([a-z_]+)/);
  return ["device_risk", "frequent_or_abnormal_access"].includes(match?.[1])
    ? match[1]
    : "";
}

function alipayLimitMessage(reason = "") {
  const messages = {
    access_denied: "当前支付宝账号在查询后出现“访问被拒绝”，自动切换所有已保存账号后仍无法完成当前号码。",
    device_risk: "当前支付宝账号在查询后出现设备风险限制，自动切换所有已保存账号后仍无法完成当前号码。",
    frequent_or_abnormal_access: "当前支付宝账号在查询后提示操作频繁或访问异常，自动切换所有已保存账号后仍无法完成当前号码。"
  };
  return messages[String(reason || "")] || "当前支付宝账号在查询后触发访问限制。请点击“选择切换账号”后重试该号码。";
}

function classifyAlipayNameLookupFailure(rawMessage = "") {
  const raw = String(rawMessage || "");
  const compactReason = raw
    .replace(/texts=\[[\s\S]*$/i, "texts=<redacted>")
    .replace(/search_input_readback_mismatch:[^;]*/i, "search_input_readback_mismatch:<redacted>")
    .replace(/\d/g, "#")
    .slice(0, 500);
  const diagnostic = { code: "alipay_lookup_failed", retryable: true, runnerReason: compactReason };
  if (raw.includes("local_lookup_result_unconfirmed:")) return { ...diagnostic,
    code: "alipay_lookup_result_unconfirmed", retryable: false,
    message: "当前号码查询结果尚未确认，原请求已保留，等待平台恢复；请勿重新创建查询。" };
  if (raw.includes("alipay_no_available_account")) return { ...diagnostic,
    code: "alipay_no_available_account", retryable: false,
    message: "当前手机无可用账户：已保存账户全部在八小时冷却中。" };
  if (/alipay_(?:account_identity_unverified|account_preflight_required|target_account_cooling|account_cooldown_data_invalid)/.test(raw)) {
    return { ...diagnostic, code: "alipay_account_identity_unverified", retryable: false,
      message: "账户身份或冷却状态未确认，已停止查询；请重新启动会话检查账户。" };
  }
  if (raw.includes("alipay_all_saved_accounts_restricted")) {
    const reason = String(raw.match(/alipay_all_saved_accounts_restricted:([a-z_]+)/)?.[1] || "");
    return {
      ...diagnostic,
      code: "alipay_all_saved_accounts_restricted",
      retryable: false,
      limitReached: true,
      requiresAccountSwitch: true,
      limitReason: reason,
      message: "这台手机保存的支付宝账号查询后均触发限制，请更换可用账号或稍后再试。"
    };
  }
  if (raw.includes("alipay_access_denied_after_account_switch")) {
    return {
      ...diagnostic,
      code: "alipay_access_denied_after_account_switch",
      retryable: false,
      message: "切换支付宝账号后仍被拒绝访问，请先更换手机网络后再重试。"
    };
  }
  if (raw.includes("alipay_account_restricted_after_account_switch")) {
    return {
      ...diagnostic,
      code: "alipay_account_restricted_after_account_switch",
      retryable: false,
      message: "切换支付宝账号后仍触发账号或设备限制，请稍后更换其他账号或设备重试。"
    };
  }
  if (raw.includes("alipay_access_denied_account_switch_required")) {
    return {
      ...diagnostic,
      code: "alipay_access_denied_account_switch_required",
      retryable: false,
      limitReached: true,
      requiresAccountSwitch: true,
      limitReason: "access_denied",
      phoneQueryStarted: true,
      message: alipayLimitMessage("access_denied")
    };
  }
  if (raw.includes("alipay_account_restriction_switch_required")) {
    const reason = alipayAccountSwitchReasonFromError(raw);
    return {
      ...diagnostic,
      code: "alipay_account_restriction_switch_required",
      retryable: false,
      limitReached: true,
      requiresAccountSwitch: true,
      limitReason: reason,
      phoneQueryStarted: true,
      message: alipayLimitMessage(reason)
    };
  }
  if (raw.includes("alipay_account_restriction_before_search")) {
    const reason = String(raw.match(/alipay_account_restriction_before_search:([a-z_]+)/)?.[1] || "");
    return {
      ...diagnostic,
      code: "alipay_account_restriction_before_search",
      retryable: false,
      limitReached: false,
      requiresAccountSwitch: false,
      limitReason: reason,
      accountRestrictionDetected: true,
      phoneQueryStarted: false,
      message: "支付宝在本次号码查询开始前就已显示账号或设备限制，不能认定为该号码触发的查询上限；请人工确认页面，或主动切换账号。"
    };
  }
  if (raw.includes("alipay_human_verification_required")) {
    return {
      ...diagnostic,
      code: "alipay_human_verification_required",
      requiresHumanAction: true,
      message: "支付宝要求人工完成滑动验证；完成后可在当前会话重试同一号码"
    };
  }
  if (raw.includes("poco_alipay_login_required")) {
    return {
      ...diagnostic,
      code: "alipay_login_required",
      retryable: false,
      message: "这台手机的支付宝当前停留在登录页，未提交查询号码；请先登录账号后再试。"
    };
  }
  if (raw.includes("alipay_saved_account_labels_not_unique")) {
    return {
      ...diagnostic,
      code: "alipay_saved_account_labels_not_unique",
      retryable: false,
      message: "支付宝对多个账号显示了相同的脱敏标识，无法安全区分，本次没有点击任何账号。"
    };
  }
  if (raw.includes("alipay_saved_account_candidate_missing")) {
    return {
      ...diagnostic,
      code: "alipay_saved_account_candidate_missing",
      message: "支付宝账号列表不足两个，或“当前”标记不唯一，无法安全切换。"
    };
  }
  if (raw.includes("alipay_target_account_already_current")) {
    return {
      ...diagnostic,
      code: "alipay_target_account_already_current",
      message: "所选支付宝账号已经是当前账号，请选择其他账号。"
    };
  }
  if (raw.includes("alipay_target_account_not_unique_or_missing") || raw.includes("alipay_target_account_required")) {
    return {
      ...diagnostic,
      code: "alipay_target_account_stale",
      message: "所选支付宝账号已不在当前列表中，请重新读取账号后再选择。"
    };
  }
  if (raw.includes("search_input_readback_mismatch")) {
    return {
      ...diagnostic,
      code: "alipay_search_input_not_stable",
      message: "支付宝输入框未能稳定写入号码，自动恢复后仍失败；请重试当前号码。"
    };
  }
  if (raw.includes("alipay_person_result_not_found")) {
    return {
      ...diagnostic,
      code: "alipay_person_result_not_found",
      message: "支付宝未返回可识别的姓名结果，请确认号码后重试。"
    };
  }
  if (raw.includes("selector_missing") || raw.includes("selector_not_unique")) {
    return {
      ...diagnostic,
      code: "alipay_page_element_changed",
      message: "支付宝页面元素与当前脚本不一致，已保存诊断证据。"
    };
  }
  if (raw.includes("uiautomator_hierarchy_missing")) {
    return {
      ...diagnostic,
      code: "alipay_ui_hierarchy_unavailable",
      message: "手机页面元素暂时无法读取，自动恢复后仍失败；请重试。"
    };
  }
  if (raw.includes("device_not_online")) {
    return { ...diagnostic, code: "device_not_online", retryable: false, message: "手机 ADB 已离线，查询会话已停止。" };
  }
  if (raw.includes("alipay_not_installed")) {
    return { ...diagnostic, code: "alipay_not_installed", retryable: false, message: "这台手机未安装支付宝。" };
  }
  return { ...diagnostic, message: "支付宝查名字执行失败，已保留具体诊断原因；可重试当前号码。" };
}

async function observeLookupHumanVerification(probe) {
  const serial = probe.adbSerial;
  if (activeTaskSerials.has(serial) || automationPreflightRunning.has(serial)) return "unknown";
  const worker = airtestWorkersBySerial.get(serial);
  if (!probe.screenSessionId && !screenControlledSerials.has(serial) && worker && !worker.exited) {
    // Reuse only an already-idle worker. Never compete for UiAutomation with
    // a living Poco process, including one whose observation has timed out.
    if (worker.stopping || worker.pending || worker.readyResolve
      || failedHumanProbeWorkers.has(worker)) return "unknown";
    try {
      const parsed = await worker.enqueue({ operation: "human_probe", workflow: "alipay_name",
        serial, adbPath: config.adbPath, requestId: `human-probe-${probe.probeId}` }, 6_000);
      if (activeTaskSerials.has(serial) || screenControlledSerials.has(serial)
        || airtestWorkersBySerial.get(serial) !== worker || worker.exited) return "unknown";
      return parsed?.ok ? parsed.verificationState : "unknown";
    } catch {
      failedHumanProbeWorkers.add(worker);
      return "unknown";
    }
  }
  // Once Poco has fully exited, a bounded read can also observe a phone whose
  // control window was closed. Observation never creates or repairs a worker.
  const screen = probe.screenSessionId ? screenStreamManager.sessions.get(probe.screenSessionId) : null;
  const stable = () => {
    const currentWorker = airtestWorkersBySerial.get(serial);
    if (activeTaskSerials.has(serial) || automationPreflightRunning.has(serial) || currentWorker && !currentWorker.exited) return false;
    if (!probe.screenSessionId) return !screenControlledSerials.has(serial);
    return screen && screen.serial === serial && !screen.closed
      && screenStreamManager.sessions.get(probe.screenSessionId) === screen
      && screenControlledSerials.has(serial);
  };
  if (!stable()) return "unknown";
  const options = { allowScreenControl: Boolean(screen), timeoutMs: 2_000,
    actorLabel: "lookup-human-readonly" };
  const before = await adb(serial, ["shell", "dumpsys", "window"], options);
  if (!stable()) return "unknown";
  // Android's dump waits for idle for up to ten seconds. Allow that wait but
  // keep the whole observation within the server's expiring thirty-second lease.
  const xml = await adb(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"], { ...options, timeoutMs: 15_000 });
  if (!stable()) return "unknown";
  const after = await adb(serial, ["shell", "dumpsys", "window"], options);
  if (!stable()) return "unknown";
  return classifyHumanVerificationXml(xml, before, after);
}

async function taskAlipayNameLookupWithAccounts(task, options = {}) {
  return runLookupWithAccountPolicy({ task,
    assertAllowed: () => {
      if (options.signal?.aborted) throw automationTaskCancellationError();
      if (screenControlledSerials.has(task.adbSerial)) throw screenPriorityCancellationError();
    },
    execute: (next, hooks = {}) => taskAlipayNameLookup(next, { ...options, ...hooks }),
    recordLimit: (record) => taskEvent(task, "alipay_name", "warn", "查询限制已确认，保存账户八小时冷却后再继续", {
      ...record, currentAccount: record.account, accountSwitchRequired: true,
      stepId: "lookup_account_limit_confirmed"
    })
  });
}

async function taskAlipayNameLookup(task, options = {}) {
  const startedAt = Date.now();
  if (!(await fileExists(config.alipayNameLookupRunnerPath))) throw new Error(`支付宝查名字执行器不存在：${config.alipayNameLookupRunnerPath}`);
  await assertAdbDeviceOnlineFast(task.adbSerial);
  const packageName = "com.eg.android.AlipayGphone";
  if (!(await isPackageInstalled(task.adbSerial, packageName))) throw new Error("这台手机未安装支付宝");
  const operation = task.type === "alipay_name_start"
    ? "start"
    : task.type === "alipay_name_stop"
      ? "stop"
      : task.type === "alipay_name_switch"
        ? (String(task.payload?.accountAction || "list") === "select" ? "switch" : "list_accounts")
        : task.payload?.restartAfterHumanVerification === true
          ? "query"
          : task.payload?.resumeAfterHumanVerification === true
          ? "query_resume"
          : "query";
  const queryOperation = ["query", "query_resume"].includes(operation);
  const accountOperation = ["list_accounts", "switch"].includes(operation)
    || (operation === "start" && task.payload?.accountCooldownProtocol === 1);
  if (operation === "stop") clearAirtestLookupWarmLease(task.adbSerial, "lookup_session_stopped");
  if (task.payload?.restartAfterHumanVerification === true) automationResumeScheduler.cancel(task.adbSerial);
  const payload = {
    operation,
    workflow: "alipay_name",
    serial: task.adbSerial,
    adbPath: config.adbPath,
    phoneNumber: String(task.payload?.phoneNumber || ""),
    targetAccount: String(task.payload?.targetAccount || ""),
    accountCooldownProtocol: task.payload?.accountCooldownProtocol,
    knownAccount: String(task.payload?.knownAccount || ""),
    preparedEmptyResult: task.payload?.preparedEmptyResult === true,
    accountIdentityVerified: task.payload?.accountIdentityVerified === true,
    accountCooldowns: task.payload?.accountCooldowns || [],
    savedAccounts: task.payload?.savedAccounts || [],
    maxRecoveryAttempts: Math.min(2, Math.max(0, Number(task.payload?.maxRecoveryAttempts ?? 2))),
    taskId: task.taskId
  };
  await taskEvent(task, "alipay_name", "info", operation === "query_resume"
    ? "人工验证完成后继续获取当前号码的姓名结果"
    : operation === "query"
      ? "复用支付宝搜索页查询号码"
    : operation === "start"
      ? "建立支付宝查名字会话"
      : operation === "list_accounts"
        ? "读取支付宝已保存账号，等待用户选择"
        : operation === "switch"
          ? `用户请求切换到指定支付宝账号 ${payload.targetAccount}`
        : "结束支付宝查名字会话", {
    operation,
    reuseSearchSession: queryOperation,
    resumeAfterHumanVerification: operation === "query_resume",
    restartAfterHumanVerification: task.payload?.restartAfterHumanVerification === true,
    resubmitsInput: operation === "query_resume" ? false : undefined,
    maxRecoveryAttempts: payload.maxRecoveryAttempts,
    preferredDriver: accountOperation ? "xml_uiautomator_account_switch" : "poco_fast_path",
    manualAccountSwitch: operation === "switch"
  });

  const buildResult = (parsed, driver) => {
    if (operation !== "stop") touchAirtestLookupWarmLease(task.adbSerial, operation);
    return {
      action: queryOperation ? "查名字完成" : operation === "start" ? "查名字会话已就绪" : operation === "list_accounts" ? "支付宝账号列表已读取" : operation === "switch" ? "支付宝账号切换完成" : "查名字会话已结束",
      message: parsed.message || "",
      realNameTailCharacter: parsed.realNameTailCharacter || "",
      alipayDisplayName: parsed.alipayDisplayName || "",
      matchedPhone: parsed.matchedPhone || "",
      currentAccount: parsed.currentAccount || "",
      accountIdentityVerified: parsed.accountIdentityVerified === true,
      accountSwitched: Boolean(parsed.accountSwitched),
      accountSwitchReason: String(parsed.accountSwitchReason || ""),
      accountSwitchCount: Math.max(0, Number(parsed.accountSwitchCount || 0)),
      accountSwitchHistory: Array.isArray(parsed.accountSwitchHistory) ? parsed.accountSwitchHistory : [],
      restrictedAccounts: Array.isArray(parsed.restrictedAccounts) ? parsed.restrictedAccounts : [],
      savedAccounts: Array.isArray(parsed.savedAccounts) ? parsed.savedAccounts.slice(0, 12).map((choice) => ({
        account: String(choice?.account || "").slice(0, 120),
        current: Boolean(choice?.current)
      })).filter((choice) => choice.account) : [],
      recoveryAttempts: Number(parsed.recoveryAttempts || 0),
      notFound: Boolean(parsed.notFound),
      diagnostic: accountOperation ? {
        fromAccount: String(parsed.accountSwitchHistory?.at(-1)?.fromAccount || ""),
        toAccount: String(parsed.currentAccount || ""),
        savedAccountCount: Math.max(0, Number(parsed.savedAccountCount || 0))
      } : null,
      durationMs: Date.now() - startedAt,
      driver,
      runner: parsed
    };
  };

  if (!accountOperation) {
    try {
      let parsed = null;
      // Start may need one additional bounded attach after a hierarchy
      // transport failure.  The Python runner now returns that failure
      // immediately without relaunching Alipay, so a third worker can attach
      // to the stable foreground page while the overall 38-second SLO remains
      // enforceable by the platform caller.
      const pocoColdStartAttempts = operation === "start" ? 3 : 2;
      for (let attempt = 1; attempt <= pocoColdStartAttempts; attempt += 1) {
        try {
          parsed = await runXhsAirtestPocoWorker(payload, {
            // Older OPPO/ColorOS/Honor devices can take more than 12 seconds
            // to bootstrap PocoService. Keep each wait bounded and rebuild
            // Poco once before declaring the independent XML path necessary.
            readyTimeoutMs: 25_000,
            timeoutMs: queryOperation ? 65_000 : operation === "start" ? 45_000 : 12_000,
            maxIdleMs: 15 * 60_000,
            onEvent: (event) => replayAirtestEvents(task, [event])
          });
          if (operation === "start"
            && !parsed.ok
            && isRetryableAlipayPocoStartFailure(parsed.error)
            && attempt < pocoColdStartAttempts) {
            await taskEvent(task, "alipay_name", "warn", "Poco 启动传输超时，正在重建 Poco 后重试", {
              operation,
              retryOperation: "start",
              attempt,
              nextAttempt: attempt + 1,
              reason: "poco_transport_timeout",
              fallbackSkipped: "xml_uiautomator",
              driver: "poco"
            });
            await stopAirtestWorker(task.adbSerial, "poco_start_transport_timeout").catch(() => {});
            parsed = null;
            continue;
          }
          break;
        } catch (error) {
          if (isAutomationTaskCancellation(error)) throw error;
          const errorMessage = String(error?.message || error);
          const coldStartTimedOut = errorMessage.includes("Airtest/Poco worker 启动超时");
          const startRequestTimedOut = operation === "start"
            && errorMessage.includes("Airtest/Poco worker 执行超时");
          const workerProbeFailed = operation === "start"
            && errorMessage.includes("Airtest/Poco worker 探活未通过");
          if ((!coldStartTimedOut && !startRequestTimedOut && !workerProbeFailed)
            || attempt >= pocoColdStartAttempts) throw error;
          const retryReason = coldStartTimedOut
            ? "worker_ready_timeout"
            : startRequestTimedOut
              ? "start_request_timeout"
              : "worker_probe_failed";
          await stopAirtestWorker(task.adbSerial, `poco_start_${retryReason}`).catch(() => {});
          await taskEvent(task, "alipay_name", "warn", "Poco 启动阶段异常，正在重建 Poco 后重试", {
            operation,
            attempt,
            nextAttempt: attempt + 1,
            reason: retryReason,
            fallbackSkipped: "xml_uiautomator",
            driver: "poco"
          });
        }
      }
      if (!parsed) throw new Error("Airtest/Poco worker 冷启动重试未返回结果");
      const streamedReplayCount = Number(parsed.streamedReplayCount || 0);
      if (!streamedReplayCount) await replayAirtestEvents(task, parsed.log || []);
      if (operation === "query_resume"
        && !parsed.ok
        && String(parsed.error || "").includes("poco_query_result_channel_timeout_after_input")) {
        await taskEvent(task, "alipay_name", "warn", "人工恢复结果读取超时，正在重建 Poco 只读检查当前结果页", {
          operation,
          retryOperation: "query_resume",
          resumeAttempt: 1,
          maxResumeAttempts: 1,
          observationOnly: true,
          resubmitsInput: false,
          resubmitsSearch: false,
          fallbackSkipped: "xml_uiautomator",
          driver: "poco"
        });
        await stopAirtestWorker(task.adbSerial, "poco_query_resume_result_channel_timeout").catch(() => {});
        let observed;
        try {
          observed = await runXhsAirtestPocoWorker({
            ...payload,
            operation: "query_resume",
            allowEmptyInputRecovery: false,
            observationOnlyResume: true
          }, {
            readyTimeoutMs: 25_000,
            timeoutMs: 65_000,
            maxIdleMs: 15 * 60_000,
            onEvent: (event) => replayAirtestEvents(task, [event])
          });
        } catch (observationError) {
          throw new Error(`poco_query_resume_observation_failed:${String(observationError?.message || observationError)}`);
        }
        const observationReplayCount = Number(observed.streamedReplayCount || 0);
        if (!observationReplayCount) await replayAirtestEvents(task, observed.log || []);
        if (!observed.ok) {
          throw new Error(`poco_query_resume_observation_failed:${String(observed.error || "unknown")}`);
        }
        parsed = observed;
      }
      if (operation === "query"
        && !parsed.ok
        && String(parsed.error || "").includes("poco_query_result_channel_timeout_after_input")) {
        const initialResumeError = String(parsed.error || "");
        const maxQueryResumeAttempts = 2;
        for (let resumeAttempt = 1; resumeAttempt <= maxQueryResumeAttempts; resumeAttempt += 1) {
          // Empty-field recovery is safe only when the input delivery itself
          // was ambiguous. Once ADB input returned successfully, every later
          // recovery is observation-only so a submitted query can never be
          // typed a second time after a transient hierarchy timeout.
          const allowEmptyInputRecovery = resumeAttempt === 1
            && (initialResumeError.includes("poco_bounded_input_failed")
              || initialResumeError.includes("poco_input_failed"));
          await taskEvent(task, "alipay_name", "warn", "Poco 查询结果通道超时，正在重建 Poco 恢复结果页面", {
            operation,
            retryOperation: "query_resume",
            resumeAttempt,
            maxResumeAttempts: maxQueryResumeAttempts,
            resubmitsInput: allowEmptyInputRecovery ? "only_after_confirmed_empty" : false,
            fallbackSkipped: "xml_uiautomator",
            driver: "poco"
          });
          await stopAirtestWorker(task.adbSerial, "poco_query_result_channel_timeout").catch(() => {});
          let resumed;
          try {
            resumed = await runXhsAirtestPocoWorker({
              ...payload,
              operation: "query_resume",
              allowEmptyInputRecovery
            }, {
              readyTimeoutMs: 25_000,
              timeoutMs: 65_000,
              maxIdleMs: 15 * 60_000,
              onEvent: (event) => replayAirtestEvents(task, [event])
            });
          } catch (resumeError) {
            throw new Error(`poco_query_resume_failed:${String(resumeError?.message || resumeError)}`);
          }
          const resumeReplayCount = Number(resumed.streamedReplayCount || 0);
          if (!resumeReplayCount) await replayAirtestEvents(task, resumed.log || []);
          if (resumed.ok) {
            parsed = resumed;
            break;
          }
          const resumeError = String(resumed.error || "unknown");
          const remainsPostInputTransportFailure = resumeError.includes(
            "poco_query_result_channel_timeout_after_input"
          );
          if (!remainsPostInputTransportFailure || resumeAttempt >= maxQueryResumeAttempts) {
            throw new Error(`poco_query_resume_failed:${resumeError}`);
          }
        }
      }
      if (!parsed.ok) throw new Error(parsed.error || "支付宝 Poco 快路径失败");
      const result = buildResult(parsed, "poco");
      if (operation === "stop") {
        await stopAirtestWorker(task.adbSerial, "lookup_session_stopped");
        markAutomationReadyOnDemand(task.adbSerial, "lookup_session_stopped");
      }
      return result;
    } catch (error) {
      if (isAutomationTaskCancellation(error)) throw error;
      // A generic execution/page failure is not limited to the input stage.
      // Preserve the task/phone and bound an app-only full-path retry to one.
      try {
        const recovered = await restartLookupQueryOnce({
          operation, error, payload,
          assertAllowed: () => {
            if (options.signal?.aborted) throw automationTaskCancellationError();
            if (screenControlledSerials.has(task.adbSerial)) throw screenPriorityCancellationError();
          },
          onRecovery: () => taskEvent(task, "alipay_name", "warn", "查名字执行异常，最多重启支付宝一次后重查当前号码", {
            recoveryAttempt: 1, maxRecoveryAttempts: 1, sameTask: true,
            resubmitsInput: true, accountSwitchRequested: false, driver: "poco"
          }),
          stopWorker: () => stopAirtestWorker(task.adbSerial, "lookup_query_app_recovery"),
          runWorker: async (recoveryPayload) => {
            if (recoveryPayload.pageRecoveryStage === "continue_query" && options.beforeLookupRecovery) {
              const policy = await options.beforeLookupRecovery();
              recoveryPayload = { ...recoveryPayload, ...policy };
            }
            return runXhsAirtestPocoWorker(recoveryPayload, {
            readyTimeoutMs: 25_000, timeoutMs: recoveryPayload.pageRecoveryStage === "continue_query" ? 65_000 : 45_000, maxIdleMs: 15 * 60_000,
            onEvent: (event) => replayAirtestEvents(task, [event])
          }); }
        });
        if (recovered) {
          if (!Number(recovered.streamedReplayCount || 0)) await replayAirtestEvents(task, recovered.log || []);
          if (!recovered.ok) throw new Error(recovered.error || "unknown");
          return buildResult({ ...recovered, recoveryAttempts: 1 }, "poco");
        }
      } catch (recoveryError) {
        if (isAutomationTaskCancellation(recoveryError)) throw recoveryError;
        error = new Error(`poco_query_page_recovery_failed:${String(recoveryError?.message || recoveryError)}`);
      }
      const pocoError = String(error?.message || error || "");
      if (operation === "stop") {
        // Ending a lookup session is a platform lifecycle action. Clearing the
        // warm search input is only best effort; never start the independent
        // XML/UIAutomator stack just because a stale PocoService session could
        // not be probed or recycled.
        await taskEvent(task, "alipay_name", "warn", "Poco 结束清理异常，已直接释放查名字会话", {
          operation,
          reason: cleanLogText(pocoError).slice(0, 500),
          fallbackSkipped: "xml_uiautomator",
          driver: "poco"
        });
        await stopAirtestWorker(task.adbSerial, "lookup_session_stop_best_effort").catch(() => {});
        markAutomationReadyOnDemand(task.adbSerial, "lookup_session_stopped");
        return buildResult({ ok: true, message: "session_stopped", log: [] }, "poco");
      }
      if (pocoError.includes("poco_query_page_recovery_failed:")) {
        const diagnostic = classifyAlipayNameLookupFailure(pocoError);
        const runnerError = new Error(diagnostic.message);
        runnerError.code = diagnostic.code;
        runnerError.diagnostic = { ...diagnostic, appRecoveryAttempts: 1 };
        throw runnerError;
      }
      if (payload.accountCooldownProtocol === 1 && pocoError.includes("alipay_account_restriction_before_search:")) {
        const diagnostic = classifyAlipayNameLookupFailure(pocoError);
        throw Object.assign(new Error(diagnostic.message), { code: diagnostic.code, diagnostic });
      }
      const automaticAccountSwitchReason = ["query", "query_resume"].includes(operation)
        ? alipayAccountSwitchReasonFromError(pocoError)
        : "";
      if (operation === "query_resume" && !automaticAccountSwitchReason) {
        const diagnostic = classifyAlipayNameLookupFailure(pocoError);
        const runnerError = new Error(diagnostic.message);
        runnerError.code = diagnostic.code;
        runnerError.diagnostic = { ...diagnostic, resumeAfterHumanVerification: true, resubmitsInput: false };
        throw runnerError;
      }
      if (automaticAccountSwitchReason) {
        if (payload.accountCooldownProtocol === 1) {
          const diagnostic = classifyAlipayNameLookupFailure(pocoError);
          throw Object.assign(new Error(diagnostic.message), { code: diagnostic.code, diagnostic });
        }
        await taskEvent(task, "alipay_name", "warn", "检测到账号查询限制，正在自动切换已保存账号并重试当前号码", {
          operation,
          restrictionReason: automaticAccountSwitchReason,
          retryCurrentPhone: true,
          resumedAfterHumanVerification: operation === "query_resume",
          fallbackDriver: "xml_uiautomator_account_rotation"
        });
        await stopAirtestWorker(task.adbSerial, "automatic_account_rotation").catch(() => {});
        // A post-jigsaw result can itself be an exact account restriction.
        // The independent XML runner owns account rotation and intentionally
        // replays this same phone only after switching to another saved account.
        payload.operation = "query";
      } else if (!shouldFallbackAlipayPocoFailure(error)) {
        const diagnostic = classifyAlipayNameLookupFailure(pocoError);
        const runnerError = new Error(diagnostic.message);
        runnerError.code = diagnostic.code;
        runnerError.diagnostic = diagnostic;
        throw runnerError;
      } else {
        await taskEvent(task, "alipay_name", "warn", "Poco 快路径异常，正在切换 XML 兜底", {
          operation,
          fallbackDriver: "xml_uiautomator",
          reason: cleanLogText(pocoError).slice(0, 500)
        });
      }
    }
  }

  const accountSwitchRequested = operation === "switch";
  await ensureXmlUiAutomatorReady(task.adbSerial);
  const payloadPath = path.join(cacheDir, "alipay-name", safeFileName(`${operation}-${task.taskId}.json`));
  await fs.mkdir(path.dirname(payloadPath), { recursive: true });
  await fs.writeFile(payloadPath, JSON.stringify(payload), "utf8");
  try {
    let output;
    try {
      output = await run(config.pythonCommand, [config.alipayNameLookupRunnerPath, "--payload", payloadPath], {
        timeoutMs: payload.operation === "query" ? 1_800_000 : 120_000,
        maxBuffer: 10 * 1024 * 1024,
        cwd: agentDir,
        env: airtestEnv(),
        signal: options.signal
      });
    } catch (error) {
      if (isAutomationTaskCancellation(error)) throw error;
      const failed = parseAirtestRunnerOutput(String(error.stdout || ""));
      await replayAirtestEvents(task, failed.log || []);
      const diagnostic = classifyAlipayNameLookupFailure(failed.error || error.message || "");
      diagnostic.accountSwitched = Boolean(failed.accountSwitched);
      diagnostic.currentAccount = String(failed.currentAccount || "");
      diagnostic.accountSwitchReason = String(failed.accountSwitchReason || "");
      diagnostic.accountSwitchCount = Math.max(0, Number(failed.accountSwitchCount || 0));
      diagnostic.accountSwitchHistory = Array.isArray(failed.accountSwitchHistory) ? failed.accountSwitchHistory : [];
      diagnostic.restrictedAccounts = Array.isArray(failed.restrictedAccounts) ? failed.restrictedAccounts : [];
      diagnostic.savedAccountCount = Math.max(0, Number(failed.savedAccountCount || 0));
      diagnostic.savedAccounts = Array.isArray(failed.savedAccounts) ? failed.savedAccounts : [];
      diagnostic.accountIdentityVerified = failed.accountIdentityVerified === true;
      const runnerError = new Error(diagnostic.message);
      runnerError.code = diagnostic.code;
      runnerError.diagnostic = diagnostic;
      throw runnerError;
    }
    const parsed = parseAirtestRunnerOutput(output);
    await replayAirtestEvents(task, parsed.log || []);
    if (!parsed.ok) throw new Error(parsed.error || "支付宝查名字流程失败");
    const result = buildResult(
      parsed,
      accountSwitchRequested || parsed.accountSwitched ? "xml_uiautomator_account_switch" : "xml_uiautomator_fallback"
    );
    if (operation === "stop") markAutomationReadyOnDemand(task.adbSerial, "lookup_session_stopped");
    return result;
  } finally {
    await fs.unlink(payloadPath).catch(() => {});
  }
}

async function assertAdbDeviceOnline(serial) {
  const devices = await scanAdbDevices();
  const device = devices.find((item) => item.adbSerial === serial);
  if (!device) throw new Error(`ADB 设备未连接：${serial}`);
  if (device.state !== "device") throw new Error(`ADB 设备不可控：${serial} 当前状态 ${device.state}`);
  return device;
}

async function assertAdbDeviceOnlineFast(serial, options = {}) {
  const adbSerial = String(serial || "").trim();
  if (!adbSerial) throw new Error("缺少 ADB 序列号");
  const cached = lastDevices.find((item) => item.adbSerial === adbSerial);
  const cacheAgeMs = Date.now() - Number(lastDevicesScannedAt || 0);
  if (cached?.state === "device" && cacheAgeMs >= 0 && cacheAgeMs <= 5_000) {
    return { ...cached, onlineCheck: { method: "fresh_scan_cache", cacheAgeMs } };
  }
  const state = await adb(adbSerial, ["get-state"], {
    timeoutMs: 5_000,
    signal: options.signal,
    allowScreenControl: options.allowScreenControl === true
  })
    .then((value) => String(value || "").trim())
    .catch((error) => {
      throw new Error(`ADB 设备未连接：${adbSerial} ${error.message}`);
    });
  if (state !== "device") throw new Error(`ADB 设备不可控：${adbSerial} 当前状态 ${state}`);
  if (cached) return { ...cached, onlineCheck: { method: "adb_get_state", cacheAgeMs } };
  return {
    adbSerial,
    serial: adbSerial,
    deviceId: `adb:${adbSerial}`,
    state: "device",
    onlineCheck: { method: "adb_get_state" }
  };
}


async function runXhsAirtestPocoWorkflow(task, qr) {
  const script = config.airtestRunnerPath;
  if (!(await fileExists(script))) throw new Error(`Airtest/Poco 执行器不存在：${script}`);
  const workflow = task.payload?.workflowScript || {};
  const launchActivity = await resolveLaunchActivity(task.adbSerial, config.xhsPackageName, "0").catch(() => "");
  const payload = {
    serial: task.adbSerial,
    adbPath: config.adbPath,
    xhsPackageName: config.xhsPackageName,
    xhsAppSlot: task.payload?.xhsAppSlot === "app2" ? "app2" : "app1",
    confirmWaitMs: Number(workflow.confirmWaitMs ?? 10000),
    loginConfirmKeywords: Array.isArray(workflow.loginConfirmKeywords) ? workflow.loginConfirmKeywords : [],
    ordinaryConfirmButtons: Array.isArray(workflow.ordinaryConfirmButtons) ? workflow.ordinaryConfirmButtons : [],
    platformConfirmButtons: Array.isArray(workflow.platformConfirmButtons) ? workflow.platformConfirmButtons : [],
    launchActivity,
    qrRemotePath: qr.remotePath,
    taskId: task.taskId
  };
  taskEvent(task, "airtest", "info", "启动 Airtest/Poco 执行器", {
    runner: script,
    xhsAppSlot: payload.xhsAppSlot,
    confirmWaitMs: payload.confirmWaitMs
  }).catch((error) => log("airtest start event failed", { taskId: task.taskId, error: error.message }));
  try {
    const parsed = await runXhsAirtestPocoWorker(payload, {
      timeoutMs: Math.max(Number(task.payload?.workflowScript?.timeoutMs || 0), config.xhsTaskTimeoutSeconds * 1000, 180_000),
      onEvent: (event) => replayAirtestEvents(task, [event])
    });
    const streamedReplayCount = Number(parsed.streamedReplayCount || 0);
    if (!parsed.ok) {
      if (!streamedReplayCount) await replayAirtestEvents(task, parsed.log || []);
      throw new Error(parsed.error || "Airtest/Poco 执行失败");
    }
    const finishEvent = () => taskEvent(task, "login-confirm", "info", "确认登录点击完成，任务到达自动化终点", { driver: "airtest_poco" });
    if (streamedReplayCount) {
      finishEvent().catch((error) => log("airtest success event failed", { taskId: task.taskId, error: error.message }));
    } else {
      replayAirtestEvents(task, parsed.log || [])
        .then(finishEvent)
        .catch((error) => log("airtest success event replay failed", { taskId: task.taskId, error: error.message }));
    }
    return parsed;
  } catch (error) {
    const parsed = parseAirtestRunnerOutput(error.message || "");
    if (parsed.log?.length) await replayAirtestEvents(task, parsed.log);
    throw new Error(parsed.error || error.message);
  }
}

async function ensureXmlUiAutomatorReady(serial) {
  // UIAutomator and PocoService must never own one device together.  Stop a
  // resident Poco worker first so it removes its forwards gracefully, then
  // force-stop only PocoService (not ADB or the screen relay).
  const stopped = await stopAirtestWorker(serial, "xml_uiautomator");
  if (!stopped) throw new Error(`Poco worker 未能释放 XML 驱动设备：${serial}`);
  await adb(serial, ["shell", "am", "force-stop", "com.netease.open.pocoservice"], { timeoutMs: 8_000 });
  const now = Date.now();
  const cached = automationPreflightBySerial.get(serial) || {};
  automationPreflightBySerial.set(serial, {
    ...cached,
    serial,
    ok: true,
    status: "xml_uiautomator_ready",
    checkedAt: new Date(now).toISOString(),
    checkedAtMs: now,
    airtestReady: false,
    pocoReady: false,
    helpersReady: false,
    repairAction: "xml_driver_selected",
    lastError: ""
  });
}

async function runXhsXmlUiAutomatorWorkflow(task, qr) {
  const script = config.xmlUiAutomatorRunnerPath;
  if (!(await fileExists(script))) throw new Error(`XML UIAutomator 执行器不存在：${script}`);
  const workflow = task.payload?.workflowScript || {};
  const launchActivity = await resolveLaunchActivity(task.adbSerial, config.xhsPackageName, "0").catch(() => "");
  const payload = {
    serial: task.adbSerial,
    adbPath: config.adbPath,
    xhsPackageName: config.xhsPackageName,
    xhsAppSlot: task.payload?.xhsAppSlot === "app2" ? "app2" : "app1",
    confirmWaitMs: Number(workflow.confirmWaitMs ?? 10000),
    loginConfirmKeywords: Array.isArray(workflow.loginConfirmKeywords) ? workflow.loginConfirmKeywords : [],
    ordinaryConfirmButtons: Array.isArray(workflow.ordinaryConfirmButtons) ? workflow.ordinaryConfirmButtons : [],
    platformConfirmButtons: Array.isArray(workflow.platformConfirmButtons) ? workflow.platformConfirmButtons : [],
    launchActivity,
    qrRemotePath: qr.remotePath,
    taskId: task.taskId,
    targetRunMs: 60_000,
    maxRunMs: 90_000
  };
  const payloadPath = path.join(cacheDir, "xhs-qr", safeFileName(`xml-uiautomator-${task.taskId}.json`));
  await fs.mkdir(path.dirname(payloadPath), { recursive: true });
  await fs.writeFile(payloadPath, JSON.stringify(payload), "utf8");
  await taskEvent(task, "xml_uiautomator", "info", "启动 XML UIAutomator 执行器", {
    runner: script,
    xhsAppSlot: payload.xhsAppSlot,
    confirmWaitMs: payload.confirmWaitMs
  });
  try {
    const output = await run(config.pythonCommand, [script, "--payload", payloadPath], {
      timeoutMs: Math.max(Number(workflow.timeoutMs || 0), config.xhsTaskTimeoutSeconds * 1000, 180_000),
      maxBuffer: 10 * 1024 * 1024,
      cwd: agentDir,
      env: airtestEnv()
    });
    const parsed = parseAirtestRunnerOutput(output);
    await replayAirtestEvents(task, parsed.log || []);
    if (!parsed.ok) throw new Error(parsed.error || "XML UIAutomator 执行失败");
    await taskEvent(task, "login-confirm", "info", "确认登录点击完成，任务到达自动化终点", { driver: "xml_uiautomator" });
    return parsed;
  } finally {
    await fs.unlink(payloadPath).catch(() => {});
  }
}

async function runXhsAirtestPocoWorker(payload, options = {}) {
  const serial = String(payload.serial || "").trim();
  let worker;
  const readyTimeoutMs = Math.max(0, Number(options.readyTimeoutMs || 0));
  if (readyTimeoutMs) {
    try {
      worker = await Promise.race([
        getAirtestWorker(serial),
        delay(readyTimeoutMs).then(() => { throw new Error(`Airtest/Poco worker 启动超时：${serial}`); })
      ]);
    } catch (error) {
      await stopAirtestWorker(serial, "ready_timeout").catch(() => {});
      throw error;
    }
  } else {
    worker = await getAirtestWorker(serial);
  }
  const maxIdleMs = Math.max(5_000, Number(options.maxIdleMs || 45_000));
  const idleMs = Date.now() - Number(worker.lastUsedAt || worker.startedAt || Date.now());
  if (idleMs >= maxIdleMs) {
    log("recycling idle Airtest/Poco worker before task", { serial, idleMs, maxIdleMs });
    worker = await recycleAirtestWorker(serial, "idle_before_task");
  }
  try {
    await probeAirtestWorker(worker);
  } catch (error) {
    log("Airtest/Poco worker probe failed; rebuilding before task", {
      serial,
      error: error.message || String(error)
    });
    worker = await recycleAirtestWorker(serial, "poco_probe_failed");
    await probeAirtestWorker(worker);
  }
  const timeoutMs = options.timeoutMs || 180_000;
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request = { ...payload, requestId };
  const result = await worker.enqueue(request, timeoutMs, options.onEvent);
  worker.lastUsedAt = Date.now();
  return result;
}

async function probeAirtestWorker(worker) {
  const requestId = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await worker.enqueue({
    operation: "poco_probe",
    requestId,
    serial: worker.serial,
    adbPath: config.adbPath
  }, 8_000);
  if (!result?.ok || result.operation !== "poco_probe" || result.selectorResponded !== true) {
    throw new Error(`Airtest/Poco worker 探活未通过：${worker.serial}`);
  }
  worker.lastUsedAt = Date.now();
  log("Airtest/Poco worker probe passed", {
    serial: worker.serial,
    elapsedMs: Number(result.elapsedMs || 0),
    selectorExists: Boolean(result.selectorExists)
  });
}

async function recycleAirtestWorker(serial, reason) {
  const existing = airtestWorkersBySerial.get(serial);
  if (existing) {
    await stopAirtestWorker(serial, reason);
    const exited = await waitForWorkerExit(existing, 8_000);
    if (!exited) throw new Error(`Airtest/Poco worker 未能停止：${serial}`);
  }
  return getAirtestWorker(serial);
}

function hasActiveAirtestLookupWarmLease(serial, now = Date.now()) {
  return Number(airtestLookupWarmUntilBySerial.get(String(serial || "").trim()) || 0) > now;
}

function touchAirtestLookupWarmLease(serial, reason = "lookup_activity") {
  const key = String(serial || "").trim();
  if (!key) return;
  const warmUntil = Date.now() + config.airtestLookupWarmSeconds * 1_000;
  airtestLookupWarmUntilBySerial.set(key, warmUntil);
  log("airtest lookup warm lease renewed", {
    serial: key,
    reason,
    warmUntil: new Date(warmUntil).toISOString()
  });
}

function clearAirtestLookupWarmLease(serial, reason = "lookup_inactive") {
  const key = String(serial || "").trim();
  if (!key) return;
  const removed = airtestLookupWarmUntilBySerial.delete(key);
  if (removed) log("airtest lookup warm lease cleared", { serial: key, reason });
}

function markAutomationReadyOnDemand(serial, reason = "worker_not_resident") {
  const key = String(serial || "").trim();
  if (!key) return;
  const cached = automationPreflightBySerial.get(key) || {};
  automationPreflightBySerial.set(key, {
    ...cached,
    serial: key,
    ok: Boolean(cached.ok || cached.airtestReady),
    status: "ready_on_demand",
    checkedAt: cached.checkedAt || new Date().toISOString(),
    checkedAtMs: Number(cached.checkedAtMs || Date.now()),
    airtestReady: Boolean(cached.airtestReady || cached.ok),
    pocoReady: false,
    helpersReady: Boolean(cached.helpersReady || cached.ok || cached.airtestReady),
    repairAction: "",
    lastError: "自动化组件已就绪，任务开始时按需启动 Poco worker",
    workerLifecycleReason: reason
  });
}

function withAirtestWorkerAdmission(action) {
  const result = airtestWorkerAdmissionChain.then(action, action);
  airtestWorkerAdmissionChain = result.then(() => undefined, () => undefined);
  return result;
}

function residentAirtestWorkerCount() {
  return [...airtestWorkersBySerial.values()].filter((worker) => worker && !worker.exited).length;
}

async function ensureAirtestWorkerCapacity(incomingSerial) {
  while (residentAirtestWorkerCount() >= config.airtestMaxResidentWorkers) {
    const candidate = selectAirtestWorkerEvictionCandidate({
      workers: airtestWorkersBySerial,
      incomingSerial,
      activeSerials: activeTaskSerials,
      screenControlledSerials,
      preflightSerials: automationPreflightRunning,
      warmUntilBySerial: airtestLookupWarmUntilBySerial
    });
    if (!candidate) {
      const error = new Error(`Airtest/Poco 常驻 worker 已达到上限 ${config.airtestMaxResidentWorkers}，当前均在执行任务`);
      error.code = "airtest_worker_capacity_reached";
      throw error;
    }
    log("evicting Airtest/Poco worker for resident limit", {
      serial: candidate.serial,
      incomingSerial,
      warm: candidate.warm,
      residentCount: residentAirtestWorkerCount(),
      residentLimit: config.airtestMaxResidentWorkers
    });
    const stopped = await stopAirtestWorker(candidate.serial, "resident_limit");
    if (!stopped) throw new Error(`Airtest/Poco worker 容量回收失败：${candidate.serial}`);
    markAutomationReadyOnDemand(candidate.serial, "resident_limit");
  }
}

async function cleanupIdleAirtestWorkers() {
  const now = Date.now();
  for (const [serial, warmUntil] of airtestLookupWarmUntilBySerial.entries()) {
    if (Number(warmUntil || 0) <= now) clearAirtestLookupWarmLease(serial, "warm_lease_expired");
  }
  const targets = selectIdleAirtestWorkerSerials({
    workers: airtestWorkersBySerial,
    idleMs: config.airtestWorkerIdleSeconds * 1_000,
    activeSerials: activeTaskSerials,
    screenControlledSerials,
    preflightSerials: automationPreflightRunning,
    warmUntilBySerial: airtestLookupWarmUntilBySerial,
    now
  }).slice(0, config.airtestMaxResidentWorkers);
  if (!targets.length) return 0;
  await runLimited(targets, 4, async (serial) => {
    const stopped = await stopAirtestWorker(serial, "idle_timeout");
    if (stopped) markAutomationReadyOnDemand(serial, "idle_timeout");
  });
  log("idle Airtest/Poco workers recycled", {
    stopped: targets.length,
    residentCount: residentAirtestWorkerCount(),
    idleSeconds: config.airtestWorkerIdleSeconds
  });
  return targets.length;
}

async function stopAllAirtestWorkers(reason = "agent_shutdown") {
  const serials = [...airtestWorkersBySerial.keys()];
  if (!serials.length) return 0;
  await runLimited(serials, 4, (serial) => stopAirtestWorker(serial, reason));
  return serials.length;
}

async function getAirtestWorker(serial) {
  const key = String(serial || "").trim();
  if (!key) throw new Error("缺少 ADB 序列号，无法启动 Airtest/Poco worker");
  const existing = airtestWorkersBySerial.get(key);
  if (existing && !existing.exited && !existing.stopping) return existing.readyPromise.then(() => existing);
  const worker = await withAirtestWorkerAdmission(async () => {
    const current = airtestWorkersBySerial.get(key);
    if (current && !current.exited && !current.stopping) return current;
    if (current?.stopping && !current.exited) {
      const exited = await waitForWorkerExit(current, 10_000);
      if (!exited) throw new Error(`Airtest/Poco worker 正在停止但未退出：${key}`);
    }
    await ensureAirtestWorkerCapacity(key);
    const created = createAirtestWorker(key);
    airtestWorkersBySerial.set(key, created);
    log("Airtest/Poco worker admitted", {
      serial: key,
      residentCount: residentAirtestWorkerCount(),
      residentLimit: config.airtestMaxResidentWorkers
    });
    return created;
  });
  return worker.readyPromise.then(() => worker);
}

function createAirtestWorker(serial) {
  const child = spawn(config.pythonCommand, [
    config.airtestRunnerPath,
    "--mode", "worker",
    "--serial", serial,
    "--adb-path", config.adbPath
  ], {
    cwd: agentDir,
    env: airtestEnv(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const worker = {
    serial,
    child,
    exited: false,
    stopping: false,
    stopPromise: null,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    queue: Promise.resolve(),
    pending: null,
    stdoutBuffer: "",
    stderrBuffer: "",
    readyResolve: null,
    readyReject: null,
    readyPromise: null,
    enqueue(payload, timeoutMs, onEvent = null) {
      this.queue = this.queue.then(() => sendAirtestWorkerPayload(this, payload, timeoutMs, onEvent));
      return this.queue;
    }
  };
  worker.readyPromise = new Promise((resolve, reject) => {
    worker.readyResolve = resolve;
    worker.readyReject = reject;
  });
  const readyTimer = setTimeout(() => {
    if (worker.readyReject) worker.readyReject(new Error(`Airtest/Poco worker 启动超时：${serial}`));
    stopAirtestWorker(serial, "ready_timeout").catch(() => {});
  }, 150_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    worker.stdoutBuffer += chunk;
    let index;
    while ((index = worker.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = worker.stdoutBuffer.slice(0, index).trim();
      worker.stdoutBuffer = worker.stdoutBuffer.slice(index + 1);
      if (line) handleAirtestWorkerLine(worker, line, readyTimer);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    worker.stderrBuffer = `${worker.stderrBuffer}${chunk}`.slice(-8000);
  });
  child.on("exit", (code, signal) => {
    worker.exited = true;
    if (airtestWorkersBySerial.get(serial) === worker) airtestWorkersBySerial.delete(serial);
    clearTimeout(readyTimer);
    const error = new Error(`Airtest/Poco worker 已退出：${serial} code=${code ?? ""} signal=${signal ?? ""} ${worker.stderrBuffer}`.trim());
    if (worker.readyReject) worker.readyReject(error);
    if (worker.pending) {
      worker.pending.reject(error);
      worker.pending = null;
    }
  });
  child.on("error", (error) => {
    worker.exited = true;
    if (airtestWorkersBySerial.get(serial) === worker) airtestWorkersBySerial.delete(serial);
    clearTimeout(readyTimer);
    if (worker.readyReject) worker.readyReject(error);
    if (worker.pending) {
      worker.pending.reject(error);
      worker.pending = null;
    }
  });
  return worker;
}

function handleAirtestWorkerLine(worker, line, readyTimer) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    worker.stderrBuffer = `${worker.stderrBuffer}\n${line}`.slice(-8000);
    return;
  }
  if (parsed.workerReady) {
    clearTimeout(readyTimer);
    const resolve = worker.readyResolve;
    worker.readyResolve = null;
    worker.readyReject = null;
    if (resolve) resolve(parsed);
    return;
  }
  if (parsed.event) {
    // Persist every streamed worker event locally. The task timeline only
    // keeps user-facing milestones, but diagnostics must survive a worker
    // timeout so a stalled Poco call can be identified precisely.
    log("airtest worker event", { serial: worker.serial, ...parsed.event });
    if (worker.pending) {
      const pending = worker.pending;
      pending.streamedEventCount = Number(pending.streamedEventCount || 0) + 1;
      if (typeof pending.onEvent === "function") {
        const eventPromise = Promise.resolve(pending.onEvent(parsed.event))
          .then((count) => {
            pending.streamedReplayCount = Number(pending.streamedReplayCount || 0) + Number(count || 0);
          })
          .catch((error) => log("airtest stream event replay failed", { serial: worker.serial, error: error.message }));
        pending.eventPromises.push(eventPromise);
      }
    }
    return;
  }
  if (parsed.result && worker.pending) {
    const pending = worker.pending;
    worker.pending = null;
    clearTimeout(pending.timer);
    Promise.allSettled(pending.eventPromises || []).then(() => {
      pending.resolve({
        ...parsed.result,
        streamedEventCount: Number(pending.streamedEventCount || 0),
        streamedReplayCount: Number(pending.streamedReplayCount || 0)
      });
    });
  }
}

function sendAirtestWorkerPayload(worker, payload, timeoutMs, onEvent = null) {
  if (worker.exited) throw new Error(`Airtest/Poco worker 不在线：${worker.serial}`);
  if (worker.pending) throw new Error(`Airtest/Poco worker 正忙：${worker.serial}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (worker.pending) worker.pending = null;
      stopAirtestWorker(worker.serial, "task_timeout").catch(() => {});
      reject(new Error(`Airtest/Poco worker 执行超时：${worker.serial}`));
    }, timeoutMs);
    worker.pending = { resolve, reject, timer, onEvent, streamedEventCount: 0, streamedReplayCount: 0, eventPromises: [] };
    worker.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
      if (!error) return;
      clearTimeout(timer);
      if (worker.pending) worker.pending = null;
      reject(error);
    });
  });
}

async function stopAirtestWorker(serial, reason = "stop") {
  const worker = airtestWorkersBySerial.get(serial);
  if (!worker) return true;
  const screenPriority = reason === "screen_control" || reason === "xml_uiautomator";
  const startedAt = Date.now();
  const result = await stopWorkerWithFallback(worker, {
    gracefulTimeoutMs: screenPriority ? 5_000 : 300,
    forcedTimeoutMs: 2_000,
    requestStop() {
      worker.child.stdin.write("__exit__\n");
    },
    async forceStop() {
      log("forcing stuck airtest worker to stop", {
        serial,
        reason,
        pid: worker.child.pid,
        stderrTail: cleanLogText(worker.stderrBuffer || "").slice(-1200)
      });
      try { worker.child.kill(); } catch {}
      await cleanupAirtestDeviceAfterForcedStop(serial).catch((error) => {
        log("forced airtest cleanup failed", { serial, reason, error: error.message || String(error) });
      });
    }
  });
  if (screenPriority && result.exited && !result.forced) {
    await cleanupAirtestForwardsAfterStop(serial).catch((error) => {
      log("airtest forward cleanup failed", { serial, reason, error: error.message || String(error) });
    });
  }
  log("airtest worker stop completed", {
    serial,
    exited: result.exited,
    forced: result.forced,
    reason,
    elapsedMs: Date.now() - startedAt
  });
  return result.exited;
}

async function cleanupAirtestDeviceAfterForcedStop(serial) {
  await run(config.adbPath, ["-s", serial, "shell", "am", "force-stop", "com.netease.open.pocoservice"], {
    timeoutMs: 3_000
  }).catch(() => {});
  const forwardList = await run(config.adbPath, ["forward", "--list"], { timeoutMs: 3_000 }).catch(() => "");
  const removedForwards = await cleanupAirtestForwardsAfterStop(serial, forwardList);
  log("forced airtest device cleanup completed", { serial, removedForwards });
}

async function cleanupAirtestForwardsAfterStop(serial, knownForwardList = null) {
  const forwardList = knownForwardList === null
    ? await run(config.adbPath, ["forward", "--list"], { timeoutMs: 3_000 }).catch(() => "")
    : knownForwardList;
  const locals = pocoForwardLocals(forwardList, serial);
  await runLimited(locals, 2, (local) => run(
    config.adbPath,
    ["-s", serial, "forward", "--remove", local],
    { timeoutMs: 2_000 }
  ).catch(() => {}));
  log("airtest forward cleanup completed", { serial, removedForwards: locals.length });
  return locals.length;
}

async function pauseAutomationForScreenControl(serial) {
  const stopped = await stopAirtestWorker(serial, "screen_control");
  if (!stopped) {
    const error = new Error(`等待手机自动化组件释放超时：${serial}`);
    error.code = "screen_automation_shutdown_timeout";
    throw error;
  }
  await assertSerialAdbHealthy({ serial, adb });
  const cached = automationPreflightBySerial.get(serial) || {};
  automationPreflightBySerial.set(serial, {
    ...cached,
    serial,
    ok: false,
    status: "screen_control",
    checkedAt: new Date().toISOString(),
    checkedAtMs: Date.now(),
    airtestReady: true,
    pocoReady: false,
    helpersReady: false,
    repairAction: "paused_for_screen_control",
    lastError: "实时投屏期间已暂停 Poco worker"
  });
  log("automation paused for screen control", { serial });
}

async function resumeAutomationAfterScreenControl(serial) {
  const device = lastDevices.find((item) => item.adbSerial === serial);
  if (!device || device.state !== "device") {
    log("automation resume skipped for offline device", { serial });
    return;
  }
  if (!hasActiveAirtestLookupWarmLease(serial)) {
    markAutomationReadyOnDemand(serial, "screen_control_ended");
    log("automation resume skipped because no lookup session needs a warm worker", { serial });
    return;
  }
  const cached = automationPreflightBySerial.get(serial) || {};
  automationPreflightBySerial.set(serial, {
    ...cached,
    serial,
    ok: false,
    status: "preparing",
    checkedAt: new Date().toISOString(),
    checkedAtMs: Date.now(),
    pocoReady: false,
    helpersReady: false,
    repairAction: "resuming_after_screen_control",
    lastError: "正在恢复常驻自动化 worker"
  });
  try {
    await getAirtestWorker(serial);
    const now = Date.now();
    automationPreflightBySerial.set(serial, {
      ...cached,
      serial,
      ok: true,
      status: "ready",
      checkedAt: new Date(now).toISOString(),
      checkedAtMs: now,
      airtestReady: true,
      pocoReady: true,
      helpersReady: true,
      repairAction: "",
      lastError: ""
    });
    log("automation resumed for active lookup session after screen control", { serial });
  } catch (error) {
    automationPreflightBySerial.set(serial, {
      ...cached,
      serial,
      ok: false,
      status: "failed",
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now(),
      pocoReady: false,
      helpersReady: false,
      repairAction: "resume_failed",
      lastError: error.message
    });
    throw error;
  }
}

async function replayAirtestEvents(task, events = []) {
  const map = {
    poco_ready: ["airtest", "info", "Poco 服务已就绪"],
    poco_reused: ["airtest", "info", "复用已预热 Poco worker"],
    start_xhs: ["app", "info", "重启小红书"],
    choose_slot_by_index: ["picker", "info", "选择系统双开应用入口"],
    choose_slot_card_by_index: ["picker", "info", "选择系统双开应用入口"],
    after_choose_slot: ["app", "info", "小红书已进入前台"],
    click_me_by_desc: ["step", "info", "进入我的页面"],
    click_me_by_text: ["step", "info", "进入我的页面"],
    click_scan_by_desc: ["step", "info", "打开扫一扫"],
    click_album_by_text: ["step", "info", "打开相册"],
    click_album_by_desc: ["step", "info", "打开相册"],
    album_candidates: ["album", "info", "定位相册图片列表"],
    after_select_image: ["step", "info", "选择二维码图片"],
    confirm_visible: ["login-confirm", "info", "登录确认页断言成功"],
    confirm_wait: ["login-confirm", "info", "登录确认页断言成功，等待后点击确认登录"],
    click_confirm_确认登录: ["login-confirm", "info", "点击确认登录"],
    click_confirm_contains: ["login-confirm", "info", "点击确认登录"],
    done: ["finish", "info", "Airtest/Poco 小红书扫码完成"],
    launch_alipay: ["alipay", "info", "正在打开支付宝"],
    open_search: ["alipay", "info", "正在进入支付宝搜索页"],
    clear_previous_query: ["alipay", "info", "正在清空上一次号码"],
    input_phone: ["alipay", "info", "号码已输入，正在搜索"],
    submit_search: ["alipay", "info", "已确认搜索，正在等待结果"],
    retry_search_result: ["alipay", "info", "结果暂未返回，正在重新提交一次"],
    lookup_no_name_result: ["alipay", "info", "该号码未查询到姓名结果"],
    alipay_access_denied_detected: ["alipay", "warn", "检测到支付宝访问被拒绝"],
    alipay_account_restriction_detected: ["alipay", "warn", "检测到支付宝账号或设备限制"],
    account_switch_triggered: ["alipay", "warn", "正在切换支付宝账号并重试当前号码"],
    alipay_access_denied_after_account_switch: ["alipay", "error", "切换账号后仍被支付宝拒绝访问"],
    alipay_account_restricted_after_account_switch: ["alipay", "error", "切换账号后仍触发支付宝限制"],
    alipay_all_saved_accounts_restricted: ["alipay", "error", "全部已保存支付宝账号均触发查询限制"],
    account_restriction_dismissed_for_switch: ["alipay", "info", "已退出限制页，正在进入账号设置"],
    human_verification_detected: ["alipay", "warn", "检测到支付宝滑动验证，正在自动处理"],
    human_verification_slider_drag: ["alipay", "info", "正在按元素轨道拖动验证滑块"],
    human_verification_retry: ["alipay", "warn", "滑块验证未通过，正在重试"],
    human_verification_passed: ["alipay", "info", "滑块验证已通过"],
    human_verification_failed: ["alipay", "error", "滑块自动验证未通过"],
    resume_query_after_human_verification: ["alipay", "info", "验证通过，正在恢复当前查询结果"],
    open_my_tab: ["alipay", "info", "正在进入支付宝账号设置"],
    open_settings: ["alipay", "info", "正在打开支付宝设置"],
    open_saved_account_picker: ["alipay", "info", "正在打开已保存账号列表"],
    reuse_open_account_picker: ["alipay", "info", "已复用当前账号选择页"],
    reuse_open_account_picker_failed: ["alipay", "warn", "账号选择页已变化，正在重新读取"],
    account_selected: ["alipay", "info", "已选择用户指定的支付宝账号"],
    account_selection_returned_home: ["alipay", "info", "账号切换已返回首页"],
    account_switch_verified: ["alipay", "info", "支付宝账号切换验证成功"],
    query_full_path_recovery: ["alipay", "warn", "页面状态异常，正在自动恢复"],
    masked_real_name_tail_extracted: ["alipay", "info", "已识别结果，正在返回"],
    lookup_session_stopped: ["alipay", "info", "查询会话已停止"],
    reuse_existing_search_page: ["alipay", "info", "已复用支付宝搜索页"],
    error: ["airtest", "error", "Airtest/Poco 执行失败"]
  };
  let index = 0;
  let replayed = 0;
  for (const event of events) {
    const step = String(event.step || "");
    if (!shouldReplayAirtestEvent(step, event)) continue;
    const fallback = step.startsWith("choose_slot_text_")
      ? ["picker", "info", "选择系统双开应用入口"]
      : step.startsWith("click_confirm_")
        ? ["login-confirm", "info", "点击确认登录"]
        : ["airtest", event.error ? "error" : "info", step || "Airtest/Poco 步骤"];
    const [phase, level, message] = map[step] || fallback;
    try {
      await taskEvent(task, phase, level, message, {
        ...event,
        driver: "airtest_poco",
        stepId: step,
        stepIndex: index++
      });
      replayed += 1;
    } catch {}
  }
  return replayed;
}

function shouldReplayAirtestEvent(step, event = {}) {
  if (event.error || step === "error") return true;
  if (step.startsWith("choose_slot_text_")) return Boolean(event.hit);
  if (step.startsWith("click_confirm_")) return Boolean(event.hit) || step === "click_confirm_contains";
  if (step.startsWith("click_me_") || step.startsWith("click_scan_") || step.startsWith("click_album_")) return Boolean(event.hit);
  return new Set([
    "poco_ready",
    "poco_reused",
    "start_xhs",
    "post_start_foreground_check_begin",
    "post_start_foreground_check_end",
    "choose_slot_decision_begin",
    "choose_slot_call_begin",
    "choose_slot_begin",
    "choose_slot_focus",
    "choose_slot_text_probe_begin",
    "choose_slot_text_probe_end",
    "choose_slot_not_found",
    "after_select_image",
    "confirm_visible",
    "confirm_wait",
    "launch_alipay",
    "open_search",
    "clear_previous_query",
    "input_phone",
    "submit_search",
    "retry_search_result",
    "lookup_no_name_result",
    "alipay_access_denied_detected",
    "alipay_account_restriction_detected",
    "account_switch_triggered",
    "alipay_access_denied_after_account_switch",
    "alipay_account_restricted_after_account_switch",
    "alipay_all_saved_accounts_restricted",
    "account_restriction_dismissed_for_switch",
    "human_verification_detected",
    "human_verification_slider_drag",
    "human_verification_retry",
    "human_verification_passed",
    "human_verification_failed",
    "resume_query_after_human_verification",
    "open_my_tab",
    "open_settings",
    "open_saved_account_picker",
    "reuse_open_account_picker",
    "reuse_open_account_picker_failed",
    "account_selected",
    "account_selection_returned_home",
    "account_switch_verified",
    "query_full_path_recovery",
    "masked_real_name_tail_extracted",
    "lookup_session_stopped",
    "reuse_existing_search_page",
    "done"
  ]).has(step);
}

function parseAirtestRunnerOutput(output = "") {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed.result) return parsed.result;
      if (parsed.ok !== undefined) return parsed;
    } catch {}
  }
  return { ok: false, error: cleanLogText(output).slice(0, 1000), log: [] };
}

function airtestEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    ADB: config.adbPath
  };
}

async function checkAirtestStatus() {
  if (!config.airtestEnabled) return { ok: false, error: "airtest_disabled" };
  try {
    await run(config.pythonCommand, ["-c", "import airtest, poco; print('ok')"], {
      timeoutMs: 10_000,
      env: airtestEnv()
    });
    return { ok: true, error: "" };
  } catch (error) {
    if (!config.autoInstallAirtest) return { ok: false, error: error.message };
    return { ok: false, error: error.message };
  }
}

async function ensureAirtestReady(task = null) {
  const current = await checkAirtestStatus();
  if (current.ok) return current;
  if (!config.autoInstallAirtest) throw new Error(`Airtest/Poco 不可用：${current.error}`);
  if (task) await taskEvent(task, "airtest", "warn", "Airtest/Poco 未安装，正在通过 pip 安装", {
    pythonCommand: config.pythonCommand,
    packages: config.airtestPackages
  });
  await run(config.pythonCommand, ["-m", "pip", "install", ...config.airtestPackages], {
    timeoutMs: 180_000,
    maxBuffer: 10 * 1024 * 1024,
    env: airtestEnv()
  });
  const next = await checkAirtestStatus();
  if (!next.ok) throw new Error(`Airtest/Poco 安装后仍不可用：${next.error}`);
  return next;
}

async function airtestDeviceHelpers(serial) {
  const packages = await adb(serial, ["shell", "pm", "list", "packages"], { timeoutMs: 20_000 }).catch(() => "");
  return {
    pocoReady: String(packages).includes("com.netease.open.pocoservice"),
    yosemiteReady: String(packages).includes("com.netease.nie.yosemite")
  };
}

async function prewarmAirtestPoco(serial, task = null) {
  const script = config.airtestRunnerPath;
  if (!(await fileExists(script))) throw new Error(`Airtest/Poco 执行器不存在：${script}`);
  const payloadPath = path.join(cacheDir, "xhs-qr", safeFileName(`airtest-preflight-${serial}.json`));
  await fs.mkdir(path.dirname(payloadPath), { recursive: true });
  await fs.writeFile(payloadPath, JSON.stringify({ serial, adbPath: config.adbPath }, null, 2), "utf8");
  try {
    const output = await run(config.pythonCommand, [script, "--mode", "preflight", "--payload", payloadPath], {
      timeoutMs: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: agentDir,
      env: airtestEnv()
    });
    const parsed = parseAirtestRunnerOutput(output);
    if (task) await replayAirtestEvents(task, parsed.log || []);
    if (!parsed.ok) throw new Error(parsed.error || "Airtest/Poco 预热失败");
    return parsed;
  } finally {
    await fs.unlink(payloadPath).catch(() => {});
  }
}


async function prepareQrImage(task) {
  const timings = {};
  const totalStartedAt = Date.now();
  const dataUrl = String(task.payload?.qrImageDataUrl || "");
  const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error("扫码任务缺少有效二维码图片");
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length) throw new Error("二维码图片为空");
  const dir = path.join(cacheDir, "xhs-qr");
  await fs.mkdir(dir, { recursive: true });
  const fileName = safeFileName(`xhs-${task.taskId}.${ext}`);
  const localPath = path.join(dir, fileName);
  const remoteDir = "/sdcard/Pictures/PhoneCloud";
  const remotePath = `${remoteDir}/${fileName}`;
  const writeStartedAt = Date.now();
  await fs.writeFile(localPath, bytes);
  timings.writeMs = Date.now() - writeStartedAt;
  if (!qrRemoteDirReadyBySerial.has(task.adbSerial)) {
    const mkdirStartedAt = Date.now();
    await adb(task.adbSerial, ["shell", "mkdir", "-p", remoteDir], { timeoutMs: 8_000 });
    timings.mkdirMs = Date.now() - mkdirStartedAt;
    qrRemoteDirReadyBySerial.add(task.adbSerial);
  } else {
    timings.mkdirMs = 0;
    timings.mkdirCached = true;
  }
  const pushStartedAt = Date.now();
  await adb(task.adbSerial, ["push", localPath, remotePath], { timeoutMs: 60_000 });
  timings.pushMs = Date.now() - pushStartedAt;
  const scanStartedAt = Date.now();
  const scan = await scanMediaFile(task.adbSerial, remotePath);
  timings.scanMs = Date.now() - scanStartedAt;
  timings.totalMs = Date.now() - totalStartedAt;
  taskEvent(task, "qr", "info", "二维码已推送到手机相册", {
    remotePath,
    bytes: bytes.length,
    scan,
    timings
  }).catch((error) => log("qr event failed", { taskId: task.taskId, error: error.message }));
  return { localPath, remotePath, timings, scan };
}

async function preparePublishImages(task) {
  const values = Array.isArray(task.payload?.imageDataUrls) ? task.payload.imageDataUrls : [];
  if (!values.length) throw new Error("发布任务缺少图片");
  const dir = path.join(cacheDir, "xhs-publish");
  const remoteDir = "/sdcard/Pictures/PhoneCloud";
  await fs.mkdir(dir, { recursive: true });
  await adb(task.adbSerial, ["shell", "mkdir", "-p", remoteDir], { timeoutMs: 8_000 });
  const prepared = new Array(values.length);
  try {
    // XHS sorts the gallery newest-first. Import in reverse so the first image
    // submitted by the user is the newest thumbnail and remains the cover.
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const match = String(values[index] || "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
      if (!match) throw new Error(`发布图片 ${index + 1} 格式无效`);
      const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
      const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      if (!bytes.length) throw new Error(`发布图片 ${index + 1} 为空`);
      const fileName = safeFileName(`publish-${Date.now()}-${task.taskId}-${String(index + 1).padStart(2, "0")}.${ext}`);
      const localPath = path.join(dir, fileName);
      const remotePath = `${remoteDir}/${fileName}`;
      await fs.writeFile(localPath, bytes);
      await adb(task.adbSerial, ["push", localPath, remotePath], { timeoutMs: 60_000 });
      const scan = await scanMediaFile(task.adbSerial, remotePath);
      prepared[index] = { localPath, remotePath, bytes: bytes.length, scan };
    }
    await taskEvent(task, "xhs_publish_images", "info", "发布图片已全部导入手机图库", {
      imageCount: prepared.length,
      remotePaths: prepared.map((item) => item.remotePath)
    });
    return prepared;
  } catch (error) {
    await Promise.all(prepared.filter(Boolean).map((item) => fs.unlink(item.localPath).catch(() => {})));
    throw error;
  }
}

async function scanMediaFile(serial, remotePath, options = {}) {
  try {
    const output = await adb(serial, ["shell", "cmd", "media", "scan-file", remotePath], {
      timeoutMs: 8_000,
      allowScreenControl: options.allowScreenControl === true
    });
    return { method: "cmd_media_scan_file", output };
  } catch (cmdError) {
    const output = await adb(serial, ["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${remotePath}`], {
      timeoutMs: 8_000,
      allowScreenControl: options.allowScreenControl === true
    }).catch((broadcastError) => {
      return `broadcast_failed: ${broadcastError?.message || String(broadcastError)}`;
    });
    return {
      method: "media_scanner_broadcast",
      output,
      fallbackFrom: cmdError?.message || String(cmdError)
    };
  }
}

async function resolveLaunchActivity(serial, packageName, userId = "0") {
  const output = await adb(serial, ["shell", "cmd", "package", "resolve-activity", "--brief", "--user", String(userId || "0"), packageName], { timeoutMs: 5000 }).catch(() => "");
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const component = [...lines].reverse().find((line) => line.includes("/") && !line.includes(" "));
  return component || "";
}

async function isPackageInstalled(serial, packageName) {
  if (!packageName) return false;
  try {
    // PackageManager can be busy for 10-20 seconds on heavily loaded OPPO
    // devices. A 5-second timeout was incorrectly reported as "not installed"
    // even though the same command later returned the APK path. An actual
    // missing package returns promptly with no package: line; only transport
    // or timeout failures use the independent cmd-package fallback.
    const output = await adb(serial, ["shell", "pm", "path", packageName], { timeoutMs: 25_000 });
    return /^package:/m.test(output);
  } catch (firstError) {
    try {
      const fallback = await adb(serial, ["shell", "cmd", "package", "path", packageName], { timeoutMs: 12_000 });
      return /^package:/m.test(fallback);
    } catch (fallbackError) {
      throw new Error(`package_manager_unresponsive:${serial}:${fallbackError?.message || firstError?.message || "unknown"}`);
    }
  }
}

async function prepareAdbInstallPolicy(serial) {
  const commands = [
    ["shell", "settings", "put", "global", "verifier_verify_adb_installs", "0"],
    ["shell", "settings", "put", "global", "package_verifier_enable", "0"],
    ["shell", "settings", "put", "secure", "install_non_market_apps", "1"]
  ];
  const results = [];
  for (const command of commands) {
    const output = await adb(serial, command, { timeoutMs: 5000 }).then((value) => ({ ok: true, output: value })).catch((error) => ({ ok: false, error: error.message }));
    results.push({ command: command.join(" "), ...output });
  }
  return results;
}

function friendlyAutomationPreflightError(error) {
  const message = cleanLogText(error?.message || error || "");
  if (/INSTALL_FAILED_ABORTED|User rejected permissions/i.test(message)) {
    return "手机系统拒绝了 ADB 自动安装 Airtest/Poco 组件。请在手机开发者选项打开“USB 安装/通过 USB 安装应用/允许通过 USB 安装”，并在弹窗中允许本电脑。";
  }
  if (/INSTALL_FAILED_USER_RESTRICTED/i.test(message)) {
    return "手机限制了通过 USB 安装应用。请在开发者选项打开 USB 安装权限后重新插拔或等待预检重试。";
  }
  return message;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureReverseForLoopbackServer(serial, serverUrl) {
  const parsed = parseUrl(serverUrl);
  if (!parsed || !isLoopbackHost(parsed.hostname)) return { required: false };
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const output = await adb(serial, ["reverse", `tcp:${port}`, `tcp:${port}`]);
  return { required: true, port: Number(port), output };
}

function compactTaskResultForEvent(result = {}) {
  const runnerLog = Array.isArray(result?.runner?.log) ? result.runner.log : [];
  const lastRunnerStep = runnerLog.length ? runnerLog[runnerLog.length - 1] : null;
  return compactEventDetail({
    action: result.action || "",
    executionMode: result.executionMode || "",
    xhsTaskId: result.xhsTaskId || "",
    qrRemotePath: result.qrRemotePath || "",
    qrTimings: result.qrTimings || null,
    preRunTimings: result.preRunTimings || null,
    durationMs: result.durationMs ?? null,
    notFound: Boolean(result.notFound),
    runnerOk: result?.runner?.ok ?? null,
    runnerEventCount: runnerLog.length,
    lastRunnerStep,
    message: result.message || "",
    errorCode: result.errorCode || result.code || "",
    diagnostic: result.diagnostic || null,
    evidence: result.evidence || null,
    screenshot: compactScreenshotForTransport(result.screenshot || null, { includeDataUrl: true, maxDataUrlBytes: 8_000_000 }),
    xmlPath: result.xmlPath || ""
  }, 12_000_000);
}

function compactEventDetail(detail = {}, maxBytes = 24_000) {
  const normalized = normalizeEvidenceForTransport(detail, { includeDataUrl: true, maxDataUrlBytes: 8_000_000 });
  let text = "";
  try {
    text = JSON.stringify(normalized);
  } catch {
    return { compacted: true, reason: "detail_not_json_serializable" };
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return normalized;
  return {
    compacted: true,
    originalBytes: Buffer.byteLength(text, "utf8"),
    action: normalized.action || "",
    executionMode: normalized.executionMode || "",
    durationMs: normalized.durationMs ?? null,
    qrTimings: normalized.qrTimings || null,
    preRunTimings: normalized.preRunTimings || null,
    runnerOk: normalized.runnerOk ?? normalized?.runner?.ok ?? null,
    runnerEventCount: normalized.runnerEventCount ?? (Array.isArray(normalized?.runner?.log) ? normalized.runner.log.length : null),
    lastRunnerStep: normalized.lastRunnerStep || (Array.isArray(normalized?.runner?.log) ? normalized.runner.log.at(-1) : null),
    message: normalized.message || "",
    errorCode: normalized.errorCode || normalized.code || "",
    screenshot: normalized.screenshot || null,
    uiSnapshot: normalized.uiSnapshot || ""
  };
}

async function taskEvent(task, phase, level, message, detail = {}) {
  const normalizedDetail = normalizeEvidenceForTransport(detail, { includeDataUrl: true, maxDataUrlBytes: 8_000_000 });
  const safeDetail = compactEventDetail(normalizedDetail, 12_000_000);
  if (!safeDetail.screenshot && normalizedDetail?.screenshot) safeDetail.screenshot = normalizedDetail.screenshot;
  if (!safeDetail.uiSnapshot && normalizedDetail?.uiSnapshot) safeDetail.uiSnapshot = String(normalizedDetail.uiSnapshot || "").slice(0, 8000);
  if (!safeDetail.uiHierarchy && normalizedDetail?.uiHierarchy) safeDetail.uiHierarchy = String(normalizedDetail.uiHierarchy || "").slice(0, 300_000);
  return await api(`/api/v1/windows-agent-tasks/${encodeURIComponent(task.taskId)}/events`, {
    method: "POST",
    body: {
      adbSerial: task.adbSerial,
      phase,
      level,
      message,
      stepId: safeDetail.stepId || "",
      stepIndex: safeDetail.stepIndex ?? null,
      errorCode: safeDetail.errorCode || safeDetail.code || "",
      packageName: safeDetail.packageName || "",
      currentActivity: safeDetail.currentActivity || "",
      uiSnapshot: safeDetail.uiSnapshot || "",
      uiHierarchy: safeDetail.uiHierarchy || "",
      screenshot: safeDetail.screenshot || null,
      detail: safeDetail
    }
  });
}

async function taskStatus(task, status, result = {}) {
  if (task.type?.startsWith("alipay_name_") && lookupStatusOutbox.isAvailable() && ["succeeded", "failed", "cancelled"].includes(status)) {
    return lookupStatusOutbox.report(task, status, compactTaskResultForStatus(result));
  }
  return await api(`/api/v1/windows-agent-tasks/${encodeURIComponent(task.taskId)}/status`, {
    method: "POST",
    body: { status, result: compactTaskResultForStatus(result), managedLookupGeneration:task.payload?.managedLookup?.generation }
  });
}

function compactTaskResultForStatus(result = {}) {
  const runnerLog = Array.isArray(result?.runner?.log) ? result.runner.log : [];
  const screenshot = result.screenshot || null;
  const compact = {
    action: String(result.action || "").slice(0, 500),
    message: String(result.message || result.error || "").slice(0, 4000),
    error: String(result.error || "").slice(0, 1000),
    errorCode: String(result.errorCode || result.code || "").slice(0, 160),
    executionMode: String(result.executionMode || "").slice(0, 80),
    xhsTaskId: String(result.xhsTaskId || "").slice(0, 120),
    qrRemotePath: String(result.qrRemotePath || "").slice(0, 500),
    packageName: String(result.packageName || "").slice(0, 160),
    currentActivity: String(result.currentActivity || "").slice(0, 1000),
    durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null,
    wallMs: Number.isFinite(Number(result.wallMs)) ? Number(result.wallMs) : null,
    timeoutSeconds: Number.isFinite(Number(result.timeoutSeconds)) ? Number(result.timeoutSeconds) : null,
    realNameTailCharacter: String(result.realNameTailCharacter || "").slice(0, 8),
    alipayDisplayName: String(result.alipayDisplayName || "").slice(0, 80),
    currentAccount: String(result.currentAccount || "").slice(0, 120),
    savedAccounts: Array.isArray(result.savedAccounts) ? result.savedAccounts.slice(0, 12).map((choice) => ({
      account: String(choice?.account || "").slice(0, 120),
      current: Boolean(choice?.current)
    })).filter((choice) => choice.account) : [],
    accountSwitched: Boolean(result.accountSwitched),
    recoveryAttempts: Math.max(0, Number(result.recoveryAttempts || 0)),
    notFound: Boolean(result.notFound),
    qrTimings: result.qrTimings || null,
    preRunTimings: result.preRunTimings || null,
    diagnostic: compactEventDetail(result.diagnostic || null, 12_000),
    evidence: compactEventDetail({
      capturedAt: result.evidence?.capturedAt || result.capturedAt || "",
      packageName: result.evidence?.packageName || result.packageName || "",
      currentActivity: result.evidence?.currentActivity || result.currentActivity || "",
      hasScreenshot: Boolean(screenshot),
      screenshotSizeBytes: screenshot?.sizeBytes || (screenshot?.dataUrl ? Buffer.byteLength(String(screenshot.dataUrl), "utf8") : null),
      hasUiHierarchy: Boolean(result.uiHierarchy || result.evidence?.uiHierarchy),
      hasUiSnapshot: Boolean(result.uiSnapshot || result.evidence?.uiSnapshot)
    }, 4000),
    runner: result.runner ? {
      ok: result.runner.ok ?? null,
      exitCode: result.runner.exitCode ?? null,
      error: String(result.runner.error || "").slice(0, 2000),
      log: runnerLog.slice(-80).map((item) => compactEventDetail(item, 3000))
    } : null
  };
  if (result.accountIdentityVerified !== undefined) compact.accountIdentityVerified = result.accountIdentityVerified === true;
  if (result.accountSwitchCount !== undefined) compact.accountSwitchCount = Math.max(0, Number(result.accountSwitchCount || 0));
  if (result.accountSwitchReason !== undefined) compact.accountSwitchReason = String(result.accountSwitchReason || "").slice(0, 120);
  if (result.collection) compact.collection = result.collection;
  const uiHierarchy = result.uiHierarchy || result.evidence?.uiHierarchy || "";
  const uiSnapshot = result.uiSnapshot || result.evidence?.uiSnapshot || uiHierarchy;
  if (uiSnapshot) compact.uiSnapshot = String(uiSnapshot).slice(0, 8000);
  if (uiHierarchy) compact.uiHierarchy = String(uiHierarchy).slice(0, 80_000);
  if (screenshot) {
    compact.screenshot = compactScreenshotForTransport(screenshot, { includeDataUrl: false });
  }
  return compact;
}

function normalizeEvidenceForTransport(value = {}, options = {}) {
  if (!value || typeof value !== "object") return value;
  const normalized = { ...value };
  if (normalized.screenshot) normalized.screenshot = compactScreenshotForTransport(normalized.screenshot, options);
  if (normalized.evidence && typeof normalized.evidence === "object") {
    normalized.evidence = { ...normalized.evidence };
    if (normalized.evidence.screenshot) normalized.evidence.screenshot = compactScreenshotForTransport(normalized.evidence.screenshot, options);
    if (normalized.evidence.uiSnapshot) normalized.evidence.uiSnapshot = String(normalized.evidence.uiSnapshot || "").slice(0, 8000);
    if (normalized.evidence.uiHierarchy) normalized.evidence.uiHierarchy = String(normalized.evidence.uiHierarchy || "").slice(0, 300_000);
  }
  if (normalized.uiSnapshot) normalized.uiSnapshot = String(normalized.uiSnapshot || "").slice(0, 8000);
  if (normalized.uiHierarchy) normalized.uiHierarchy = String(normalized.uiHierarchy || "").slice(0, 300_000);
  return normalized;
}

function compactScreenshotForTransport(screenshot, options = {}) {
  if (!screenshot || typeof screenshot !== "object") return null;
  const includeDataUrl = Boolean(options.includeDataUrl);
  const maxDataUrlBytes = Number(options.maxDataUrlBytes || 0);
  const dataUrl = String(screenshot.dataUrl || "");
  const dataUrlBytes = dataUrl ? Buffer.byteLength(dataUrl, "utf8") : 0;
  const canIncludeDataUrl = includeDataUrl && dataUrl && (!maxDataUrlBytes || dataUrlBytes <= maxDataUrlBytes);
  return {
    mimeType: screenshot.mimeType || screenshot.type || "image/png",
    capturedAt: screenshot.capturedAt || "",
    adbSerial: screenshot.adbSerial || "",
    hasDataUrl: Boolean(dataUrl),
    dataUrlBytes,
    sizeBytes: screenshot.sizeBytes || dataUrlBytes || null,
    dataUrlOmitted: Boolean(dataUrl && !canIncludeDataUrl),
    omitReason: dataUrl && !canIncludeDataUrl ? "screenshot_too_large_for_api_payload" : "",
    dataUrl: canIncludeDataUrl ? dataUrl : ""
  };
}

async function scanAdbDevices() {
  let output;
  try {
    output = await run(config.adbPath, ["devices", "-l"]);
    adbServerRecovery.recordSuccess();
  } catch (error) {
    const recovery = await adbServerRecovery.recover({
      cause: cleanLogText(error?.message || error).slice(0, 300),
      // A continuous notification sweep would otherwise make the host look
      // permanently busy and suppress safe SYSTEM-owned `adb start-server`
      // recovery forever. Failed notification reads are disposable and retry
      // on the next round; foreground tasks and screens remain hard blockers.
      busy: hasActiveAutomationTask()
        || Boolean(backgroundSmsSyncPromise)
        || (!config.smsNotificationContinuousScanEnabled && Boolean(backgroundSmsNotificationSyncPromise))
        || screenControlledSerials.size > 0,
      startServer: () => run(config.adbPath, ["start-server"], { timeoutMs: 10_000 })
    });
    log("adb scan recovery", recovery);
    if (!recovery.attempted) throw error;
    output = await run(config.adbPath, ["devices", "-l"]);
    adbServerRecovery.recordSuccess();
  }
  const rows = parseAdbDevices(output);
  const enriched = [];
  for (const row of rows) {
    const serialKey = String(row.adbSerial || "").toUpperCase();
    const previous = lastDevices.find((device) => String(device.adbSerial || "").toUpperCase() === serialKey) || {};
    const serverDevice = cachedServerDeviceForSerial(row.adbSerial);
    Object.assign(row, mergeCachedDeviceScanRow(row, previous, serverDevice));
    if (row.state === "device" && isDeviceSerialReserved(row.adbSerial)) {
      enriched.push({
        ...previous,
        ...row,
        deviceId: previous.deviceId || row.deviceId,
        deviceName: previous.deviceName || row.deviceName || defaultDeviceName(row),
        automationBusy: true
      });
      continue;
    }
    if (row.state === "device") {
      row.model = row.model || "";
      row.manufacturer = row.manufacturer || "";
      row.brand = row.brand || row.manufacturer || "";
      row.androidVersion = row.androidVersion || "";
      row.batteryLevel = row.batteryLevel ?? null;
      row.sims = row.sims || [];
    }
    row.deviceName = row.deviceName || defaultDeviceName(row);
    enriched.push(row);
  }
  await hydrateStaticDeviceInfo(enriched);
  await refreshBatteryLevels(enriched);
  await refreshSmsRelayHealth(enriched);
  return enriched;
}

async function skipRecoveryIfAdbAlreadyOnline(serial, observation) {
  try {
    const output = await run(config.adbPath, ["-s", serial, "get-state"], { timeoutMs: 5_000 });
    if (String(output || "").trim().toLowerCase() !== "device") return false;
  } catch {
    return false;
  }

  const key = String(serial || "").trim().toUpperCase();
  const previous = normalizePnpRecoveryTargetState(pnpTargetRecoveryAttempts.get(key), serial);
  const verification = observeAdbRecoveryVerification(previous, {
    online: true,
    minStableMs: config.pnpRecoveryStableSeconds * 1_000,
    minStableScans: config.pnpRecoveryStableScans
  });
  pnpTargetRecoveryAttempts.set(key, verification.state);
  pnpMissingDeviceRecovery.markReset(serial, {
    targetPresent: true,
    retryAfterMs: config.pnpTargetResetCooldownSeconds * 1_000
  });
  pnpRecoveryJournal.record({
    type: "verification_started",
    severity: "info",
    serial,
    state: DEVICE_RECOVERY_STATES.ADB_DEVICE,
    previousState: observation?.state || "unknown",
    attempt: previous.attempts || 0,
    mode: previous.lastMode,
    reason: "last_moment_adb_recheck_stability_pending"
  });
  schedulePnpRecoveryStateSave();
  log("pnp target recovery skipped after live adb recheck; stability pending", {
    serial,
    previousState: observation?.state || "unknown",
    attempts: previous.attempts || 0,
    minStableSeconds: config.pnpRecoveryStableSeconds,
    minStableScans: config.pnpRecoveryStableScans
  });
  return true;
}

async function requestSafePnpRescanForMissingDevices(devices, options = {}) {
  if (os.platform() !== "win32") return;
  const online = new Set(devices
    .filter((device) => device?.state === "device")
    .map((device) => String(device.adbSerial || "").trim().toUpperCase())
    .filter(Boolean));
  for (const [serial, state] of pnpTargetRecoveryAttempts) {
    const verification = observeAdbRecoveryVerification(state, {
      online: online.has(serial),
      minStableMs: config.pnpRecoveryStableSeconds * 1_000,
      minStableScans: config.pnpRecoveryStableScans
    });
    if (verification.confirmed) {
      log("pnp target adb recovery stability confirmed", {
        serial: state.serial,
        attempts: state.attempts,
        lastMode: state.lastMode,
        stableSeconds: Math.round(verification.elapsedMs / 1_000),
        stableScans: verification.scans
      });
      pnpRecoveryJournal.record({
        type: "recovered",
        severity: "success",
        serial: state.serial,
        state: DEVICE_RECOVERY_STATES.ADB_DEVICE,
        attempt: state.attempts || 0,
        mode: state.lastMode,
        reason: "stability_window_confirmed"
      });
      pnpTargetRecoveryAttempts.delete(serial);
      continue;
    }
    if (verification.state !== state) pnpTargetRecoveryAttempts.set(serial, verification.state);
  }

  const isSerialBusy = (serial) => serialAdbActivity.activeCount(serial) > 0 || isDeviceSerialReserved(serial);
  const physicalRecoveryDue = options.forceInventory === true
    || Date.now() - lastPhysicalPnpCandidateScanAt >= config.pnpRescanCooldownSeconds * 1_000;
  if (physicalRecoveryDue) {
    lastPhysicalPnpCandidateScanAt = Date.now();
    const inventoryResult = await discoverPhysicallyPresentAndroidUsbInventory();
    if (inventoryResult.ok) {
      lastPhysicalPnpInventory = inventoryResult.rows;
      lastPhysicallyPresentAndroidUsbSerials = lastPhysicalPnpInventory.map((item) => item.serial);
      lastSuccessfulPhysicalPnpInventoryAt = Date.now();
      lastPhysicalPnpInventoryError = "";
    } else {
      lastPhysicalPnpInventoryError = inventoryResult.error || "inventory_failed";
    }
    // Physical-only devices may never have reached ADB and therefore are not
    // present in the server cache. Seed them into the same per-device tracker
    // so cooldown and round-robin fairness apply to every recovery candidate.
    pnpMissingDeviceRecovery.seed(lastPhysicallyPresentAndroidUsbSerials);
  }

  const inventoryReady = isPhysicalPnpInventoryReady();
  lastDeviceRecoveryObservations = buildDeviceRecoveryObservations({
    devices,
    inventory: lastPhysicalPnpInventory,
    knownSerials: cachedAdbSerials(lastServerDevicesById),
    inventoryReady
  });
  pnpRecoveryJournal.observeTransitions(lastDeviceRecoveryObservations);
  // A PnP restart/remove temporarily removes the exact phone from the tree.
  // Only a sustained absence is treated as a real unplug and starts a fresh
  // recovery cycle; otherwise the same stage must not repeat forever.
  for (const observation of lastDeviceRecoveryObservations) {
    const previous = pnpTargetRecoveryAttempts.get(observation.key);
    if (!previous) continue;
    const absence = observePhysicalAbsence(previous, {
      absent: observation.state === DEVICE_RECOVERY_STATES.PHYSICALLY_ABSENT,
      minAbsentMs: config.pnpRecoveryAbsentResetSeconds * 1_000
    });
    if (absence.reset) {
      pnpTargetRecoveryAttempts.delete(observation.key);
      log("pnp target recovery cycle reset after sustained physical absence", {
        serial: observation.serial,
        attempts: previous.attempts || 0,
        absentSeconds: Math.round(absence.absentMs / 1_000)
      });
    } else if (absence.state !== previous) {
      pnpTargetRecoveryAttempts.set(observation.key, absence.state);
    }
  }
  appendPhysicalRecoveryRows(devices, lastDeviceRecoveryObservations);
  const recoveryExclusions = new Set([...screenControlledSerials, ...activeTaskSerials]
    .map((serial) => String(serial || "").trim().toUpperCase())
    .filter(Boolean));
  // A session on another phone no longer freezes the whole queue. The exact
  // session phone remains excluded from safety candidates, telemetry and PnP
  // selection; foreground automation still blocks mutations and DeviceInstall
  // itself remains host-wide single-flight.
  const hostBusy = false;
  let safety = pnpRecoverySafety.observe(lastDeviceRecoveryObservations, {
    hostBusy,
    installerBusy: false,
    inventoryReady,
    ignoredSerials: recoveryExclusions
  });
  lastPnpRecoveryHealth = publicPnpRecoveryHealth(safety);
  logPnpRecoverySafetyTransition(safety);
  schedulePnpRecoveryStateSave();
  if (safety.actionableCount > 0 && !safety.circuitOpen) {
    const pnpTargetSerials = lastDeviceRecoveryObservations
      .filter((item) => item.physicalPresent && item.state !== DEVICE_RECOVERY_STATES.ADB_DEVICE && !recoveryExclusions.has(item.key))
      .map((item) => item.serial);
    await preemptBackgroundSmsSyncForPnpRecovery(pnpTargetSerials);
  }

  const plan = pnpMissingDeviceRecovery.observe({ devices, busy: false, isSerialBusy });
  scheduleNextPnpRecoveryDueWake();
  if (!plan.missing.length) return;
  const physical = new Set(lastPhysicallyPresentAndroidUsbSerials.map((serial) => serial.toUpperCase()));
  const observationsBySerial = new Map(lastDeviceRecoveryObservations.map((item) => [item.key, item]));
  const physicalMissing = lastDeviceRecoveryObservations
    .filter((item) => item.physicalPresent && item.state !== DEVICE_RECOVERY_STATES.ADB_DEVICE)
    .map((item) => item.serial);
  if (physicalRecoveryDue && physicalMissing.length) {
    log("pnp physical adb candidates", {
      serials: physicalMissing,
      busySerials: physicalMissing.filter(isSerialBusy),
      states: Object.fromEntries(physicalMissing.map((serial) => [serial, observationsBySerial.get(String(serial).toUpperCase())?.state || "unknown"]))
    });
  }

  const rescanSerials = plan.rescanSerials
    .filter((serial) => physical.has(String(serial).toUpperCase()))
    .filter((serial) => !isSerialBusy(serial));
  if (plan.rescanSerials.length) {
    // D-003: a global PnP scan can touch every controller and is a maintenance
    // operation. Mark this observation handled without executing the scan.
    pnpMissingDeviceRecovery.markRescan();
    if (rescanSerials.length) {
      log("pnp global rescan blocked by policy", {
        serials: rescanSerials,
        reason: "explicit_maintenance_authorization_required"
      });
    }
  }

  const recoveryDueAt = Date.now();
  const dueTargets = orderPnpRecoveryTargets(
    plan.resetSerials
      .filter((serial) => physical.has(String(serial).toUpperCase()))
      .filter((serial) => {
        const state = observationsBySerial.get(String(serial).toUpperCase())?.state;
        return isAutomaticPnpRecoveryState(state) || isAutomaticAdbTransportRecoveryState(state);
      })
      .filter((serial) => {
        const key = String(serial).trim().toUpperCase();
        const previous = normalizePnpRecoveryTargetState(pnpTargetRecoveryAttempts.get(key), serial);
        return isPnpRecoveryTargetDue(previous, recoveryDueAt);
      }),
    pnpTargetRecoveryAttempts
  );
  const plannedTargets = dueTargets.map((serial) => {
    const key = String(serial).trim().toUpperCase();
    const observation = observationsBySerial.get(key);
    const previous = normalizePnpRecoveryTargetState(pnpTargetRecoveryAttempts.get(key), serial);
    return {
      serial,
      plan: planPnpRecoveryAction({ observation, previous, maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice })
    };
  });
  // Exact child actions keep the authorized eight-lane throughput. Advanced
  // root/Composite/port actions use at most one lane per proven upstream;
  // automatic Hub reset and global scans are deliberately not part of the plan.
  // A terminal/manual row is telemetry, not runnable work. Previously those
  // rows occupied the batch and could indefinitely starve a phone that still
  // had a safe exact-port action available.
  const batchScope = scopePnpRecoveryPlansForSafety(
    plannedTargets,
    safety,
    config.pnpMaxTargetRecoveriesPerPass
  );
  const rescueKeys = new Set(batchScope.rescueSerials);
  const batchTargets = selectPnpRecoveryBatch(
    batchScope.plans,
    pnpTargetRecoveryAttempts,
    batchScope.maxTargets
  )
    .map((item) => item.serial);
  if (!batchTargets.length) return;
  const batchKeys = new Set(batchTargets.map((serial) => String(serial).trim().toUpperCase()));
  const batchNeedsPnp = plannedTargets.some((item) => batchKeys.has(String(item.serial).trim().toUpperCase())
    && isAutomaticRecoveryAction(item.plan)
    && item.plan.mode !== "adb_reconnect");
  if (batchNeedsPnp) {
    const installer = await inspectWindowsDeviceInstallActivity();
    if (installer.busy) {
      safety = pnpRecoverySafety.observe(lastDeviceRecoveryObservations, {
        hostBusy,
        installerBusy: true,
        installerUnknown: installer.state === "unknown",
        inventoryReady,
        ignoredSerials: recoveryExclusions
      });
      lastPnpRecoveryHealth = publicPnpRecoveryHealth(safety);
      logPnpRecoverySafetyTransition(safety);
      pnpRecoveryJournal.record({ type: "deferred", severity: "warning", reason: installer.reason });
      schedulePnpRecoveryStateSave();
      log("pnp concurrent recovery batch deferred", {
        serials: batchTargets,
        reason: installer.reason,
        probeState: installer.state,
        probeDurationMs: installer.durationMs,
        probeCheckedAt: installer.checkedAt,
        probeErrorCode: installer.errorCode,
        probeTimedOut: installer.timedOut,
        processCount: installer.processes.length,
        processes: installer.processes.slice(0, 8)
      });
      pnpRecoveryWakeScheduler?.schedule(config.pnpDeviceInstallPollSeconds * 1_000, "device_install_idle");
      return;
    }
  }

  async function recoverSelectedTarget(serial) {
  if (isSerialBusy(serial)) {
    pnpRecoveryJournal.record({ type: "deferred", severity: "warning", serial, reason: "target_busy" });
    schedulePnpRecoveryStateSave();
    log("pnp target adb recovery deferred", { serial, reason: "target_busy" });
    return { serial, status: "deferred", reason: "target_busy", actionAttempted: false };
  }

  const key = String(serial).toUpperCase();
  const observation = observationsBySerial.get(key);
  const plannedState = pnpTargetRecoveryAttempts.get(key);
  const previous = normalizePnpRecoveryTargetState(plannedState, serial);
  function checkAdmission() {
    const reason = pnpRecoveryAdmissionReason({
      currentState: pnpTargetRecoveryAttempts.get(key), plannedState,
      currentObservation: lastDeviceRecoveryObservations.find((item) => item.key === key),
      plannedObservation: observation, inventoryReady: isPhysicalPnpInventoryReady(),
      busy: isSerialBusy(serial)
    });
    if (!reason) return null;
    pnpRecoveryJournal.record({ type: "deferred", severity: "warning", serial, reason });
    schedulePnpRecoveryStateSave();
    log("pnp target adb recovery deferred", { serial, reason });
    scheduleNextPnpRecoveryDueWake();
    return { serial, status: "deferred", reason, actionAttempted: false };
  }
  const admission = checkAdmission();
  if (admission) return admission;
  const actionPlan = planPnpRecoveryAction({
    observation,
    previous,
    maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice
  });
  const transportOnly = actionPlan.mode === "adb_reconnect";
  const attempt = actionPlan.attempt;
  const mode = actionPlan.mode;
  // Append only when the command completes successfully. A stale exact PnP
  // mapping or transient DeviceInstall failure must remain retryable.
  const completedActionHistory = [...(previous.actionHistory || []), mode];
  if (isDeferredPnpRecoveryPlan(actionPlan)) {
    const nextRetryAt = Date.now() + config.pnpTargetAbsentRetrySeconds * 1_000;
    pnpTargetRecoveryAttempts.set(key, {
      ...previous,
      serial,
      lastMode: mode,
      targetType: actionPlan.targetType,
      nextRetryAt,
      quarantinedAt: 0
    });
    pnpRecoveryJournal.record({
      type: "deferred",
      severity: "warning",
      serial,
      state: observation?.state || "unknown",
      attempt: previous.attempts || 0,
      maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
      mode,
      reason: "exact_mapping_temporarily_unavailable",
      nextActionAt: new Date(nextRetryAt).toISOString(),
      targetType: actionPlan.targetType
    });
    await persistPnpRecoveryStateNow();
    pnpMissingDeviceRecovery.markReset(serial, { targetPresent: true, retryAfterMs: config.pnpTargetAbsentRetrySeconds * 1_000 });
    log("pnp target adb recovery deferred", {
      serial,
      state: observation?.state || "unknown",
      attempts: previous.attempts || 0,
      mode,
      reason: "exact_mapping_temporarily_unavailable",
      nextRetrySeconds: config.pnpTargetAbsentRetrySeconds
    });
    return { serial, status: "deferred", reason: "exact_mapping_temporarily_unavailable", mode, actionAttempted: false };
  }
  if (!isAutomaticRecoveryAction(actionPlan)) {
    if (config.pnpContinuousRecoveryEnabled && actionPlan.terminal) {
      const cooldownMs = config.pnpRecoveryCycleCooldownSeconds * 1_000;
      const nextCycle = beginNextPnpRecoveryCycle(previous, {
        serial,
        terminalMode: mode,
        at: Date.now(),
        cooldownMs
      });
      const nextRetryAt = nextCycle.nextRetryAt;
      const recoveryCycle = nextCycle.recoveryCycle;
      pnpTargetRecoveryAttempts.set(key, {
        ...nextCycle,
        targetType: actionPlan.targetType,
        lastError: mode
      });
      pnpRecoveryJournal.record({
        type: "cooldown_started",
        severity: "warning",
        serial,
        state: observation?.state || "unknown",
        attempt: previous.attempts || 0,
        maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
        mode,
        reason: "recovery_cycle_completed",
        result: `cycle=${recoveryCycle}; cooldown=${config.pnpRecoveryCycleCooldownSeconds}s`,
        nextActionAt: new Date(nextRetryAt).toISOString(),
        targetType: actionPlan.targetType
      });
      await persistPnpRecoveryStateNow();
      pnpMissingDeviceRecovery.markReset(serial, { targetPresent: true, retryAfterMs: cooldownMs });
      pnpRecoveryWakeScheduler?.schedule(cooldownMs, "continuous_recovery_cycle");
      log("pnp target recovery cycle cooling down", {
        serial,
        state: observation?.state || "unknown",
        recoveryCycle,
        completedAttempts: previous.attempts || 0,
        terminalMode: mode,
        cooldownSeconds: config.pnpRecoveryCycleCooldownSeconds
      });
      return {
        serial,
        status: "deferred",
        reason: "recovery_cycle_cooldown",
        mode: "recovery_cycle_cooldown",
        actionAttempted: false
      };
    }
    if (!previous.quarantinedAt || previous.lastMode !== mode) {
      const quarantinedAt = Date.now();
      pnpTargetRecoveryAttempts.set(key, {
        ...previous,
        serial,
        lastMode: mode,
        targetType: actionPlan.targetType,
        quarantinedAt,
        nextRetryAt: 0,
        lastError: mode
      });
      pnpRecoveryJournal.record({
        type: "quarantined",
        severity: "error",
        serial,
        state: observation?.state || "unknown",
        attempt: previous.attempts || 0,
        maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
        mode,
        reason: mode,
        targetType: actionPlan.targetType
      });
      await persistPnpRecoveryStateNow();
      log("pnp target automatic recovery exhausted by state", {
        serial,
        state: observation?.state || "unknown",
        attempts: previous.attempts || 0,
        mode,
        maintenanceRequired: true
      });
    }
    pnpMissingDeviceRecovery.markReset(serial, { retryAfterMs: config.pnpTargetAbsentRetrySeconds * 1_000 });
    return { serial, status: "quarantined", reason: mode, mode, actionAttempted: false };
  }
  const circuitRescue = safety.circuitOpen
    && safety.rescueCanMutate
    && rescueKeys.has(key);
  const hardSafetyBlock = (safety.circuitOpen && !circuitRescue)
    || safety.blockedReason === "hourly_budget_exhausted"
    || safety.blockedReason === "physical_inventory_unavailable"
    || safety.blockedReason === "action_cooldown";
  if (hardSafetyBlock || (!transportOnly && !safety.canMutate && !circuitRescue)) {
    return { serial, status: "blocked", reason: safety.blockedReason || "safety_block", mode, actionAttempted: false };
  }
  // The physical inventory and recovery plan are snapshots. A phone may have
  // rejoined ADB while it was waiting for the host lane. Re-check immediately
  // before consuming an attempt or touching PnP, and never restart a device
  // which is already live now.
  if (await skipRecoveryIfAdbAlreadyOnline(serial, observation)) {
    return { serial, status: "skipped", reason: "already_online", mode, actionAttempted: false };
  }
  const retryAfterMs = pnpRecoveryActionBackoffMs(
    previous,
    mode,
    config.pnpTargetResetCooldownSeconds * 1_000,
    config.pnpTargetRetryMaxSeconds * 1_000
  );
  const nextCheckAfterMs = attempt >= config.pnpMaxAutomaticAttemptsPerDevice
    ? config.pnpTargetResetCooldownSeconds * 1_000
    : retryAfterMs;
  if (transportOnly) {
    const admission = checkAdmission();
    if (admission) return admission;
    const attemptedAt = Date.now();
    try {
      pnpRecoverySafety.recordAction();
      lastPnpRecoveryHealth = publicPnpRecoveryHealth(pnpRecoverySafety.health());
      pnpTargetRecoveryAttempts.set(key, { ...previous, serial, attempts: attempt, actionHistory: previous.actionHistory || [], lastMode: mode, lastAttemptAt: attemptedAt, inProgress: true, quarantinedAt: 0 });
      pnpRecoveryJournal.record({
        type: "action_started",
        severity: "info",
        serial,
        state: observation?.state || "unknown",
        attempt,
        maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
        mode
      });
      await persistPnpRecoveryStateNow();
      const output = await run(config.adbPath, ["-s", serial, "reconnect"], { timeoutMs: 10_000 });
      const nextRetryAt = attemptedAt + nextCheckAfterMs;
      pnpTargetRecoveryAttempts.set(key, { ...previous, serial, attempts: attempt, actionHistory: completedActionHistory, lastMode: mode, lastAttemptAt: attemptedAt, nextRetryAt, inProgress: false, quarantinedAt: 0 });
      pnpRecoveryJournal.record({
        type: "action_completed",
        severity: "info",
        serial,
        state: observation?.state || "unknown",
        attempt,
        maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
        mode,
        result: cleanLogText(output).slice(-300) || "reconnect_requested",
        nextActionAt: new Date(nextRetryAt).toISOString()
      });
      schedulePnpRecoveryStateSave();
      pnpMissingDeviceRecovery.markReset(serial, { targetPresent: true, retryAfterMs: nextCheckAfterMs });
      log("adb transport recovery", {
        serial,
        attempt,
        mode,
        nextCheckSeconds: Math.round(nextCheckAfterMs / 1_000),
        finalAttemptVerification: attempt >= config.pnpMaxAutomaticAttemptsPerDevice,
        result: cleanLogText(output).slice(-300) || "reconnect_requested"
      });
      return { serial, status: "action_completed", mode, actionAttempted: true };
    } catch (error) {
      const exhausted = attempt >= config.pnpMaxAutomaticAttemptsPerDevice;
      const recycleAfterFailure = config.pnpContinuousRecoveryEnabled && exhausted;
      const retryDelayMs = recycleAfterFailure
        ? config.pnpRecoveryCycleCooldownSeconds * 1_000
        : retryAfterMs;
      const nextRetryAt = exhausted && !config.pnpContinuousRecoveryEnabled ? 0 : attemptedAt + retryDelayMs;
      pnpTargetRecoveryAttempts.set(key, {
        ...previous,
        serial,
        attempts: recycleAfterFailure ? 0 : attempt,
        actionHistory: recycleAfterFailure ? [] : previous.actionHistory || [],
        lastMode: mode,
        lastAttemptAt: attemptedAt,
        nextRetryAt,
        lastError: cleanLogText(error?.message || error).slice(0, 300),
        quarantinedAt: exhausted && !config.pnpContinuousRecoveryEnabled ? attemptedAt : 0,
        ...(recycleAfterFailure ? { recoveryCycle: Math.max(0, Number(previous.recoveryCycle || 0)) + 1 } : {})
      });
      pnpRecoveryJournal.record({
        type: exhausted && !config.pnpContinuousRecoveryEnabled ? "quarantined" : "action_failed",
        severity: "error",
        serial,
        state: observation?.state || "unknown",
        attempt,
        maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
        mode,
        reason: "adb_reconnect_failed",
        result: cleanLogText(error?.message || error).slice(0, 300),
        nextActionAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : ""
      });
      await persistPnpRecoveryStateNow().catch((saveError) => log("pnp recovery state save failed", cleanLogText(saveError?.message || saveError).slice(0, 300)));
      pnpMissingDeviceRecovery.markReset(serial, { retryAfterMs: nextRetryAt ? retryDelayMs : config.pnpTargetAbsentRetrySeconds * 1_000 });
      if (recycleAfterFailure) pnpRecoveryWakeScheduler?.schedule(retryDelayMs, "continuous_adb_failure_cycle");
      log("adb transport recovery failed", {
        serial,
        attempt,
        maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
        mode,
        nextRetrySeconds: nextRetryAt ? Math.round(retryDelayMs / 1_000) : null,
        maintenanceRequired: exhausted && !config.pnpContinuousRecoveryEnabled,
        error: cleanLogText(error?.message || error).slice(0, 300)
      });
      return { serial, status: "action_failed", reason: "adb_reconnect_failed", mode, actionAttempted: true };
    }
  }

  const releaseTargetPnp = pnpScreenCoordinator.tryBegin(serial, () => isSerialBusy(serial));
  if (!releaseTargetPnp) {
    pnpRecoveryJournal.record({ type: "deferred", severity: "warning", serial, state: observation?.state || "unknown", reason: "host_or_pnp_action_in_progress" });
    schedulePnpRecoveryStateSave();
    log("pnp target adb recovery deferred", { serial, reason: "host_or_pnp_action_in_progress" });
    return { serial, status: "deferred", reason: "host_or_pnp_action_in_progress", mode, actionAttempted: false };
  }
  const attemptedAt = Date.now();
  try {
    const admission = checkAdmission();
    if (admission) return admission;
    if (isSerialBusy(serial)) {
      pnpRecoveryJournal.record({ type: "deferred", severity: "warning", serial, state: observation?.state || "unknown", reason: "host_became_busy" });
      schedulePnpRecoveryStateSave();
      log("pnp target adb recovery deferred", { serial, reason: "host_became_busy" });
      return { serial, status: "deferred", reason: "host_became_busy", mode, actionAttempted: false };
    }
    const target = actionPlan;
    if (!target.instanceId && target.mode !== "adb_reconnect") {
      pnpTargetRecoveryAttempts.set(key, {
        ...previous,
        serial,
        // No mutation happened, so this is not one of the five recovery
        // attempts. Re-probe the read-only inventory soon and act once an
        // exact phone node exists.
        attempts: previous.attempts || 0,
        lastMode: "no_exact_target",
        lastAttemptAt: attemptedAt,
        nextRetryAt: attemptedAt + config.pnpTargetAbsentRetrySeconds * 1_000
      });
      pnpRecoveryJournal.record({
        type: "deferred",
        severity: "warning",
        serial,
        state: observation?.state || "unknown",
        attempt: previous.attempts || 0,
        maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
        mode: "no_exact_target",
        reason: "exact_instance_not_found",
        nextActionAt: new Date(attemptedAt + config.pnpTargetAbsentRetrySeconds * 1_000).toISOString()
      });
      await persistPnpRecoveryStateNow();
      pnpMissingDeviceRecovery.markReset(serial, { targetPresent: false, retryAfterMs: config.pnpTargetAbsentRetrySeconds * 1_000 });
      log("pnp target adb recovery deferred", {
        serial,
        state: observation?.state || "unknown",
        attempts: previous.attempts || 0,
        maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
        reason: "exact_instance_not_found",
        nextRetrySeconds: config.pnpTargetAbsentRetrySeconds,
        maintenanceRequired: false
      });
      return { serial, status: "deferred", reason: "exact_instance_not_found", mode, actionAttempted: false };
    }
    pnpRecoverySafety.recordAction();
    lastPnpRecoveryHealth = publicPnpRecoveryHealth(pnpRecoverySafety.health());
    pnpTargetRecoveryAttempts.set(key, { ...previous, serial, attempts: attempt, actionHistory: previous.actionHistory || [], lastMode: mode, lastAttemptAt: attemptedAt, targetType: target.targetType, inProgress: true, quarantinedAt: 0 });
    pnpRecoveryJournal.record({
      type: "action_started",
      severity: "info",
      serial,
      state: observation?.state || "unknown",
      attempt,
      maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
      mode,
      targetType: target.targetType
    });
    await persistPnpRecoveryStateNow();
    const result = await executePnpRecoveryAction(target);
    const nextRetryAt = attemptedAt + nextCheckAfterMs;
    pnpTargetRecoveryAttempts.set(key, { ...previous, serial, attempts: attempt, actionHistory: completedActionHistory, lastMode: mode, lastAttemptAt: attemptedAt, nextRetryAt, targetType: target.targetType, inProgress: false, quarantinedAt: 0 });
    pnpRecoveryJournal.record({
      type: "action_completed",
      severity: "info",
      serial,
      state: observation?.state || "unknown",
      attempt,
      maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
      mode,
      targetType: target.targetType,
      result: cleanLogText(result?.result || "restart_requested").slice(0, 300),
      nextActionAt: new Date(nextRetryAt).toISOString()
    });
    schedulePnpRecoveryStateSave();
    pnpMissingDeviceRecovery.markReset(serial, { targetPresent: true, retryAfterMs: nextCheckAfterMs });
    log("pnp target adb recovery", {
      serial,
      attempt,
      mode,
      state: observation?.state || "unknown",
      targetType: target.targetType,
      instanceId: target.instanceId,
      nextRetrySeconds: attempt >= config.pnpMaxAutomaticAttemptsPerDevice ? null : Math.round(retryAfterMs / 1_000),
      nextCheckSeconds: Math.round(nextCheckAfterMs / 1_000),
      finalAttemptVerification: attempt >= config.pnpMaxAutomaticAttemptsPerDevice,
      ...result
    });
    pnpRecoveryWakeScheduler?.schedule(config.pnpPostActionProbeSeconds * 1_000, "pnp_post_action_probe");
    return { serial, status: "action_completed", mode, actionAttempted: true };
  } catch (error) {
    const reason = /timeout|timed out|ETIMEDOUT/i.test(String(error?.message || "")) ? "pnp_timeout" : "pnp_action_failed";
    // A timeout may leave Windows DrvInst work alive, so briefly open the
    // host-wide circuit. A normal command failure stays inside the per-device
    // retry budget and must not stop unrelated recoveries.
    if (reason === "pnp_timeout") {
      pnpRecoverySafety.recordFailure(reason, { serial });
      lastPnpRecoveryHealth = publicPnpRecoveryHealth(pnpRecoverySafety.health());
    }
    const exhausted = attempt >= config.pnpMaxAutomaticAttemptsPerDevice;
    const recycleAfterFailure = config.pnpContinuousRecoveryEnabled && exhausted;
    const retryDelayMs = recycleAfterFailure
      ? config.pnpRecoveryCycleCooldownSeconds * 1_000
      : retryAfterMs;
    const nextRetryAt = exhausted && !config.pnpContinuousRecoveryEnabled ? 0 : attemptedAt + retryDelayMs;
    pnpTargetRecoveryAttempts.set(key, {
      ...previous,
      serial,
      attempts: recycleAfterFailure ? 0 : attempt,
      actionHistory: recycleAfterFailure ? [] : previous.actionHistory || [],
      lastMode: mode,
      lastAttemptAt: attemptedAt,
      nextRetryAt,
      lastError: cleanLogText(error?.message || error).slice(0, 300),
      quarantinedAt: exhausted && !config.pnpContinuousRecoveryEnabled ? attemptedAt : 0,
      ...(recycleAfterFailure ? { recoveryCycle: Math.max(0, Number(previous.recoveryCycle || 0)) + 1 } : {})
    });
    pnpRecoveryJournal.record({
      type: exhausted && !config.pnpContinuousRecoveryEnabled ? "quarantined" : "action_failed",
      severity: "error",
      serial,
      state: observation?.state || "unknown",
      attempt,
      maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
      mode,
      reason,
      result: cleanLogText(error?.message || error).slice(0, 300),
      nextActionAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : ""
    });
    await persistPnpRecoveryStateNow().catch((saveError) => log("pnp recovery state save failed", cleanLogText(saveError?.message || saveError).slice(0, 300)));
    pnpMissingDeviceRecovery.markReset(serial, { retryAfterMs: nextRetryAt ? retryDelayMs : config.pnpTargetAbsentRetrySeconds * 1_000 });
    if (recycleAfterFailure) pnpRecoveryWakeScheduler?.schedule(retryDelayMs, "continuous_pnp_failure_cycle");
    log("pnp target adb recovery failed", {
      serial,
      attempt,
      maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
      mode,
      state: observation?.state || "unknown",
      reason,
      nextRetrySeconds: nextRetryAt ? Math.round(retryDelayMs / 1_000) : null,
      maintenanceRequired: exhausted && !config.pnpContinuousRecoveryEnabled,
      error: cleanLogText(error?.message || error).slice(0, 300)
    });
    pnpRecoveryWakeScheduler?.schedule(config.pnpDeviceInstallPollSeconds * 1_000, "pnp_failed_action_probe");
    return { serial, status: "action_failed", reason, mode, actionAttempted: true };
  } finally {
    releaseTargetPnp();
  }
  }

  if (batchScope.rescue && batchTargets[0]) {
    pnpRecoveryJournal.record({
      type: "rescue_started",
      severity: "warning",
      serial: batchTargets[0],
      reason: "circuit_collateral_rescue"
    });
    schedulePnpRecoveryStateSave();
  }
  log("pnp concurrent recovery batch started", {
    serials: batchTargets,
    concurrency: config.pnpTargetRecoveryConcurrency,
    maxPerPass: batchScope.maxTargets,
    rescue: batchScope.rescue
  });
  const batchResults = await Promise.allSettled(batchTargets.map((serial) => recoverSelectedTarget(serial)));
  const batchSummary = summarizePnpRecoveryBatchResults(batchResults, batchTargets);
  const {
    outcomes,
    actionedSerials,
    attempted,
    failed,
    deferred,
    skipped,
    quarantined,
    internalFailures
  } = batchSummary;
  if (internalFailures.length) log("pnp concurrent recovery batch internal failures", internalFailures);

  const pnpActionedSerials = outcomes
    .filter((item) => item?.actionAttempted === true && item?.mode !== "adb_reconnect")
    .map((item) => String(item.serial || "").trim())
    .filter(Boolean);
  if (pnpActionedSerials.length && !config.pnpContinuousRecoveryEnabled) {
    const watchHealth = pnpRecoverySafety.beginPostActionWatch({
      onlineSerials: [...online],
      actionedSerials: pnpActionedSerials,
      durationMs: config.pnpCollateralWatchSeconds * 1_000
    });
    lastPnpRecoveryHealth = publicPnpRecoveryHealth(watchHealth);
    pnpRecoveryJournal.record({
      type: "post_action_watch_started",
      severity: "info",
      result: `${config.pnpCollateralWatchSeconds}s`,
      reason: "delayed_collateral_guard"
    });
    schedulePnpRecoveryStateSave();
  }

  if (!actionedSerials.length) {
    log("pnp concurrent recovery batch completed", {
      serials: batchTargets,
      selected: batchTargets.length,
      attempted: 0,
      failed: 0,
      deferred,
      skipped,
      quarantined,
      onlineBefore: online.size,
      onlineAfter: online.size,
      collateralLosses: []
    });
    return;
  }

  await delay(5_000);
  try {
    const postBatchRows = parseAdbDevices(await run(config.adbPath, ["devices", "-l"], { timeoutMs: 10_000 }));
    const postBatchOnline = new Set(postBatchRows
      .filter((item) => item.state === "device")
      .map((item) => String(item.adbSerial || "").trim().toUpperCase()));
    // Only a serial whose command actually started is a batch target for
    // collateral accounting. Merely selecting a target must not hide a loss
    // or inflate attempted telemetry when safety blocks the mutation.
    const batchKeys = new Set(actionedSerials.map((serial) => String(serial).trim().toUpperCase()));
    const collateralLosses = [...online].filter((serial) => !batchKeys.has(serial) && !postBatchOnline.has(serial));
    if (collateralLosses.length) {
      pnpRecoverySafety.recordFailure("burst_outage", { collateralLosses, batchTargets });
      lastPnpRecoveryHealth = publicPnpRecoveryHealth(pnpRecoverySafety.health());
      logPnpRecoverySafetyTransition(pnpRecoverySafety.health());
      schedulePnpRecoveryStateSave();
    }
    log("pnp concurrent recovery batch completed", {
      serials: batchTargets,
      actionedSerials,
      selected: batchTargets.length,
      attempted,
      failed,
      deferred,
      skipped,
      quarantined,
      onlineBefore: online.size,
      onlineAfter: postBatchOnline.size,
      collateralLosses
    });
  } catch (error) {
    log("pnp concurrent recovery batch verification failed", cleanLogText(error?.message || error).slice(0, 300));
  }
}

async function loadPnpRecoveryState(filePath) {
  try {
    const parsed = JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code !== "ENOENT") log("pnp recovery state load failed", cleanLogText(error?.message || error).slice(0, 300));
    return {};
  }
}

function schedulePnpRecoveryStateSave() {
  if (pnpRecoveryStateSaveTimer) return;
  pnpRecoveryStateSaveTimer = setTimeout(() => {
    pnpRecoveryStateSaveTimer = null;
    flushPnpRecoveryState().catch((error) => log("pnp recovery state save failed", cleanLogText(error?.message || error).slice(0, 300)));
  }, 500);
}

async function persistPnpRecoveryStateNow() {
  if (pnpRecoveryStateSaveTimer) {
    clearTimeout(pnpRecoveryStateSaveTimer);
    pnpRecoveryStateSaveTimer = null;
  }
  await flushPnpRecoveryState();
}

function flushPnpRecoveryState() {
  const pending = pnpRecoveryStateWriteChain.then(() => writePnpRecoveryState());
  pnpRecoveryStateWriteChain = pending.catch(() => {});
  return pending;
}

async function writePnpRecoveryState() {
  const journal = pnpRecoveryJournal.snapshot();
  const state = {
    version: 2,
    safety: pnpRecoverySafety.snapshot(),
    targets: [...pnpTargetRecoveryAttempts.values()].slice(0, 500),
    events: journal.events,
    observedStates: journal.observedStates
  };
  const signature = JSON.stringify(state);
  if (signature === lastSavedPnpRecoveryState) return;
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  const temporary = `${pnpRecoveryStatePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, payload, "utf8");
  await fs.rename(temporary, pnpRecoveryStatePath);
  lastSavedPnpRecoveryState = signature;
}

function hasHostWideRecoveryBlocker() {
  return Boolean(
    screenControlledSerials.size
    || activeTaskSerials.size
    || hasActiveAutomationTask()
    || backgroundSmsSyncPromise
    || backgroundSmsNotificationSyncPromise
    || automationPreflightRunning.size
  );
}

function appendPhysicalRecoveryRows(devices, observations) {
  const existing = new Map(devices.map((item) => [String(item?.adbSerial || "").toUpperCase(), item]).filter(([key]) => key));
  for (const observation of observations) {
    const recovery = {
      state: observation.state,
      physicalPresent: observation.physicalPresent,
      rootProblem: String(observation.physical?.rootProblem || ""),
      adbInterfaceProblem: String(observation.physical?.adbInterfaceProblem || ""),
      lastObservedAt: new Date().toISOString()
    };
    const existingRow = existing.get(observation.key);
    if (existingRow) {
      existingRow.recovery = recovery;
      continue;
    }
    const previous = lastDevices.find((item) => String(item?.adbSerial || "").toUpperCase() === observation.key) || {};
    const serverDevice = cachedServerDeviceForSerial(observation.serial);
    const row = mergeCachedDeviceScanRow({ adbSerial: observation.serial, state: observation.state }, previous, serverDevice);
    row.adbSerial = observation.serial;
    row.deviceId = row.deviceId || `adb:${observation.serial}`;
    row.state = observation.state;
    row.deviceName = row.deviceName || defaultDeviceName(row);
    row.recovery = recovery;
    devices.push(row);
    existing.set(observation.key, row);
  }
}

function logPnpRecoverySafetyTransition(safety) {
  const circuitKey = [Boolean(safety.circuitOpen), String(safety.circuitReason || "")].join(":");
  if (circuitKey !== lastPnpRecoveryCircuitKey) {
    pnpRecoveryJournal.record({
      type: safety.circuitOpen ? "circuit_opened" : "circuit_closed",
      severity: safety.circuitOpen ? "error" : "success",
      reason: safety.circuitReason || "stable_scans_passed",
      result: safety.circuitUntil || ""
    });
    lastPnpRecoveryCircuitKey = circuitKey;
    schedulePnpRecoveryStateSave();
  }
  const key = [
    safety.circuitOpen,
    safety.circuitReason,
    safety.blockedReason,
    safety.actionableCount,
    safety.unauthorizedCount,
    safety.rescueCanMutate,
    ...(safety.rescueSerials || [])
  ].join(":");
  if (key === lastPnpRecoverySafetyLogKey) return;
  lastPnpRecoverySafetyLogKey = key;
  log("pnp recovery safety", {
    circuitOpen: safety.circuitOpen,
    circuitReason: safety.circuitReason,
    circuitUntil: safety.circuitUntil,
    blockedReason: safety.blockedReason,
    physicalCount: safety.physicalCount,
    adbDeviceCount: safety.adbDeviceCount,
    actionableCount: safety.actionableCount,
    unauthorizedCount: safety.unauthorizedCount,
    automaticActionsLastHour: safety.automaticActionsLastHour,
    rescueCanMutate: safety.rescueCanMutate,
    rescueSerials: safety.rescueSerials || []
  });
}

function publicPnpRecoveryHealth(value = {}) {
  return {
    observedAt: String(value.observedAt || ""),
    circuitOpen: Boolean(value.circuitOpen),
    circuitReason: String(value.circuitReason || ""),
    circuitUntil: String(value.circuitUntil || ""),
    blockedReason: String(value.blockedReason || ""),
    physicalCount: Number(value.physicalCount || 0),
    adbDeviceCount: Number(value.adbDeviceCount || 0),
    actionableCount: Number(value.actionableCount || 0),
    newlyLostCount: Number(value.newlyLostCount || 0),
    unauthorizedCount: Number(value.unauthorizedCount || 0),
    offlineCount: Number(value.offlineCount || 0),
    absentCount: Number(value.absentCount || 0),
    automaticActionsLastHour: Number(value.automaticActionsLastHour || 0),
    maxActionsPerHour: Number(value.maxActionsPerHour || config.pnpMaxAutomaticActionsPerHour || 0),
    acknowledgedActionableCount: Number(value.acknowledgedActionableCount || 0),
    recoveryMode: String(value.recoveryMode || "normal"),
    actionReadyAt: String(value.actionReadyAt || ""),
    postActionWatchCount: Number(value.postActionWatchCount || 0),
    postActionWatchUntil: String(value.postActionWatchUntil || ""),
    rescueSerials: (Array.isArray(value.rescueSerials) ? value.rescueSerials : [])
      .map((serial) => String(serial || "").slice(0, 160))
      .filter(Boolean)
      .slice(0, 20),
    rescueCanMutate: Boolean(value.rescueCanMutate),
    maxAttemptsPerDevice: Number(config.pnpMaxAutomaticAttemptsPerDevice || 5),
    quarantinedCount: [...pnpTargetRecoveryAttempts.values()].filter((item) => item?.quarantinedAt).length,
    inventoryObservedAt: lastSuccessfulPhysicalPnpInventoryAt ? new Date(lastSuccessfulPhysicalPnpInventoryAt).toISOString() : "",
    inventoryFresh: isPhysicalPnpInventoryReady(),
    inventoryError: lastPhysicalPnpInventoryError
  };
}

function currentPnpRecoveryHealth() {
  return {
    ...lastPnpRecoveryHealth,
    queue: buildRecoveryQueue({
      observations: lastDeviceRecoveryObservations,
      attemptsBySerial: pnpTargetRecoveryAttempts,
      devices: [...lastDevices, ...lastServerDevicesById.values()],
      maxAttempts: config.pnpMaxAutomaticAttemptsPerDevice,
      excludedSerials: [...new Set([...screenControlledSerials, ...activeTaskSerials])]
    }).slice(0, 200),
    recentEvents: pnpRecoveryJournal.events(80)
  };
}

function isPhysicalPnpInventoryReady() {
  return Boolean(
    lastSuccessfulPhysicalPnpInventoryAt
    && !lastPhysicalPnpInventoryError
    && Date.now() - lastSuccessfulPhysicalPnpInventoryAt <= Math.max(120_000, config.pnpRescanCooldownSeconds * 2_000)
  );
}

function cachedServerDeviceForSerial(serial) {
  const normalized = String(serial || "").trim().toUpperCase();
  if (!normalized) return {};
  const direct = lastServerDevicesById.get(`adb:${serial}`) || lastServerDevicesById.get(`adb:${normalized}`);
  if (direct) return direct;
  for (const [deviceId, device] of lastServerDevicesById) {
    if (String(deviceId || "").toUpperCase() === `ADB:${normalized}`) return device || {};
  }
  return {};
}

function scheduleNextPnpRecoveryDueWake() {
  const at = Date.now();
  let earliest = Infinity;
  for (const state of pnpTargetRecoveryAttempts.values()) {
    if (state?.quarantinedAt || state?.inProgress) continue;
    const nextRetryAt = Number(state?.nextRetryAt || 0);
    if (nextRetryAt > at && nextRetryAt < earliest) earliest = nextRetryAt;
  }
  if (!Number.isFinite(earliest)) return;
  pnpRecoveryWakeScheduler?.schedule(
    Math.max(1_000, earliest - at),
    "pnp_retry_due"
  );
}

async function discoverPhysicallyPresentAndroidUsbInventory() {
  try {
    return { ok: true, rows: await listPhysicallyPresentAndroidUsbInventory(), error: "" };
  } catch (error) {
    const message = cleanLogText(error?.message || error).slice(0, 300);
    log("pnp physical device discovery failed", message);
    return { ok: false, rows: [], error: message };
  }
}

async function listPhysicallyPresentAndroidUsbInventory() {
  const script = buildPhysicalAndroidUsbInventoryScript(ANDROID_USB_VENDOR_IDS);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeoutMs: 30_000 });
  return parsePhysicalAndroidUsbInventory(cleanLogText(output));
}

async function restartExactPnpDevice(instanceId) {
  const target = String(instanceId || "").trim();
  if (!/^USB\\[A-Za-z0-9&_.\\:-]{4,500}$/i.test(target)) throw new Error("unsafe exact PnP instance id");
  const output = await run("pnputil.exe", ["/restart-device", target], { timeoutMs: 45_000 });
  return { result: cleanLogText(output).slice(-300) || "target_restarted" };
}

async function removeExactPnpDevice(instanceId, options = {}) {
  const output = await run("pnputil.exe", buildRemoveExactPnpArgs(instanceId, options), { timeoutMs: 45_000 });
  return cleanLogText(output).slice(-300) || "target_removed";
}

async function executePnpRecoveryAction(action = {}) {
  const mode = String(action.mode || "");
  if (["restart_adb_interface", "restart_usb_root"].includes(mode)) {
    const restart = await restartExactPnpDevice(action.instanceId);
    if (action.scanInstanceId) await scanExactPnpSubtree(action.scanInstanceId);
    return { result: `${restart.result}; exact_subtree_scanned` };
  }
  if (mode === "recreate_adb_interface") {
    const { target, scan: phoneRoot } = assertDistinctExactUsbInstances(
      action.instanceId,
      action.scanInstanceId,
      "unsafe ADB recreate without distinct phone root"
    );
    const removed = await removeExactPnpDevice(target);
    await scanExactPnpSubtree(phoneRoot);
    return { result: `${removed}; exact_phone_root_scanned` };
  }
  if (mode === "recreate_adb_root") {
    const { target: phoneRoot, scan: upstream } = assertDistinctExactUsbInstances(
      action.instanceId,
      action.scanInstanceId,
      "unsafe ADB root recreate without distinct upstream"
    );
    // PID_6001-style gadgets expose the ADB interface as the phone root. They
    // have no independent child to rebuild, so remove only that exact phone
    // node (without /subtree) and scan its proven upstream. Never remove or
    // restart the upstream Hub itself.
    const removed = await removeExactPnpDevice(phoneRoot);
    await scanExactPnpSubtree(upstream);
    return { result: `${removed}; exact_adb_root_parent_scanned` };
  }
  if (mode === "recreate_usb_composite") {
    const { target: phoneRoot, scan: upstream } = assertDistinctExactUsbInstances(
      action.instanceId,
      action.scanInstanceId,
      "unsafe Composite recreate without distinct upstream node"
    );
    const removed = await removeExactPnpDevice(phoneRoot, { subtree: true });
    await scanExactPnpSubtree(upstream);
    return { result: `${removed}; exact_upstream_scanned` };
  }
  if (mode === "cycle_usb_port") return cycleExactUsbDownstreamPort(action);
  throw new Error(`unsupported PnP recovery action: ${mode}`);
}

async function scanExactPnpSubtree(instanceId) {
  const target = assertExactUsbInstanceId(instanceId);
  const output = await run("pnputil.exe", ["/scan-devices", "/instanceid", target], { timeoutMs: 45_000 });
  return cleanLogText(output).slice(-300) || "exact_subtree_scanned";
}

async function cycleExactUsbDownstreamPort(action = {}) {
  const rootInstanceId = assertExactUsbInstanceId(action.instanceId);
  const upstreamInstanceId = assertExactUsbInstanceId(action.upstreamInstanceId);
  const hubInterfacePath = String(action.hubInterfacePath || "").trim();
  const portNumber = Number(action.portNumber || 0);
  if (!/^\\\\\?\\USB#[A-Za-z0-9&_.#:-]{4,600}#\{f18a0e88-c30c-11d0-8815-00a0c906bed8\}$/i.test(hubInterfacePath)) {
    throw new Error("unsafe exact USB hub interface path");
  }
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 255) throw new Error("unsafe exact USB port number");
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$root='${escapePowerShellSingleQuoted(rootInstanceId)}'`,
    `$upstream='${escapePowerShellSingleQuoted(upstreamInstanceId)}'`,
    `$hubPath='${escapePowerShellSingleQuoted(hubInterfacePath)}'`,
    `$port=[uint32]${portNumber}`,
    "$props=Get-PnpDeviceProperty -InstanceId $root -ErrorAction Stop",
    "$address=[uint32](($props | Where-Object KeyName -eq 'DEVPKEY_Device_Address').Data)",
    "$parent=[string](($props | Where-Object KeyName -eq 'DEVPKEY_Device_Parent').Data)",
    "if($address -ne $port -or $parent -ne $upstream){throw ('exact USB mapping changed: address='+$address+' parent='+$parent)}",
    "Add-Type -TypeDefinition @'\nusing System;\nusing System.ComponentModel;\nusing System.Runtime.InteropServices;\npublic static class PhoneCloudExactUsbPortCycle {\n  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr templateFile);\n  [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool DeviceIoControl(IntPtr device, uint code, IntPtr input, int inputSize, IntPtr output, int outputSize, out int returned, IntPtr overlapped);\n  [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);\n  public static string Run(string hubPath, uint port) {\n    const uint GENERIC_WRITE=0x40000000, FILE_SHARE_WRITE=0x00000002, OPEN_EXISTING=3, IOCTL_USB_HUB_CYCLE_PORT=0x00220444;\n    IntPtr handle=CreateFile(hubPath,GENERIC_WRITE,FILE_SHARE_WRITE,IntPtr.Zero,OPEN_EXISTING,0,IntPtr.Zero);\n    if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(),\"CreateFile hub failed\");\n    IntPtr buffer=Marshal.AllocHGlobal(8);\n    try {\n      Marshal.WriteInt32(buffer,0,unchecked((int)port)); Marshal.WriteInt32(buffer,4,0); int returned;\n      if(!DeviceIoControl(handle,IOCTL_USB_HUB_CYCLE_PORT,buffer,8,buffer,8,out returned,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(),\"DeviceIoControl cycle failed\");\n      return \"exact_port_cycled returned=\"+returned+\" usbdStatus=0x\"+Marshal.ReadInt32(buffer,4).ToString(\"X8\");\n    } finally { Marshal.FreeHGlobal(buffer); CloseHandle(handle); }\n  }\n}\n'@",
    "[PhoneCloudExactUsbPortCycle]::Run($hubPath,$port)"
  ].join("; ");
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeoutMs: 45_000 });
  return { result: cleanLogText(output).slice(-300) || "exact_port_cycled" };
}

function escapePowerShellSingleQuoted(value) {
  return String(value || "").replaceAll("'", "''");
}

async function hydrateStaticDeviceInfo(devices) {
  const targets = devices.filter((device) => {
    if (device.state !== "device") return false;
    if (isDeviceSerialReserved(device.adbSerial)) return false;
    const needsStatic = !device.model || !device.manufacturer || !device.brand || !device.androidVersion;
    const needsSim = !initialSimReadBySerial.has(device.adbSerial) && (!Array.isArray(device.sims) || !device.sims.length);
    return needsStatic || needsSim;
  });
  if (!targets.length) return;
  await runLimited(targets, config.staticDeviceInfoConcurrency, async (device) => {
    const serial = device.adbSerial;
    const needsStatic = !device.model || !device.manufacturer || !device.brand || !device.androidVersion;
    const needsSim = !initialSimReadBySerial.has(serial) && (!Array.isArray(device.sims) || !device.sims.length);
    const jobs = [];
    if (needsStatic) {
      jobs.push((async () => {
        const [model, manufacturer, brand, androidVersion] = await Promise.allSettled([
          adb(serial, ["shell", "getprop", "ro.product.model"], { timeoutMs: 4_000 }),
          adb(serial, ["shell", "getprop", "ro.product.manufacturer"], { timeoutMs: 4_000 }),
          adb(serial, ["shell", "getprop", "ro.product.brand"], { timeoutMs: 4_000 }),
          adb(serial, ["shell", "getprop", "ro.build.version.release"], { timeoutMs: 4_000 })
        ]);
        device.model = valueOf(model) || device.model || "";
        device.manufacturer = valueOf(manufacturer) || device.manufacturer || "";
        device.brand = valueOf(brand) || device.brand || device.manufacturer || "";
        device.androidVersion = valueOf(androidVersion) || device.androidVersion || "";
      })());
    }
    if (needsSim) {
      jobs.push(readSimInfo(serial)
        .then((sims) => { device.sims = sims; })
        .finally(() => initialSimReadBySerial.add(serial)));
    }
    const settled = await Promise.allSettled(jobs);
    for (const item of settled) {
      if (item.status === "rejected") {
        log("static device info skipped", { serial, error: cleanLogText(item.reason?.message || item.reason).slice(0, 300) });
      }
    }
    device.deviceName = device.deviceName || defaultDeviceName(device);
  });
}

async function refreshBatteryLevels(devices) {
  const now = Date.now();
  const targets = devices.filter((device) => {
    if (device.state !== "device") return false;
    if (isDeviceSerialReserved(device.adbSerial)) return false;
    const last = lastBatteryRefreshBySerial.get(device.adbSerial) || 0;
    return !last || now - last >= config.batteryRefreshIntervalSeconds * 1000 || device.batteryLevel == null;
  });
  if (!targets.length) return;
  await runLimited(targets, config.batteryRefreshConcurrency, async (device) => {
    const serial = device.adbSerial;
    try {
      const output = await adb(serial, ["shell", "dumpsys", "battery"], { timeoutMs: 3_000, maxBuffer: 128 * 1024 });
      const level = parseBattery(output);
      if (level != null) device.batteryLevel = level;
      lastBatteryRefreshBySerial.set(serial, Date.now());
    } catch (error) {
      log("battery refresh skipped", { serial, error: cleanLogText(error?.message || error).slice(0, 300) });
      lastBatteryRefreshBySerial.set(serial, Date.now());
    }
  });
}

async function refreshSmsRelayHealth(devices) {
  const now = Date.now();
  const targets = [];
  for (const device of Array.isArray(devices) ? devices : []) {
    const serial = String(device?.adbSerial || "").trim();
    if (!serial || device.state !== "device") continue;
    const cached = lastSmsRelayHealthBySerial.get(serial);
    if (cached) device.smsRelay = cached.health;
    if (isDeviceSerialReserved(serial)) continue;
    if (cached && now - cached.checkedAtMs < 60_000) continue;
    targets.push(device);
  }

  await runLimited(targets, 10, async (device) => {
    const serial = String(device.adbSerial || "").trim();
    const checkedAt = new Date().toISOString();
    let health;
    try {
      const output = await adb(serial, buildSmsRelayHealthArgs(), {
        timeoutMs: 5_000,
        maxBuffer: 128 * 1024
      });
      health = { ...parseSmsRelayHealth(output, checkedAt), status: "ok" };
    } catch (error) {
      const message = cleanLogText(error?.message || error).slice(0, 200);
      if (/no content provider|provider.*not found|unknown uri/i.test(message)) {
        health = { ...missingSmsRelayHealth(checkedAt), status: "not_installed" };
      } else {
        const previous = lastSmsRelayHealthBySerial.get(serial)?.health || missingSmsRelayHealth(checkedAt);
        health = { ...previous, checkedAt, status: "unavailable", error: message };
      }
    }

    device.smsRelay = health;
    lastSmsRelayHealthBySerial.set(serial, { health, checkedAtMs: Date.now() });
    if (usesSmsRelayManagedSmsPath(health)) {
      // Installation is the ownership boundary: stop any legacy Provider or
      // notification read which was already in flight for this exact phone.
      backgroundSmsAbortControllersBySerial.get(serial)?.abort();
      backgroundSmsNotificationAbortControllersBySerial.get(serial)?.abort();
    }
    if (!shouldRecoverSmsRelay(health) || isDeviceSerialReserved(serial)) return;
    const lastRecoveryAt = lastSmsRelayRecoveryBySerial.get(serial) || 0;
    if (Date.now() - lastRecoveryAt < 60_000) return;
    lastSmsRelayRecoveryBySerial.set(serial, Date.now());
    try {
      await adb(serial, buildSmsRelayRecoverArgs(), { timeoutMs: 8_000, maxBuffer: 64 * 1024 });
      log("sms relay exact recovery requested", { adbSerial: serial });
    } catch (error) {
      log("sms relay exact recovery failed", {
        adbSerial: serial,
        error: cleanLogText(error?.message || error).slice(0, 200)
      });
    }
  });
}

async function runLimited(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Number(limit) || 1);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      await worker(list[index], index);
    }
  });
  await Promise.all(runners);
}

async function syncAdbSmsLibraries(devices) {
  if (!config.smsLibrarySyncEnabled) return;
  const now = Date.now();
  const targets = [];
  for (const device of devices) {
    if (device.state !== "device") continue;
    if (isDeviceSerialReserved(device.adbSerial)) continue;
    if (usesSmsRelayManagedSmsPath(device.smsRelay)) continue;
    if (backgroundSmsNotificationAbortControllersBySerial.has(device.adbSerial)) continue;
    const lastSyncedAt = lastSmsLibrarySyncBySerial.get(device.adbSerial) || 0;
    if (now - lastSyncedAt < config.smsLibrarySyncIntervalSeconds * 1000) continue;
    lastSmsLibrarySyncBySerial.set(device.adbSerial, now);
    targets.push(device);
  }
  await runLimited(targets, config.smsLibraryBackgroundSyncConcurrency, async (device) => {
    if (isDeviceSerialReserved(device.adbSerial)
      || pnpScreenCoordinator.activeSerials.includes(String(device.adbSerial || "").trim().toUpperCase())) {
      return;
    }
    const controller = new AbortController();
    backgroundSmsAbortControllersBySerial.set(device.adbSerial, controller);
    try {
      const result = await syncAdbSmsLibrary(device, { signal: controller.signal });
      log("sms library synced", result);
    } catch (error) {
      if (isScreenPriorityCancellation(error)) {
        log("sms library background sync preempted", { adbSerial: device.adbSerial });
        return;
      }
      log("sms library device sync failed", { adbSerial: device.adbSerial, error: error.message });
    } finally {
      if (backgroundSmsAbortControllersBySerial.get(device.adbSerial) === controller) {
        backgroundSmsAbortControllersBySerial.delete(device.adbSerial);
      }
    }
  });
}

async function syncAdbSmsNotifications(devices) {
  const now = Date.now();
  const targets = [];
  for (const device of Array.isArray(devices) ? devices : []) {
    if (device.state !== "device" || isDeviceSerialReserved(device.adbSerial)) continue;
    if (usesSmsRelayManagedSmsPath(device.smsRelay)) continue;
    if (!isSmsNotificationFallbackEnabledForSerial(device.adbSerial)) continue;
    if (backgroundSmsAbortControllersBySerial.has(device.adbSerial)) continue;
    const lastSyncedAt = lastSmsNotificationSyncBySerial.get(device.adbSerial) || 0;
    if (!config.smsNotificationContinuousScanEnabled
      && now - lastSyncedAt < config.smsNotificationBackgroundIntervalSeconds * 1000) continue;
    lastSmsNotificationSyncBySerial.set(device.adbSerial, now);
    targets.push(device);
  }
  const summary = {
    targetCount: targets.length,
    ok: 0,
    unsupported: 0,
    failed: 0,
    preempted: 0,
    received: 0,
    sent: 0,
    replaySkipped: 0
  };
  await runLimited(targets, config.smsNotificationBackgroundConcurrency, async (device) => {
    if (isDeviceSerialReserved(device.adbSerial)
      || pnpScreenCoordinator.activeSerials.includes(String(device.adbSerial || "").trim().toUpperCase())) {
      summary.preempted += 1;
      return;
    }
    const controller = new AbortController();
    backgroundSmsNotificationAbortControllersBySerial.set(device.adbSerial, controller);
    try {
      const result = await syncAdbSmsNotification(device, { signal: controller.signal });
      summary[result.status === "unsupported" ? "unsupported" : "ok"] += 1;
      summary.received += Number(result.received || 0);
      summary.sent += Number(result.sent || 0);
      summary.replaySkipped += Number(result.replaySkipped || 0);
      if (result.status !== "ok" || Number(result.sent || 0) > 0) {
        log("sms notification fallback device result", result);
      }
    } catch (error) {
      if (isScreenPriorityCancellation(error)) {
        summary.preempted += 1;
        return;
      }
      summary.failed += 1;
      log("sms notification fallback device skipped", {
        adbSerial: device.adbSerial,
        error: cleanLogText(error?.message || error).slice(0, 180)
      });
    } finally {
      if (backgroundSmsNotificationAbortControllersBySerial.get(device.adbSerial) === controller) {
        backgroundSmsNotificationAbortControllersBySerial.delete(device.adbSerial);
      }
    }
  });
  return summary;
}

async function discoverDefaultSmsPackage(serial, options = {}) {
  const cached = defaultSmsPackageBySerial.get(serial);
  if (cached && Date.now() - cached.checkedAtMs < config.smsNotificationPackageCacheSeconds * 1000) {
    return cached.packageName;
  }
  let packageName = "";
  try {
    packageName = parseDefaultSmsRoleHolders(await adb(serial, buildSmsRoleHolderArgs(), {
      timeoutMs: 5_000,
      maxBuffer: 64 * 1024,
      signal: options.signal
    }));
  } catch {
    // Android versions without RoleManager fall through to the legacy setting.
  }
  if (!packageName) {
    try {
      packageName = parseLegacyDefaultSmsPackage(await adb(serial, buildLegacyDefaultSmsPackageArgs(), {
        timeoutMs: 5_000,
        maxBuffer: 64 * 1024,
        signal: options.signal
      }));
    } catch {
      packageName = "";
    }
  }
  if (!packageName) {
    try {
      packageName = parseResolvedDefaultSmsPackage(await adb(serial, buildDefaultSmsSendToResolveArgs(), {
        timeoutMs: 5_000,
        maxBuffer: 64 * 1024,
        signal: options.signal
      }));
    } catch {
      packageName = "";
    }
  }
  if (packageName) defaultSmsPackageBySerial.set(serial, { packageName, checkedAtMs: Date.now() });
  else defaultSmsPackageBySerial.delete(serial);
  return packageName;
}

async function discoverSmsNotificationPackageProfile(serial, options = {}) {
  const cached = smsNotificationPackageProfileBySerial.get(serial);
  if (cached && Date.now() - cached.checkedAtMs < config.smsNotificationPackageCacheSeconds * 1000) {
    return cached;
  }
  const packageName = await discoverDefaultSmsPackage(serial, options);
  if (!packageName) return { packageName: "", packageNames: [], checkedAtMs: Date.now() };

  try {
    const installedOutput = await adb(serial, buildSmsRelatedPackageListArgs(packageName), {
      timeoutMs: 5_000,
      maxBuffer: 256 * 1024,
      signal: options.signal
    });
    const installedPackages = parseInstalledPackageNames(installedOutput);
    const candidates = installedPackages.filter((candidate) => (
      candidate === packageName || candidate.startsWith(`${packageName}.`)
    ));
    if (!candidates.includes(packageName)) candidates.unshift(packageName);

    const evidenceByPackage = new Map();
    for (const candidate of candidates) {
      const packageOutput = await adb(serial, buildSmsPackageDumpArgs(candidate), {
        timeoutMs: 5_000,
        maxBuffer: 2 * 1024 * 1024,
        signal: options.signal
      });
      evidenceByPackage.set(candidate, parseSmsPackageTrustEvidence(packageOutput));
    }
    const packageNames = selectTrustedSmsNotificationPackages(packageName, installedPackages, evidenceByPackage);
    const profile = { packageName, packageNames, checkedAtMs: Date.now() };
    const previousNames = Array.isArray(cached?.packageNames) ? cached.packageNames : [];
    if (packageNames.join(",") !== previousNames.join(",")) {
      log("sms notification trusted package profile updated", {
        adbSerial: serial,
        packageName,
        packageNames
      });
    }
    smsNotificationPackageProfileBySerial.set(serial, profile);
    return profile;
  } catch (error) {
    // Keep the exact default package usable, but do not cache a degraded
    // profile: a transient PackageManager timeout must retry next cycle.
    log("sms notification package profile discovery degraded", {
      adbSerial: serial,
      packageName,
      error: cleanLogText(error?.message || error).slice(0, 200)
    });
    return { packageName, packageNames: [packageName], checkedAtMs: Date.now() };
  }
}

async function syncAdbSmsNotification(device, options = {}) {
  const serial = String(device?.adbSerial || "").trim();
  if (!serial) throw new Error("adbSerial is required");
  const deviceId = `adb:${serial}`;
  if (usesSmsRelayManagedSmsPath(device.smsRelay)) {
    return { adbSerial: serial, deviceId, enabled: false, status: "managed_by_sms_relay", received: 0, sent: 0 };
  }
  const packageProfile = await discoverSmsNotificationPackageProfile(serial, options);
  const packageName = packageProfile.packageName;
  if (!packageName) {
    return { adbSerial: serial, deviceId, enabled: true, status: "unsupported", packageName: "", received: 0, sent: 0 };
  }
  const output = await adb(serial, buildSmsNotificationDumpArgs(packageName), {
    timeoutMs: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    signal: options.signal
  });
  throwIfScreenPriorityCancellation(options.signal);
  const messages = parseSmsNotificationDump(output, {
    packageName,
    packageNames: packageProfile.packageNames,
    nowMs: Date.now(),
    maxAgeMs: config.smsNotificationHistoryMaxAgeHours * 60 * 60_000
  });
  let uploadedKeys = uploadedSmsNotificationKeysBySerial.get(serial);
  if (!uploadedKeys) {
    uploadedKeys = new Set();
    uploadedSmsNotificationKeysBySerial.set(serial, uploadedKeys);
  }
  const pendingMessages = selectUnsentSmsNotifications(messages, uploadedKeys, {
    forceFull: options.forceFull === true
  });
  let sent = 0;
  for (let index = 0; index < pendingMessages.length; index += config.smsLibraryBatchSize) {
    const batch = pendingMessages.slice(index, index + config.smsLibraryBatchSize);
    await deviceApi(`/api/v1/devices/${encodeURIComponent(deviceId)}/sms-library/batch`, {
      method: "POST",
      body: { source: "windows-agent-notification", messages: batch }
    });
    for (const message of batch) {
      const key = String(message?.messageKey || "").trim();
      if (key) uploadedKeys.add(key);
    }
    while (uploadedKeys.size > 2_000) uploadedKeys.delete(uploadedKeys.values().next().value);
    sent += batch.length;
  }
  lastSmsNotificationSyncBySerial.set(serial, Date.now());
  return {
    adbSerial: serial,
    deviceId,
    enabled: true,
    status: "ok",
    packageName,
    packageNames: packageProfile.packageNames,
    received: messages.length,
    replaySkipped: Math.max(0, messages.length - pendingMessages.length),
    sent
  };
}

function rememberServerDevices(devices) {
  lastServerDevicesById = indexCachedDevices(devices);
}

function deviceScanCachePath() {
  return path.join(dataDir, "device-scan-cache.json");
}

async function loadDeviceScanCache() {
  try {
    const devices = JSON.parse(await fs.readFile(deviceScanCachePath(), "utf8"));
    return indexCachedDevices(devices);
  } catch (error) {
    if (error.code !== "ENOENT") log("device scan cache load failed", error.message);
    return new Map();
  }
}

async function saveDeviceScanCache(devices) {
  const target = deviceScanCachePath();
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(Array.isArray(devices) ? devices : []), { mode: 0o600 });
  await fs.rename(tmp, target);
}

async function syncAdbSmsLibrary(device, options = {}) {
  if (usesSmsRelayManagedSmsPath(device?.smsRelay)) {
    return {
      adbSerial: device?.adbSerial || "",
      deviceId: device?.adbSerial ? `adb:${device.adbSerial}` : "",
      status: "managed_by_sms_relay",
      queried: 0,
      scanned: 0,
      sent: 0
    };
  }
  const columns = ["_id", "thread_id", "address", "body", "date", "date_sent", "type", "read", "seen", "status", "locked", "sub_id"];
  const deviceId = `adb:${device.adbSerial}`;
  const serverDevice = lastServerDevicesById.get(deviceId);
  reconcileSmsCursorWithServer(device.adbSerial, serverDevice);
  const cursor = smsSyncCursors[device.adbSerial] || {};
  const where = !options.forceFull && config.smsLibraryIncrementalSync && cursor.lastSmsId
    ? `_id > ${Number(cursor.lastSmsId)}`
    : "";
  let messages;
  let incremental = Boolean(where);
  let queried = 0;
  let fallbackMode = "";
  let fallbackReason = "";
  try {
    messages = parseSmsContentQuery(await querySmsContent(device.adbSerial, columns, where, options), columns);
  } catch (error) {
    fallbackMode = "projection";
    fallbackReason = cleanLogText(error?.message || error).slice(0, 300);
    const fallbackColumns = ["_id", "thread_id", "address", "body", "date", "date_sent", "type", "read", "seen", "status"];
    try {
      messages = parseSmsContentQuery(await querySmsContent(device.adbSerial, fallbackColumns, where, options), fallbackColumns);
    } catch (fallbackError) {
      if (!where) throw fallbackError;
      incremental = false;
      fallbackMode = "full";
      fallbackReason = cleanLogText(fallbackError?.message || fallbackError).slice(0, 300);
      messages = parseSmsContentQuery(await querySmsContent(device.adbSerial, fallbackColumns, "", options), fallbackColumns);
    }
  }
  queried = messages.length;
  messages = await hydrateSmsSlotIndexes(device, messages, options);
  if (config.smsLibraryIncrementalSync && cursor.lastSmsId) {
    if (!options.forceFull) {
      messages = messages.filter((message) => Number(message.smsId || 0) > Number(cursor.lastSmsId || 0));
    }
  }
  throwIfScreenPriorityCancellation(options.signal);
  let sent = 0;
  const cursorPayload = buildSmsSyncCursorPayload(device.adbSerial, messages, { scanned: messages.length, incremental });
  if (!messages.length) {
    await deviceApi(`/api/v1/devices/${encodeURIComponent(deviceId)}/sms-library/batch`, {
      method: "POST",
      body: {
        source: "windows-agent-adb",
        cursor: cursorPayload,
        messages: []
      }
    });
  }
  for (let index = 0; index < messages.length; index += config.smsLibraryBatchSize) {
    if (options.signal?.aborted) throw screenPriorityCancellationError();
    const batch = messages.slice(index, index + config.smsLibraryBatchSize);
    await deviceApi(`/api/v1/devices/${encodeURIComponent(deviceId)}/sms-library/batch`, {
      method: "POST",
      body: {
        source: "windows-agent-adb",
        cursor: cursorPayload,
        messages: batch
      }
    });
    sent += batch.length;
  }
  updateSmsSyncCursor(device.adbSerial, messages, { incremental, scanned: messages.length });
  await saveSmsSyncCursors();
  return {
    adbSerial: device.adbSerial,
    deviceId,
    incremental,
    queried,
    scanned: messages.length,
    sent,
    fallbackMode,
    fallbackReason,
    forceFull: Boolean(options.forceFull),
    cursor: smsSyncCursors[device.adbSerial]
  };
}

async function hydrateSmsSlotIndexes(device, messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.some((message) => Number.isInteger(Number(message?.subscriptionId)))) return list;

  const serial = String(device?.adbSerial || "").trim();
  const cached = smsSubscriptionSlotMapBySerial.get(serial);
  let subscriptionMap = cached && Date.now() - cached.checkedAtMs < 5 * 60_000
    ? cached.map
    : null;

  if (!subscriptionMap) {
    try {
      const output = await adb(serial, ["shell", "dumpsys", "isub"], {
        timeoutMs: 8_000,
        maxBuffer: 2 * 1024 * 1024,
        signal: options.signal
      });
      subscriptionMap = parseSubscriptionSlotMap(output);
      smsSubscriptionSlotMapBySerial.set(serial, { map: subscriptionMap, checkedAtMs: Date.now() });
      if (!subscriptionMap.size) {
        log("sms subscription map returned no rows", { adbSerial: serial });
      }
    } catch (error) {
      log("sms subscription map unavailable", {
        adbSerial: serial,
        error: cleanLogText(error?.message || error).slice(0, 300)
      });
      subscriptionMap = new Map();
    }
  }

  return assignSmsSlotIndexes(list, device?.sims || [], subscriptionMap);
}

function reconcileSmsCursorWithServer(serial, serverDevice) {
  const cursor = smsSyncCursors[serial] || {};
  const serverCount = Number(serverDevice?.smsLibraryCount ?? NaN);
  const lastSmsId = Number(cursor.lastSmsId || 0);
  if (!Number.isFinite(serverCount) || !lastSmsId) return;
  if (serverCount <= 1 && lastSmsId > 50) {
    log("sms cursor reset for server backfill", {
      adbSerial: serial,
      serverSmsLibraryCount: serverCount,
      lastSmsId
    });
    delete smsSyncCursors[serial];
    lastSmsLibrarySyncBySerial.delete(serial);
  }
}

async function querySmsContent(serial, columns, where = "", options = {}) {
  const args = buildSmsContentQueryArgs(columns, where);
  return await adb(serial, args, { timeoutMs: 120_000, maxBuffer: 50 * 1024 * 1024, signal: options.signal });
}

function parseSmsContentQuery(output, columns) {
  return String(output || "")
    .split(/(?=^Row:\s*\d+\s+)/gm)
    .map((line) => parseSmsContentLine(line, columns))
    .filter(Boolean)
    .map((row) => {
      const smsId = stringField(row._id);
      const date = numberField(row.date);
      const dateSent = numberField(row.date_sent);
      return {
        messageKey: smsId ? `sms:${smsId}` : "",
        smsId,
        threadId: stringField(row.thread_id),
        box: smsBoxName(numberField(row.type)),
        type: numberField(row.type),
        address: stringField(row.address),
        body: stringField(row.body),
        date,
        messageAt: date,
        dateSent,
        read: numberField(row.read) === 1,
        seen: numberField(row.seen) === 1,
        status: stringField(row.status),
        locked: numberField(row.locked) === 1,
        subscriptionId: row.sub_id === undefined ? undefined : numberField(row.sub_id),
        source: "windows-agent-adb"
      };
    })
    .filter((message) => message.messageKey && message.date);
}

function parseSmsContentLine(line, columns) {
  const text = String(line || "").replace(/^Row:\s*\d+\s*/, "");
  if (!text.trim()) return null;
  const row = {};
  let cursor = 0;
  for (let index = 0; index < columns.length; index += 1) {
    const key = columns[index];
    const marker = `${key}=`;
    const markerIndex = text.indexOf(marker, cursor);
    if (markerIndex < 0) {
      row[key] = "";
      continue;
    }
    const valueStart = markerIndex + marker.length;
    const nextKey = columns[index + 1];
    const nextMarker = nextKey ? `, ${nextKey}=` : "";
    const valueEnd = nextMarker ? text.indexOf(nextMarker, valueStart) : -1;
    row[key] = valueEnd >= 0 ? text.slice(valueStart, valueEnd) : text.slice(valueStart);
    cursor = valueEnd >= 0 ? valueEnd + 2 : text.length;
  }
  return row;
}

function smsBoxName(type) {
  if (type === 1) return "inbox";
  if (type === 2) return "sent";
  if (type === 3) return "draft";
  if (type === 4) return "outbox";
  if (type === 5) return "failed";
  if (type === 6) return "queued";
  return "unknown";
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value);
}

function numberField(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function smsCursorPath() {
  return path.join(dataDir, "sms-cursors.json");
}

async function loadSmsSyncCursors() {
  try {
    const parsed = JSON.parse(await fs.readFile(smsCursorPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    log("sms cursor load failed", error.message);
    return {};
  }
}

async function saveSmsSyncCursors() {
  await writeSmsSyncCursors(smsSyncCursors);
}

function buildSmsSyncCursorPayload(serial, messages, meta = {}) {
  const next = nextSmsSyncCursor(serial, messages, meta);
  return {
    ...next,
    syncedAt: new Date().toISOString()
  };
}

function updateSmsSyncCursor(serial, messages, meta = {}) {
  smsSyncCursors[serial] = buildSmsSyncCursorPayload(serial, messages, meta);
}

function nextSmsSyncCursor(serial, messages, meta = {}) {
  const current = smsSyncCursors[serial] || {};
  let lastSmsId = Number(current.lastSmsId || 0);
  let lastMessageAt = Number(current.lastMessageAt || 0);
  for (const message of Array.isArray(messages) ? messages : []) {
    const smsId = Number(message.smsId || 0);
    const messageAt = Number(message.date || message.messageAt || 0);
    if (Number.isFinite(smsId) && smsId > lastSmsId) lastSmsId = smsId;
    if (Number.isFinite(messageAt) && messageAt > lastMessageAt) lastMessageAt = messageAt;
  }
  return {
    lastSmsId,
    lastMessageAt,
    scanned: Number(meta.scanned || 0),
    incremental: Boolean(meta.incremental),
    updatedAt: new Date().toISOString()
  };
}

async function readSimInfo(serial) {
  const cached = simInfoCacheBySerial.get(serial);
  if (cached && Date.now() - cached.checkedAtMs < 60_000) return cached.sims;
  const cachedSims = cached?.sims || [];
  try {
    const output = await adb(serial, ["shell", "content", "query", "--uri", "content://telephony/siminfo"], { timeoutMs: 8_000, maxBuffer: 512 * 1024 });
    const sims = parseSimInfoContent(output);
    if (sims.length) return rememberSimInfo(serial, sims);
    log("siminfo content query returned no rows, falling back to telephony.registry", { serial });
    try {
      const fallbackOutput = await adb(serial, ["shell", "dumpsys", "telephony.registry"], { timeoutMs: 5_000, maxBuffer: 512 * 1024 });
      return rememberSimInfo(serial, parseTelephonyRegistrySimInfo(fallbackOutput));
    } catch (fallbackError) {
      log("siminfo fallback skipped", { serial, error: cleanLogText(fallbackError?.message || fallbackError).slice(0, 300) });
      return rememberSimInfo(serial, cachedSims);
    }
  } catch (error) {
    const message = String(error?.message || "");
    log("siminfo content query failed, falling back to telephony.registry", { serial, error: cleanLogText(message).slice(0, 300) });
    try {
      const output = await adb(serial, ["shell", "dumpsys", "telephony.registry"], { timeoutMs: 5_000, maxBuffer: 512 * 1024 });
      return rememberSimInfo(serial, parseTelephonyRegistrySimInfo(output));
    } catch (fallbackError) {
      log("siminfo fallback skipped", { serial, error: cleanLogText(fallbackError?.message || fallbackError).slice(0, 300) });
      return rememberSimInfo(serial, cachedSims);
    }
  }
}

function rememberSimInfo(serial, sims) {
  const normalized = Array.isArray(sims) ? sims : [];
  simInfoCacheBySerial.set(serial, { sims: normalized, checkedAtMs: Date.now() });
  return normalized;
}

function parseSimInfoContent(output) {
  return String(output || "")
    .split(/(?=^Row:\s*\d+\s+)/gm)
    .map((line) => line.replace(/^Row:\s*\d+\s*/, ""))
    .filter((line) => line.trim())
    .map((line) => {
      const subscriptionId = numberField(contentField(line, "_id"));
      const slotIndex = numberField(contentField(line, "sim_id"));
      if (!Number.isFinite(slotIndex) || slotIndex < 0) return null;
      const phoneNumber = contentField(line, "number");
      return {
        subscriptionId: Number.isFinite(subscriptionId) ? subscriptionId : slotIndex,
        slotIndex,
        carrierName: contentField(line, "carrier_name") || contentField(line, "display_name"),
        phoneNumber,
        label: contentField(line, "display_name") || "SIM " + (slotIndex + 1),
        enabled: true
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.slotIndex) - Number(b.slotIndex));
}

function parseTelephonyRegistrySimInfo(output) {
  const simsBySlot = new Map();
  const text = String(output || "");
  const patterns = [
    /notify(?:Vivo)?ServiceStateFor(?:Subscriber|PhoneId):[^\n]*?subId=([0-9]+)[^\n]*?phoneId=([0-9]+)[^\n]*?mOperatorAlphaLong=([^,}]+)[^\n]*?mOperatorAlphaShort=([^,}]+)/g,
    /phoneId=([0-9]+)[^\n]*?subId=([0-9]+)[^\n]*?mOperatorAlphaLong=([^,}]+)[^\n]*?mOperatorAlphaShort=([^,}]+)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const first = numberField(match[1]);
      const second = numberField(match[2]);
      const phoneIdFirst = /phoneId=/.test(match[0].split("subId=")[0] || "");
      const slotIndex = phoneIdFirst ? first : second;
      const subscriptionId = phoneIdFirst ? second : first;
      const carrierName = cleanCarrierName(match[3]) || cleanCarrierName(match[4]);
      if (!Number.isFinite(slotIndex) || slotIndex < 0 || !carrierName) continue;
      if (/^(null|unknown|--|-1)$/i.test(carrierName)) continue;
      simsBySlot.set(slotIndex, {
        subscriptionId: Number.isFinite(subscriptionId) ? subscriptionId : slotIndex,
        slotIndex,
        carrierName,
        phoneNumber: "",
        label: `SIM ${slotIndex + 1}`,
        enabled: true
      });
    }
  }
  if (!simsBySlot.size) {
    const seenCarriers = new Set();
    for (const match of text.matchAll(/^\s*mServiceState=\{[^\n]*?mOperatorAlphaLong=([^,}]+)[^\n]*?mOperatorAlphaShort=([^,}]+)/gm)) {
      const carrierName = cleanCarrierName(match[1]) || cleanCarrierName(match[2]);
      if (!carrierName || seenCarriers.has(carrierName)) continue;
      const slotIndex = seenCarriers.size;
      seenCarriers.add(carrierName);
      simsBySlot.set(slotIndex, {
        subscriptionId: slotIndex + 1,
        slotIndex,
        carrierName,
        phoneNumber: "",
        label: `SIM ${slotIndex + 1}`,
        enabled: true
      });
      if (seenCarriers.size >= 4) break;
    }
  }
  return [...simsBySlot.values()].sort((a, b) => Number(a.slotIndex) - Number(b.slotIndex));
}

function cleanCarrierName(value) {
  return String(value || "").trim().replace(/^(null|nullnull|unknown)$/i, "");
}

function contentField(line, key) {
  const pattern = "(?:^|, )" + String(key) + "=([\\s\\S]*?)(?=, [a-zA-Z_][\\w]*=|$)";
  const match = String(line || "").match(new RegExp(pattern));
  return match ? match[1].trim() : "";
}
function parseAdbDevices(output) {
  return String(output || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const adbSerial = parts[0];
      const state = parts[1] || "unknown";
      const attrs = {};
      for (const part of parts.slice(2)) {
        const index = part.indexOf(":");
        if (index > 0) attrs[part.slice(0, index)] = part.slice(index + 1);
      }
      return {
        adbSerial,
        state,
        product: attrs.product || "",
        model: attrs.model || "",
        transportId: attrs.transport_id || ""
      };
    });
}

async function adbVersion() {
  const output = await run(config.adbPath, ["version"]);
  return output.split(/\r?\n/).find((line) => line.includes("Android Debug Bridge")) || output.trim();
}

async function adb(serial, args, options = {}) {
  if (!serial) throw new Error("adbSerial is required");
  const actor = deviceActors.get(serial);
  const operation = async () => {
    if (screenControlledSerials.has(serial) && !options.allowScreenControl) throw screenPriorityCancellationError();
    const finish = serialAdbActivity.begin(serial);
    try {
      return await run(config.adbPath, ["-s", serial, ...args], options);
    } finally {
      finish();
    }
  };
  const queueOptions = {
    signal: options.signal,
    label: String(options.actorLabel || adbOperationLabel(args)).slice(0, 80)
  };
  if (options.actorPriority === "interactive") return actor.runInteractiveAdb(operation, queueOptions);
  const activeTask = [...activeTasksById.values()].find((task) => String(task?.adbSerial || "") === String(serial));
  if (activeTask?.type === "sms_sync_now" || activeTask?.type === "screen_gallery_import") {
    return actor.runInteractiveAdb(operation, queueOptions);
  }
  if (activeTask) return actor.runAutomationAdb(operation, queueOptions);
  return actor.runBackgroundAdb(operation, queueOptions);
}

function adbOperationLabel(args = []) {
  const command = String(args[0] || "adb").slice(0, 30);
  const subcommand = command === "shell" ? String(args[1] || "command").slice(0, 30) : "";
  return subcommand ? `adb:${command}:${subcommand}` : `adb:${command}`;
}

async function api(pathname, options = {}) {
  return await serverJsonRequest(pathname, {
    ...options,
    token: config.agentToken
  });
}

async function deviceApi(pathname, options = {}) {
  return await serverJsonRequest(pathname, {
    ...options,
    token: config.deviceToken
  });
}

async function serverJsonRequest(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || config.apiTimeoutSeconds * 1000));
  try {
    const response = await fetch(`${config.serverBaseUrl}${pathname}`, {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${options.token || config.agentToken}`,
        "content-type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new Error(`HTTP request timeout while reading response: ${pathname}`);
      }
      throw new Error(`HTTP response JSON invalid: ${pathname}: ${error?.message || String(error)}`);
    }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`HTTP request timeout: ${pathname}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeoutMs || 30_000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      windowsHide: true,
      shell: options.shell ?? needsShell(file),
      cwd: options.cwd,
      env: options.env,
      signal: options.signal
    }, (error, stdout, stderr) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason instanceof Error ? options.signal.reason : screenPriorityCancellationError());
        return;
      }
      if (error) {
        error.stdout = String(stdout || "");
        error.stderr = String(stderr || "");
        error.message = `${error.message}${stderr ? `\n${stderr}` : ""}`;
        reject(error);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function runBuffer(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeoutMs || 30_000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      windowsHide: true,
      shell: options.shell ?? needsShell(file),
      cwd: options.cwd,
      env: options.env,
      encoding: "buffer"
    }, (error, stdout, stderr) => {
      if (error) {
        const errorText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr || "");
        error.message = `${error.message}${errorText ? `\n${errorText}` : ""}`;
        reject(error);
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ""));
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function needsShell(file = "") {
  return os.platform() === "win32" && /\.(cmd|bat)$/i.test(String(file));
}

function taskFailureResult(error) {
  const result = {
    message: error.message,
    errorCode: error.diagnostic?.code || error.code || "task_failed"
  };
  if (error.diagnostic) {
    result.diagnostic = error.diagnostic;
    if (error.diagnostic.accountSwitched !== undefined) result.accountSwitched = Boolean(error.diagnostic.accountSwitched);
    if (error.diagnostic.currentAccount) result.currentAccount = String(error.diagnostic.currentAccount);
    if (error.diagnostic.accountIdentityVerified !== undefined) result.accountIdentityVerified = error.diagnostic.accountIdentityVerified === true;
    if (Array.isArray(error.diagnostic.savedAccounts)) result.savedAccounts = error.diagnostic.savedAccounts;
    if (error.diagnostic.accountSwitchCount !== undefined) result.accountSwitchCount = Math.max(0, Number(error.diagnostic.accountSwitchCount) || 0);
    if (error.diagnostic.accountSwitchReason) result.accountSwitchReason = String(error.diagnostic.accountSwitchReason);
    if (error.diagnostic.packageName) result.packageName = error.diagnostic.packageName;
    if (error.diagnostic.currentActivity) result.currentActivity = error.diagnostic.currentActivity;
    if (error.diagnostic.uiSnapshot) result.uiSnapshot = error.diagnostic.uiSnapshot;
  }
  return result;
}

function classifyAdbInstallFailure(rawMessage = "") {
  const raw = String(rawMessage || "");
  const lower = raw.toLowerCase();
  const base = {
    code: "adb_install_failed",
    retryable: true,
    hint: "查看手机屏幕是否有安装确认、权限或安全拦截弹窗；确认后重试安装 APK。",
    raw
  };
  if (raw.includes("INSTALL_FAILED_ABORTED") || lower.includes("user rejected")) {
    return {
      ...base,
      code: "usb_install_rejected",
      message: "手机侧拒绝了 USB 安装。请在手机开发者选项中开启“USB 安装/通过 USB 安装”，并在弹窗中点允许后重试。",
      hint: "vivo/iQOO 常见路径：设置 -> 系统管理 -> 开发者选项 -> USB 安装。部分机型需要输入锁屏密码，或关闭安装监控/纯净模式后再允许本次安装。"
    };
  }
  if (raw.includes("INSTALL_FAILED_USER_RESTRICTED")) {
    return {
      ...base,
      code: "install_user_restricted",
      message: "系统策略限制了通过 USB 安装 APK。",
      hint: "检查开发者选项的 USB 安装、未知来源安装、企业管控/儿童模式/纯净模式等限制。"
    };
  }
  if (raw.includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE")) {
    return {
      ...base,
      code: "install_signature_mismatch",
      retryable: false,
      message: "手机上已有同包名但签名不同的 APK，无法覆盖安装。",
      hint: "确认旧版可删除后，先卸载 com.ztqc.smsrelay，再重新安装。卸载会清除该 APK 本地配置。"
    };
  }
  if (raw.includes("INSTALL_FAILED_VERSION_DOWNGRADE")) {
    return {
      ...base,
      code: "install_version_downgrade",
      message: "当前 APK 版本低于手机已安装版本，系统拒绝降级安装。",
      hint: "上传更高 versionCode 的 APK，或确认后使用允许降级的安装策略。"
    };
  }
  if (raw.includes("INSTALL_FAILED_INSUFFICIENT_STORAGE")) {
    return {
      ...base,
      code: "install_insufficient_storage",
      message: "手机存储空间不足，APK 安装失败。",
      hint: "释放手机存储空间后重试。"
    };
  }
  if (lower.includes("unauthorized")) {
    return {
      ...base,
      code: "adb_unauthorized",
      message: "ADB 未授权，电脑还不能控制这台手机。",
      hint: "保持手机解锁，重新插拔 USB，并在手机上的 RSA 指纹授权弹窗中点允许。"
    };
  }
  if (lower.includes("offline") || lower.includes("no devices") || lower.includes("device not found")) {
    return {
      ...base,
      code: "adb_device_unavailable",
      message: "ADB 设备不可用，安装任务没有连到可控制的手机。",
      hint: "检查 USB 线、Hub、手机 ADB 授权和 adb devices 状态。"
    };
  }
  return {
    ...base,
    message: "ADB 安装 APK 失败。"
  };
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname = "") {
  return ["127.0.0.1", "localhost", "::1"].includes(String(hostname || "").toLowerCase());
}

function valueOf(result) {
  return result.status === "fulfilled" ? String(result.value || "").trim() : "";
}

function defaultDeviceName(device = {}) {
  const brand = String(device.brand || device.manufacturer || device.model || "").trim();
  const serial = String(device.adbSerial || device.serial || "").trim();
  return [brand, serial].filter(Boolean).join("-") || serial || brand || "";
}

function cleanLogText(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
}

function parseBattery(text) {
  const match = String(text || "").match(/level:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function sha256Hex(bytes) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFileName(value = "") {
  return String(value || "phone-agent.apk").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160) || "phone-agent.apk";
}

function log(message, detail = "") {
  const suffix = typeof detail === "string" ? detail : JSON.stringify(detail);
  const line = `[${new Date().toISOString()}] ${message}${suffix ? ` ${suffix}` : ""}`;
  console.log(line);
  if (logDir) {
    fs.appendFile(path.join(logDir, "agent.log"), `${line}\n`).catch(() => {});
  }
}
