import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentConfig } from "./config.mjs";
import { cachedAdbSerials, indexCachedDevices, mergeCachedDeviceScanRow } from "./device-scan-cache.mjs";
import { galleryImportFileName, parseGalleryImportImage } from "./gallery-import.mjs";
import { createSerialAdbActivityTracker } from "./serial-adb-activity.mjs";
import { assertSerialAdbHealthy } from "./serial-adb-health.mjs";
import { createSerialDelayScheduler } from "./serial-delay-scheduler.mjs";
import { isSerialReservedForBackgroundWork } from "./serial-reservation.mjs";
import { createDeviceActorManager } from "./device-actor.mjs";
import { acquireAgentInstanceLock } from "./agent-instance-lock.mjs";
import { createScreenStreamManager } from "./screen-stream.mjs";
import { createProcessRuntimeMetrics } from "./runtime-metrics.mjs";
import { createSingleFlightRunner } from "./single-flight.mjs";
import { pocoForwardLocals, stopWorkerWithFallback, waitForWorkerExit } from "./worker-shutdown.mjs";
import { createAdbServerRecovery } from "./adb-server-recovery.mjs";
import { createPnpMissingDeviceRecovery } from "./pnp-missing-device-recovery.mjs";
import {
  ANDROID_USB_VENDOR_IDS,
  orderPnpRecoveryTargets,
  pnpTargetRecoveryBackoffMs,
  pnpTargetRecoveryMode
} from "./pnp-recovery-policy.mjs";
import { createPnpScreenCoordinator } from "./pnp-screen-coordinator.mjs";

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
const agentInstanceLock = await acquireAgentInstanceLock({
  lockPath: path.join(dataDir, "agent-instance.lock"),
  agentId: config.agentId
});

let lastDevices = [];
let lastDevicesScannedAt = 0;
let lastAdbVersion = "";
let smsSyncCursors = await loadSmsSyncCursors();
let lastServerDevicesById = await loadDeviceScanCache();
const lastSmsLibrarySyncBySerial = new Map();
const backgroundSmsAbortControllersBySerial = new Map();
let backgroundSmsSyncPromise = null;
const simInfoCacheBySerial = new Map();
const initialSimReadBySerial = new Set();
for (const serial of cachedAdbSerials(lastServerDevicesById)) {
  initialSimReadBySerial.add(serial);
  const sims = lastServerDevicesById.get(`adb:${serial}`)?.sims;
  if (Array.isArray(sims)) simInfoCacheBySerial.set(serial, { sims, checkedAtMs: Date.now() });
}
const lastBatteryRefreshBySerial = new Map();
const automationPreflightBySerial = new Map();
const automationPreflightRunning = new Set();
const scheduleAutomationPreflight = createSingleFlightRunner(runAutomationPreflightCycle);
let automationStatusSyncTimer = null;
let automationStatusSyncInFlight = false;
let automationStatusSyncRequested = false;
const airtestWorkersBySerial = new Map();
const activeTasksById = new Map();
const activeTaskAbortControllersById = new Map();
const activeTaskSerials = new Set();
const screenControlledSerials = new Set();
const pnpScreenCoordinator = createPnpScreenCoordinator();
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
const pnpTargetRecoveryAttempts = new Map();
// Keep recently assigned phones under observation across an agent restart.  A
// USB phone can reappear after the first ADB-missing recovery attempt, so only
// tracking devices seen in this process leaves it permanently invisible.
pnpMissingDeviceRecovery.seed(cachedAdbSerials(lastServerDevicesById).filter((serial) => {
  const cached = lastServerDevicesById.get(`adb:${serial}`) || {};
  return cached.listed !== false && cached.adb?.agentId === config.agentId;
}));
let health = await buildHealth("starting", null);
const intervalGuards = new Map();
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
    automationResumeScheduler.schedule(serial);
    log("automation resume scheduled after screen control", { serial, delayMs: 15_000 });
  }
});
screenStreamManager.start();

setInterval(() => runGuardedInterval("heartbeat", () => heartbeat()), config.heartbeatIntervalSeconds * 1000);
setInterval(() => runGuardedInterval("scan", () => scanAndSync()), config.scanIntervalSeconds * 1000);
setInterval(() => runGuardedInterval("task poll", () => pollTask()), config.taskPollIntervalSeconds * 1000);

await runGuardedInterval("heartbeat", () => heartbeat()).catch((error) => log("startup heartbeat failed", error?.message || String(error)));
await runGuardedInterval("scan", () => scanAndSync()).catch((error) => log("startup scan failed", error?.message || String(error)));
scheduleTaskPoll(100);

process.stdin.resume();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await screenStreamManager?.close().catch(() => {});
    deviceActors.close("agent_shutdown");
    await agentInstanceLock.release();
    process.exit(0);
  });
}

function isDeviceSerialReserved(serial) {
  return isSerialReservedForBackgroundWork(serial, activeTaskSerials, screenControlledSerials);
}

async function runGuardedInterval(name, fn) {
  if (intervalGuards.get(name)) return;
  intervalGuards.set(name, true);
  const timeoutMs = name === "scan" ? 120_000 : name.includes("task poll") ? 30_000 : 45_000;
  let timeoutId = null;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } catch (error) {
    log(`${name} failed`, error.message);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    intervalGuards.set(name, false);
  }
}

async function buildHealth(reason, previousHealth = null) {
  const [adbCheck, logDirCheck, cacheDirCheck, airtestCheck] = await Promise.allSettled([
    adbVersion(),
    checkWritableDir(logDir),
    checkWritableDir(cacheDir),
    checkAirtestStatus()
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
      maxConcurrentAdbTasks: config.maxConcurrentAdbTasks,
      deviceTaskConcurrency: config.deviceTaskConcurrency,
      health
    }
  });
}

async function scanAndSync(options = {}) {
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
  markAutomationPreflightPending(devices);
  cleanupOfflineAutomationWorkers(devices).catch((error) => log("automation worker cleanup failed", error.message));
  await requestSafePnpRescanForMissingDevices(devices);
  lastDevices = devices;
  lastDevicesScannedAt = Date.now();
  annotateDeviceAutomationStatus(devices);
  const syncResult = await syncDevicesToPlatform(devices);
  rememberServerDevices(syncResult.devices || []);
  await saveDeviceScanCache(syncResult.devices || []).catch((error) => log("device scan cache save failed", error.message));
  log("synced devices", devices.map((device) => `${device.adbSerial}:${device.state}`).join(", ") || "none");
  if (!activeAutomationTask && !options.skipPreflight) {
    scheduleAutomationPreflight(devices)
      .then((updated) => {
        if (updated) scheduleAutomationStatusSync();
      })
      .catch((error) => log("automation preflight failed", error.message));
  } else if (activeAutomationTask) {
    log("automation preflight skipped during active task");
  }
  if (!options.skipSms && config.smsLibraryBackgroundSyncEnabled && !activeAutomationTask) {
    scheduleBackgroundSmsSync(devices);
  } else {
    log("sms library background sync skipped", {
      enabled: Boolean(config.smsLibraryBackgroundSyncEnabled),
      activeAutomationTask,
      skipSms: Boolean(options.skipSms),
      reason: options.reason || ""
    });
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
  const worker = airtestWorkersBySerial.get(serial);
  if (!worker || worker.exited || worker.stopping) return true;
  const cached = automationPreflightBySerial.get(serial);
  if (!cached) return true;
  if (cached.status === "preparing") return false;
  const age = Date.now() - Number(cached.checkedAtMs || 0);
  if (cached.ok && age < config.automationPreflightIntervalSeconds * 1000) return false;
  if (!cached.ok && cached.nextCheckAt && Date.now() < cached.nextCheckAt) return false;
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
  const cachedReady = automationPreflightBySerial.get(serial);
  if (options.task && cachedReady?.ok && Date.now() - Number(cachedReady.checkedAtMs || 0) < config.automationPreflightIntervalSeconds * 1000) {
    const worker = airtestWorkersBySerial.get(serial);
    if (worker && !worker.exited) {
      await getAirtestWorker(serial);
      return automationStatusForSerial(serial);
    }
  }
  if (automationPreflightRunning.has(serial)) {
    if (!options.task) return automationStatusForSerial(serial);
    const deadline = Date.now() + 60_000;
    while (automationPreflightRunning.has(serial) && Date.now() < deadline) {
      await delay(1000);
    }
    if (automationPreflightRunning.has(serial)) return automationStatusForSerial(serial);
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
  while (activeTasksById.size < config.maxConcurrentAdbTasks) {
    const excludeSerials = [...new Set([...activeTaskSerials, ...screenControlledSerials])]
      .filter(Boolean)
      .map(encodeURIComponent)
      .join(",");
    const screenGallerySerials = [...screenControlledSerials].filter(Boolean).map(encodeURIComponent).join(",");
    const params = new URLSearchParams();
    if (excludeSerials) params.set("excludeSerials", excludeSerials);
    if (screenGallerySerials) params.set("screenGallerySerials", screenGallerySerials);
    const suffix = params.size ? `?${params.toString()}` : "";
    const payload = await api(`/api/v1/windows-agents/${encodeURIComponent(config.agentId)}/tasks/next${suffix}`);
    if (!payload.task) break;
    startTask(payload.task);
    picked += 1;
  }
  if (picked) log("tasks dispatched", { picked, active: activeTasksById.size, maxConcurrentAdbTasks: config.maxConcurrentAdbTasks });
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
  log("task picked", { taskId: task.taskId, type: task.type, adbSerial: task.adbSerial });
  taskEvent(task, "start", "info", `开始执行 ${task.type}`)
    .catch((error) => log("task start event failed", { taskId: task.taskId, error: error.message }));
  try {
    let result;
    if (task.type === "adb_install_apk") result = await taskInstallApk(task);
    else if (task.type === "adb_grant_permissions") result = await taskGrantPermissions(task);
    else if (task.type === "adb_start_agent") result = await taskStartAgent(task);
    else if (task.type === "adb_collect_diagnostics") result = await taskCollectDiagnostics(task);
    else if (task.type === "adb_restart_server") result = await taskRestartAdb(task);
    else if (task.type === "sms_sync_now") result = await taskSmsSyncNow(task, options);
    else if (task.type === "screen_gallery_import") result = await taskScreenGalleryImport(task);
    else if (task.type === "xhs_qr_appium") result = await taskXhsQrAirtestPoco(task);
    else throw new Error(`unsupported task type: ${task.type}`);
    await taskEvent(task, "finish", "info", "执行成功", compactTaskResultForEvent(result))
      .catch((error) => log("task finish event failed", { taskId: task.taskId, error: error.message }));
    await taskStatus(task, "succeeded", result);
  } catch (error) {
    if (isScreenPriorityCancellation(error)) {
      taskEvent(task, "cancelled", "info", "投屏优先，已暂停短信同步", { reason: "screen_control_priority" })
        .catch((eventError) => log("task cancellation event failed", { taskId: task.taskId, error: eventError.message }));
      taskStatus(task, "cancelled", { code: "screen_control_priority", message: "投屏优先，已暂停短信同步" })
        .catch((statusError) => log("task cancellation status failed", { taskId: task.taskId, error: statusError.message }));
      return;
    }
    const evidence = await captureFailureEvidence(task).catch((evidenceError) => ({
      evidenceError: evidenceError?.message || String(evidenceError)
    }));
    const failure = { ...taskFailureResult(error), ...evidence };
    await taskEvent(task, "finish", "error", error.message, compactTaskResultForEvent(failure))
      .catch((eventError) => log("task failure event failed", { taskId: task.taskId, error: eventError.message }));
    await taskStatus(task, "failed", failure);
  } finally {
    if (options.signal?.aborted) {
      log("post-task scan skipped after screen priority cancellation", { taskId: task.taskId, adbSerial: task.adbSerial });
    } else {
      await scanAndSync({ force: true, skipSms: true, reason: "post_task" }).catch((error) => log("post-task scan failed", error.message));
    }
  }
}

function preemptSmsSyncForScreen(serial) {
  const adbSerial = String(serial || "").trim();
  if (!adbSerial) return;
  const backgroundController = backgroundSmsAbortControllersBySerial.get(adbSerial);
  if (backgroundController && !backgroundController.signal.aborted) {
    log("screen control preempted background sms sync", { adbSerial });
    backgroundController.abort();
  }
  for (const [taskId, task] of activeTasksById) {
    if (task?.type !== "sms_sync_now" || String(task.adbSerial || "").trim() !== adbSerial) continue;
    const controller = activeTaskAbortControllersById.get(taskId);
    if (!controller || controller.signal.aborted) continue;
    log("screen control preempted sms sync", { taskId, adbSerial });
    controller.abort();
  }
}

function screenPriorityCancellationError() {
  const error = new Error("screen_control_priority");
  error.code = "screen_control_priority";
  return error;
}

function throwIfScreenPriorityCancellation(signal) {
  if (signal?.aborted) throw screenPriorityCancellationError();
}

function isScreenPriorityCancellation(error) {
  return error?.code === "screen_control_priority" || error?.message === "screen_control_priority";
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
  if (!config.smsLibrarySyncEnabled) throw new Error("短信库同步未启用，请检查 Windows 管理器 config.json");
  const device = await assertAdbDeviceOnlineFast(task.adbSerial, options);
  await taskEvent(task, "sms_sync", "info", "开始主动读取手机短信库", { adbSerial: device.adbSerial });
  lastSmsLibrarySyncBySerial.delete(device.adbSerial);
  const result = await syncAdbSmsLibrary(device, options);
  lastSmsLibrarySyncBySerial.set(device.adbSerial, Date.now());
  return {
    action: "短信库已主动同步",
    ...result
  };
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
  let worker = await getAirtestWorker(serial);
  const maxIdleMs = 45_000;
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

async function getAirtestWorker(serial) {
  const key = String(serial || "").trim();
  if (!key) throw new Error("缺少 ADB 序列号，无法启动 Airtest/Poco worker");
  const existing = airtestWorkersBySerial.get(key);
  if (existing && !existing.exited && !existing.stopping) return existing.readyPromise.then(() => existing);
  if (existing?.stopping && !existing.exited) {
    const exited = await waitForWorkerExit(existing, 10_000);
    if (!exited) throw new Error(`Airtest/Poco worker 正在停止但未退出：${key}`);
  }
  const worker = createAirtestWorker(key);
  airtestWorkersBySerial.set(key, worker);
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
      log("forcing stuck airtest worker to stop", { serial, reason, pid: worker.child.pid });
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
    log("automation resumed after screen control", { serial });
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
  const output = await adb(serial, ["shell", "pm", "path", packageName], { timeoutMs: 5000 }).catch(() => "");
  return /^package:/m.test(output);
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
  return await api(`/api/v1/windows-agent-tasks/${encodeURIComponent(task.taskId)}/status`, {
    method: "POST",
    body: { status, result: compactTaskResultForStatus(result) }
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
      busy: hasActiveAutomationTask() || Boolean(backgroundSmsSyncPromise) || screenControlledSerials.size > 0,
      startServer: () => run(config.adbPath, ["start-server"], { timeoutMs: 10_000 }),
      restartServer: async () => {
        await run(config.adbPath, ["kill-server"], { timeoutMs: 10_000 });
        await run(config.adbPath, ["start-server"], { timeoutMs: 10_000 });
      }
    });
    log("adb scan recovery", recovery);
    if (!recovery.attempted) throw error;
    output = await run(config.adbPath, ["devices", "-l"]);
    adbServerRecovery.recordSuccess();
  }
  const rows = parseAdbDevices(output);
  const enriched = [];
  for (const row of rows) {
    const previous = lastDevices.find((device) => device.adbSerial === row.adbSerial) || {};
    const serverDevice = lastServerDevicesById.get(`adb:${row.adbSerial}`) || {};
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
  return enriched;
}

async function requestSafePnpRescanForMissingDevices(devices) {
  if (os.platform() !== "win32") return;
  const online = new Set(devices
    .filter((device) => device?.state === "device")
    .map((device) => String(device.adbSerial || "").trim().toUpperCase())
    .filter(Boolean));
  for (const [serial, state] of pnpTargetRecoveryAttempts) {
    if (!online.has(serial)) continue;
    log("pnp target adb recovered", { serial: state.serial, attempts: state.attempts, lastMode: state.lastMode });
    pnpTargetRecoveryAttempts.delete(serial);
  }

  const isSerialBusy = (serial) => serialAdbActivity.activeCount(serial) > 0 || isDeviceSerialReserved(serial);
  const physicalRecoveryDue = Date.now() - lastPhysicalPnpCandidateScanAt >= config.pnpRescanCooldownSeconds * 1_000;
  if (physicalRecoveryDue) {
    lastPhysicalPnpCandidateScanAt = Date.now();
    lastPhysicallyPresentAndroidUsbSerials = await discoverPhysicallyPresentAndroidUsbSerials();
    // Physical-only devices may never have reached ADB and therefore are not
    // present in the server cache. Seed them into the same per-device tracker
    // so cooldown and round-robin fairness apply to every recovery candidate.
    pnpMissingDeviceRecovery.seed(lastPhysicallyPresentAndroidUsbSerials);
  }

  const plan = pnpMissingDeviceRecovery.observe({ devices, busy: false, isSerialBusy });
  if (!plan.missing.length) return;
  const physical = new Set(lastPhysicallyPresentAndroidUsbSerials.map((serial) => serial.toUpperCase()));
  const physicalMissing = lastPhysicallyPresentAndroidUsbSerials.filter((serial) => !online.has(serial.toUpperCase()));
  if (physicalRecoveryDue && physicalMissing.length) {
    log("pnp physical adb candidates", {
      serials: physicalMissing,
      busySerials: physicalMissing.filter(isSerialBusy)
    });
  }

  const rescanSerials = plan.rescanSerials
    .filter((serial) => physical.has(String(serial).toUpperCase()))
    .filter((serial) => !isSerialBusy(serial));
  if (rescanSerials.length && screenControlledSerials.size === 0) {
    const releaseGlobalPnp = pnpScreenCoordinator.tryBegin("*", () => screenControlledSerials.size > 0);
    if (releaseGlobalPnp) {
      try {
        await run("pnputil.exe", ["/scan-devices"], { timeoutMs: 30_000 });
        pnpMissingDeviceRecovery.markRescan();
        log("pnp rescan requested for physically present missing adb devices", { serials: rescanSerials });
      } catch (error) {
        log("pnp rescan failed", { serials: rescanSerials, error: cleanLogText(error?.message || error).slice(0, 300) });
      } finally {
        releaseGlobalPnp();
      }
    }
  } else if (rescanSerials.length) {
    // A global scan remains conservative, but device-targeted recovery below
    // is still allowed for idle phones while unrelated streams are active.
    log("pnp global rescan deferred while screen control is active", {
      serials: rescanSerials,
      activeScreenSerials: [...screenControlledSerials]
    });
  } else if (plan.rescanSerials.length) {
    pnpMissingDeviceRecovery.markRescan();
    log("pnp rescan skipped for physically absent or busy adb devices", { serials: plan.rescanSerials });
  }

  let attempted = 0;
  const dueTargets = orderPnpRecoveryTargets(
    plan.resetSerials.filter((serial) => physical.has(String(serial).toUpperCase())),
    pnpTargetRecoveryAttempts
  );
  for (const serial of dueTargets) {
    if (attempted >= config.pnpMaxTargetRecoveriesPerPass) break;
    if (isSerialBusy(serial)) {
      log("pnp target adb recovery deferred", { serial, reason: "target_busy" });
      continue;
    }
    const releaseTargetPnp = pnpScreenCoordinator.tryBegin(serial, () => isSerialBusy(serial));
    if (!releaseTargetPnp) {
      log("pnp target adb recovery deferred", { serial, reason: "pnp_action_in_progress" });
      continue;
    }
    const key = String(serial).toUpperCase();
    const previous = pnpTargetRecoveryAttempts.get(key) || { serial, attempts: 0, lastMode: "", lastAttemptAt: 0 };
    const attempt = previous.attempts + 1;
    const mode = pnpTargetRecoveryMode(attempt);
    const attemptedAt = Date.now();
    const retryAfterMs = pnpTargetRecoveryBackoffMs(
      attempt,
      config.pnpTargetResetCooldownSeconds * 1_000,
      config.pnpTargetAbsentRetrySeconds * 1_000
    );
    attempted += 1;
    try {
      // Re-check after acquiring the per-device lease to close the race with a
      // screen or automation session starting between planning and execution.
      if (isSerialBusy(serial)) {
        attempted -= 1;
        log("pnp target adb recovery deferred", { serial, reason: "target_became_busy" });
        continue;
      }
      const result = await reenumerateMissingAdbDevice(serial, { mode });
      pnpTargetRecoveryAttempts.set(key, { serial, attempts: attempt, lastMode: mode, lastAttemptAt: attemptedAt });
      pnpMissingDeviceRecovery.markReset(serial, {
        targetPresent: result.result !== "target_not_present",
        retryAfterMs
      });
      log("pnp target adb recovery", {
        serial,
        attempt,
        mode,
        nextRetrySeconds: Math.round(retryAfterMs / 1_000),
        ...result
      });
    } catch (error) {
      pnpTargetRecoveryAttempts.set(key, { serial, attempts: attempt, lastMode: mode, lastAttemptAt: attemptedAt });
      pnpMissingDeviceRecovery.markReset(serial, { retryAfterMs });
      log("pnp target adb recovery failed", {
        serial,
        attempt,
        mode,
        nextRetrySeconds: Math.round(retryAfterMs / 1_000),
        error: cleanLogText(error?.message || error).slice(0, 300)
      });
    } finally {
      releaseTargetPnp();
    }
  }
}

async function discoverPhysicallyPresentAndroidUsbSerials() {
  try {
    return await listPhysicallyPresentAndroidUsbSerials();
  } catch (error) {
    log("pnp physical device discovery failed", cleanLogText(error?.message || error).slice(0, 300));
    return [];
  }
}

async function listPhysicallyPresentAndroidUsbSerials() {
  const vendorIds = ANDROID_USB_VENDOR_IDS.map((value) => `'${value}'`).join(",");
  const script = [
    "$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)",
    "Get-PnpDevice -PresentOnly | Where-Object { $_.Class -eq 'CDROM' -and $_.FriendlyName -eq 'Linux File-CD Gadget USB Device' } | ForEach-Object {",
    "  $parts = $_.InstanceId.Split('&'); if ($parts.Length -lt 2) { return }",
    "  $serial = [string]$parts[$parts.Length - 2]",
    "  if ($serial -match '^[A-Za-z0-9._:-]{4,128}$' -and $seen.Add($serial)) { Write-Output $serial }",
    "}",
    // Some newly connected phones have only reached the USB composite root;
    // they do not yet expose File-CD/MTP/ADB children, so include their root
    // serials as physical candidates too.
    `Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match '^USB\\\\VID_([0-9A-F]{4})&PID_[0-9A-F]{4}\\\\([^\\\\]+)$' -and $Matches[1] -in @(${vendorIds}) } | ForEach-Object {`,
    "  if ($_.InstanceId -match '^USB\\\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\\\([^\\\\]+)$') { $serial = [string]$Matches[1]; if ($serial -match '^[A-Za-z0-9._:-]{4,128}$' -and $seen.Add($serial)) { Write-Output $serial } }",
    "}"
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeoutMs: 30_000 });
  return cleanLogText(output)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z0-9._:-]{4,128}$/.test(value));
}

async function reenumerateMissingAdbDevice(serial, options = {}) {
  const normalizedSerial = String(serial || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalizedSerial)) {
    throw new Error("unsafe adb serial for PnP recovery");
  }
  const mode = options.mode === "restart" ? "restart" : "reenumerate";
  const script = [
    `$serial = '${normalizedSerial}'`,
    "$parents = @(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like \"*$serial\" -and $_.InstanceId -match \"^USB\\\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\\\\" })",
    "if (!$parents.Count) { Write-Output 'target_not_present'; exit 0 }",
    ...(mode === "restart" ? [
      "foreach ($parent in $parents) { & pnputil.exe /restart-device $parent.InstanceId; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }",
      "Write-Output ('target_restarted=' + $parents.Count)"
    ] : [
      "$scanRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)",
      "foreach ($parent in $parents) { $upstream = Get-PnpDeviceProperty -InstanceId $parent.InstanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue; if ($upstream.Data) { [void]$scanRoots.Add([string]$upstream.Data) }; & pnputil.exe /remove-device $parent.InstanceId; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }",
      "if ($scanRoots.Count) { foreach ($scanRoot in $scanRoots) { & pnputil.exe /scan-devices /instanceid $scanRoot; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } } else { & pnputil.exe /scan-devices; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }",
      "Write-Output ('target_reenumerated=' + $parents.Count)"
    ])
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeoutMs: 45_000 });
  return { result: cleanLogText(output).slice(-300) || "target_command_completed" };
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
    const lastSyncedAt = lastSmsLibrarySyncBySerial.get(device.adbSerial) || 0;
    if (now - lastSyncedAt < config.smsLibrarySyncIntervalSeconds * 1000) continue;
    lastSmsLibrarySyncBySerial.set(device.adbSerial, now);
    targets.push(device);
  }
  await runLimited(targets, config.smsLibraryBackgroundSyncConcurrency, async (device) => {
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
  const columns = ["_id", "thread_id", "address", "body", "date", "date_sent", "type", "read", "seen", "status", "locked", "sub_id"];
  const deviceId = `adb:${device.adbSerial}`;
  const serverDevice = lastServerDevicesById.get(deviceId);
  reconcileSmsCursorWithServer(device.adbSerial, serverDevice);
  const cursor = smsSyncCursors[device.adbSerial] || {};
  const where = config.smsLibraryIncrementalSync && cursor.lastSmsId
    ? `_id > ${Number(cursor.lastSmsId)}`
    : "";
  let messages;
  let incremental = Boolean(where);
  try {
    messages = parseSmsContentQuery(await querySmsContent(device.adbSerial, columns, where, options), columns);
  } catch (error) {
    const fallbackColumns = ["_id", "thread_id", "address", "body", "date", "date_sent", "type", "read", "seen", "status"];
    try {
      messages = parseSmsContentQuery(await querySmsContent(device.adbSerial, fallbackColumns, where, options), fallbackColumns);
    } catch (fallbackError) {
      if (!where) throw fallbackError;
      incremental = false;
      messages = parseSmsContentQuery(await querySmsContent(device.adbSerial, fallbackColumns, "", options), fallbackColumns);
    }
  }
  if (config.smsLibraryIncrementalSync && cursor.lastSmsId) {
    messages = messages.filter((message) => Number(message.smsId || 0) > Number(cursor.lastSmsId || 0));
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
  return { adbSerial: device.adbSerial, deviceId, incremental, scanned: messages.length, sent, cursor: smsSyncCursors[device.adbSerial] };
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
  const args = [
    "shell",
    "content",
    "query",
    "--uri",
    "content://sms",
    "--projection",
    columns.join(":")
  ];
  if (where) args.push("--where", where);
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
  const target = smsCursorPath();
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(smsSyncCursors, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
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
    const payload = await response.json().catch(() => ({}));
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
        reject(screenPriorityCancellationError());
        return;
      }
      if (error) {
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
