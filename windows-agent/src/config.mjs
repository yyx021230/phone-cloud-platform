import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function normalizeDeviceSerialAllowlist(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean))];
}

export function isDeviceSerialInNotificationFallbackScope(config = {}, serial = "") {
  if (config.smsNotificationFallbackEnabled !== true) return false;
  const normalizedSerial = String(serial || "").trim().toUpperCase();
  if (!normalizedSerial) return false;
  if (config.smsNotificationFallbackAllDevices === true) return true;
  return normalizeDeviceSerialAllowlist(config.smsNotificationFallbackDeviceSerials).includes(normalizedSerial);
}

export async function loadAgentConfig({ agentDir, configPath }) {
  let raw;
  try {
    raw = JSON.parse((await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`config not found: ${configPath}. Copy config.example.json to config.json first.`);
    }
    throw error;
  }

  const resolveAgentPath = (value, fallback) => {
    const target = String(value || fallback || "").trim();
    if (!target) return "";
    return path.isAbsolute(target) ? target : path.resolve(agentDir, target);
  };
  const logDir = resolveAgentPath(raw.logDir, path.join(agentDir, "logs"));
  const cacheDir = resolveAgentPath(raw.cacheDir, path.join(agentDir, "cache"));
  const dataDir = resolveAgentPath(raw.dataDir, path.join(agentDir, "data"));

  return {
    agentId: raw.agentId || "win-agent-001",
    agentName: raw.agentName || raw.agentId || "Windows 管理器",
    serverBaseUrl: String(raw.serverBaseUrl || "http://127.0.0.1:8787").replace(/\/$/, ""),
    agentToken: raw.agentToken || "dev-windows-token",
    deviceToken: raw.deviceToken || "dev-device-token",
    adbPath: raw.adbPath || "adb",
    scanIntervalSeconds: Math.max(3, Number(raw.scanIntervalSeconds || 10)),
    batteryRefreshIntervalSeconds: Math.max(30, Number(raw.batteryRefreshIntervalSeconds || 60)),
    batteryRefreshConcurrency: Math.max(1, Math.min(50, Number(raw.batteryRefreshConcurrency || 20))),
    staticDeviceInfoConcurrency: Math.max(1, Math.min(8, Number(raw.staticDeviceInfoConcurrency || 4))),
    heartbeatIntervalSeconds: Math.max(5, Number(raw.heartbeatIntervalSeconds || 15)),
    taskPollIntervalSeconds: Math.max(0.5, Number(raw.taskPollIntervalSeconds || 0.5)),
    apiTimeoutSeconds: Math.max(5, Number(raw.apiTimeoutSeconds || 25)),
    smsLibrarySyncEnabled: raw.smsLibrarySyncEnabled !== false,
    smsLibraryBackgroundSyncEnabled: raw.smsLibraryBackgroundSyncEnabled === true,
    smsLibraryIncrementalSync: raw.smsLibraryIncrementalSync !== false,
    smsLibraryInitialFullSync: raw.smsLibraryInitialFullSync !== false,
    smsLibrarySyncIntervalSeconds: Math.max(30, Number(raw.smsLibrarySyncIntervalSeconds || 120)),
    smsLibraryBackgroundSyncConcurrency: Math.max(1, Math.min(4, Number(raw.smsLibraryBackgroundSyncConcurrency || 2))),
    smsLibraryBatchSize: Math.max(10, Math.min(100, Number(raw.smsLibraryBatchSize || 50))),
    smsNotificationFallbackEnabled: raw.smsNotificationFallbackEnabled === true,
    smsNotificationFallbackAllDevices: raw.smsNotificationFallbackAllDevices === true,
    smsNotificationFallbackDeviceSerials: normalizeDeviceSerialAllowlist(raw.smsNotificationFallbackDeviceSerials),
    smsNotificationBackgroundIntervalSeconds: Math.max(30, Number(raw.smsNotificationBackgroundIntervalSeconds || 30)),
    smsNotificationBackgroundConcurrency: Math.max(1, Math.min(4, Number(raw.smsNotificationBackgroundConcurrency || 2))),
    smsNotificationPackageCacheSeconds: Math.max(60, Number(raw.smsNotificationPackageCacheSeconds || 600)),
    smsNotificationHistoryMaxAgeHours: Math.max(1, Math.min(168, Number(raw.smsNotificationHistoryMaxAgeHours || 24))),
    maxConcurrentAdbTasks: Math.max(1, Number(raw.maxConcurrentTasks || raw.maxConcurrentAdbTasks || 15)),
    deviceTaskConcurrency: Math.max(1, Number(raw.deviceTaskConcurrency || 1)),
    airtestEnabled: raw.airtestEnabled !== false,
    autoInstallAirtest: raw.autoInstallAirtest !== false,
    pythonCommand: raw.pythonCommand || (os.platform() === "win32" ? "python.exe" : "python3"),
    airtestPackages: Array.isArray(raw.airtestPackages) && raw.airtestPackages.length
      ? raw.airtestPackages
      : ["airtest==1.4.3", "pocoui==1.0.94"],
    airtestRunnerPath: resolveAgentPath(raw.airtestRunnerPath || path.join(agentDir, "scripts", "xhs_airtest_poco.py"), ""),
    xmlUiAutomatorRunnerPath: resolveAgentPath(raw.xmlUiAutomatorRunnerPath || path.join(agentDir, "scripts", "xhs_xml_uiautomator.py"), ""),
    automationPreflightEnabled: raw.automationPreflightEnabled !== false,
    automationPreflightIntervalSeconds: Math.max(60, Number(raw.automationPreflightIntervalSeconds || 600)),
    // Preflight can involve a slow vendor install prompt. Keep a small parallel
    // lane so one blocked phone does not leave every later phone queued.
    automationPreflightConcurrency: Math.max(1, Math.min(4, Number(raw.automationPreflightConcurrency || 2))),
    xhsPackageName: raw.xhsPackageName || "com.xingin.xhs",
    xhsTaskTimeoutSeconds: Math.max(60, Number(raw.xhsTaskTimeoutSeconds || 180)),
    screenStreamEnabled: raw.screenStreamEnabled !== false,
    screenMaxConcurrentSessions: Math.max(1, Math.min(50, Number(raw.screenMaxConcurrentSessions || 20))),
    screenMaxSize: Math.max(480, Math.min(2160, Number(raw.screenMaxSize || 1600))),
    screenMaxFps: Math.max(5, Math.min(60, Number(raw.screenMaxFps || 60))),
    screenVideoBitRate: Math.max(500_000, Math.min(12_000_000, Number(raw.screenVideoBitRate || 8_000_000))),
    // A few handset encoders have materially larger VBR bursts than others.
    // Keep their limits explicit and opt-in, rather than lowering every phone.
    screenDeviceProfiles: normalizeScreenDeviceProfiles(raw.screenDeviceProfiles),
    // Keep the RTP wire rate close to the encoder target. A much higher value
    // turns normal H.264 VBR frames into UDP bursts and causes whole-frame loss.
    screenTransportPacingBitRate: Math.max(2_000_000, Math.min(48_000_000, Number(raw.screenTransportPacingBitRate || 12_000_000))),
    // Bound source backlog by time as well as bytes. A frame-count-only queue
    // turns one normal large IDR into a decoder discontinuity at high FPS.
    screenRealtimeQueueLatencyMs: Math.max(100, Math.min(1_500, Number(raw.screenRealtimeQueueLatencyMs || 400))),
    screenKeyframeRecoveryCooldownMs: Math.max(500, Math.min(10_000, Number(raw.screenKeyframeRecoveryCooldownMs || 2_000))),
    // Roll these lifecycle changes out per device first. A video-only scrcpy
    // source can then restart without destroying the control channel or the
    // long-lived WHIP/WHEP media session.
    screenSourceRecoveryEnabled: raw.screenSourceRecoveryEnabled === true,
    screenSourceRecoveryMaxAttempts: Math.max(1, Math.min(8, Number(raw.screenSourceRecoveryMaxAttempts || 3))),
    screenSourceRecoveryWindowSeconds: Math.max(10, Math.min(300, Number(raw.screenSourceRecoveryWindowSeconds || 30))),
    screenIsolateControlEnabled: raw.screenIsolateControlEnabled === true,
    // Android MediaCodec: 2 is CBR. It keeps screen-change frames from
    // overwhelming the real-time WebRTC transport while preserving 8 Mbps quality.
    screenEncoderBitrateMode: Math.max(0, Math.min(2, Number(raw.screenEncoderBitrateMode ?? 2))),
    screenPublisherStatsIntervalSeconds: Math.max(0, Math.min(60, Number(raw.screenPublisherStatsIntervalSeconds || 0))),
    // WHEP viewers can attach just after the first encoder IDR. Keep a short
    // interval so every new browser gets a decodable H.264 frame promptly.
    screenIFrameIntervalSeconds: Math.max(1, Math.min(10, Number(raw.screenIFrameIntervalSeconds || 1))),
    // MediaMTX WebRTC readers don't replay the preceding H.264 GOP. During
    // the short interval after a new reader joins, satisfy a bounded number
    // of PLI/FIR requests with scrcpy's ResetVideo command. Outside this
    // window, PLI remains diagnostic feedback and never restarts the encoder.
    screenViewerKeyframeStartupWindowMs: Math.max(2_000, Math.min(30_000, Number(raw.screenViewerKeyframeStartupWindowMs || 12_000))),
    screenViewerKeyframeRecoveryMaxAttempts: Math.max(1, Math.min(3, Number(raw.screenViewerKeyframeRecoveryMaxAttempts || 2))),
    // scrcpy ResetVideo is the source-native way to give a newly attached
    // WHEP reader an immediate configuration + IDR. Roll it out per device.
    screenViewerKeyframeResetEnabled: raw.screenViewerKeyframeResetEnabled === true,
    screenWebRtcEnabled: raw.screenWebRtcEnabled === true,
    // Keep the legacy RTSP publisher opt-in while the WHIP publisher is rolled
    // out per Windows manager. WHIP carries scrcpy's original frame timing
    // directly into MediaMTX instead of assigning a synthetic raw-H264 clock.
    screenPublisherMode: ["whip", "direct_webrtc"].includes(String(raw.screenPublisherMode || ""))
      ? String(raw.screenPublisherMode)
      : "rtsp",
    screenWhipPublisherPath: resolveAgentPath(raw.screenWhipPublisherPath || path.join(agentDir, "vendor", os.platform() === "win32" ? "phone-cloud-whip-publisher.exe" : "phone-cloud-whip-publisher"), ""),
    ffmpegPath: resolveAgentPath(raw.ffmpegPath || path.join(agentDir, "..", "tools", "ffmpeg", "bin", os.platform() === "win32" ? "ffmpeg.exe" : "ffmpeg"), ""),
    scrcpyServerPath: resolveAgentPath(raw.scrcpyServerPath || path.join(agentDir, "vendor", "scrcpy-server-v3.3.4"), ""),
    adbServerHost: raw.adbServerHost || "127.0.0.1",
    adbServerPort: Math.max(1, Math.min(65535, Number(raw.adbServerPort || 5037))),
    // ADB can occasionally leave its local daemon socket in a reset state under
    // heavy USB churn. Recover conservatively: a harmless start first, and only
    // restart the daemon after repeated failures with no active phone work.
    adbScanRecoveryFailures: Math.max(1, Math.min(10, Number(raw.adbScanRecoveryFailures || 2))),
    adbHardRecoveryFailures: Math.max(2, Math.min(12, Number(raw.adbHardRecoveryFailures || 3))),
    adbRecoveryCooldownSeconds: Math.max(15, Math.min(900, Number(raw.adbRecoveryCooldownSeconds || 120))),
    // Confirm a missing ADB transport with two consecutive inventories before
    // the first exact recovery batch. Keep this fixed so an older production
    // config cannot silently stretch first action latency back to two minutes.
    pnpRescanAfterMissingScans: 2,
    // This interval now controls read-only USB inventory refreshes. Automatic
    // global PnP scans are forbidden; they require an explicit maintenance task.
    pnpRescanCooldownSeconds: Math.max(30, Math.min(900, Number(raw.pnpRescanCooldownSeconds || 60))),
    // If the phone is physically back but Windows fails to re-register it with
    // the SYSTEM ADB daemon, retry only its exact PnP instance with backoff.
    pnpTargetResetAfterMissingScans: 2,
    pnpTargetResetCooldownSeconds: 30,
    pnpTargetRetryMaxSeconds: 120,
    // Recovery follow-ups are event-driven: while Windows is installing a
    // device, poll only the process list; as soon as it becomes idle, run one
    // fresh read-only topology scan instead of waiting for the 30/60s clocks.
    pnpDeviceInstallPollSeconds: Math.max(2, Math.min(30, Number(raw.pnpDeviceInstallPollSeconds || 5))),
    pnpPostActionProbeSeconds: Math.max(5, Math.min(60, Number(raw.pnpPostActionProbeSeconds || 10))),
    // Windows may continue re-binding WinUSB/MTP nodes well after pnputil
    // exits. Keep the pre-action online cohort under observation long enough
    // to catch delayed collateral before another PnP batch is allowed.
    pnpCollateralWatchSeconds: Math.max(60, Math.min(600, Number(raw.pnpCollateralWatchSeconds || 180))),
    // Explicitly authorized production policy: issue exact per-phone recovery
    // against eight independent targets in one batch. Never reset a Hub.
    pnpMaxTargetRecoveriesPerPass: 8,
    pnpTargetRecoveryConcurrency: 8,
    pnpMaxAutomaticAttemptsPerDevice: 5,
    pnpMaxAutomaticActionsPerHour: 160,
    // Do not call a one-scan ADB reappearance recovered. Some stale WinUSB
    // transports rejoin briefly and disappear again a few minutes later.
    pnpRecoveryStableSeconds: Math.max(30, Math.min(600, Number(raw.pnpRecoveryStableSeconds || 90))),
    pnpRecoveryStableScans: Math.max(2, Math.min(20, Number(raw.pnpRecoveryStableScans || 3))),
    // Exact PnP actions briefly remove a phone from the tree. Only a sustained
    // absence starts a fresh recovery cycle; a transient must retain its stage.
    pnpRecoveryAbsentResetSeconds: Math.max(60, Math.min(900, Number(raw.pnpRecoveryAbsentResetSeconds || 120))),
    pnpMassOutageMinDevices: Math.max(2, Math.min(20, Number(raw.pnpMassOutageMinDevices || 4))),
    pnpMassOutageRatio: Math.max(0.01, Math.min(1, Number(raw.pnpMassOutageRatio || 0.08))),
    pnpMassOutageCooldownSeconds: Math.max(60, Math.min(3_600, Number(raw.pnpMassOutageCooldownSeconds || 180))),
    pnpMassOutageStableScans: Math.max(1, Math.min(20, Number(raw.pnpMassOutageStableScans || 3))),
    pnpMissingDeviceTrackingSeconds: Math.max(600, Math.min(604_800, Number(raw.pnpMissingDeviceTrackingSeconds || 86_400))),
    // Older production configs used 1800 seconds here, which makes a
    // temporary post-cycle topology gap look stuck for half an hour. This is
    // now a policy migration, not a tunable: refresh the read-only mapping in
    // one minute without consuming another recovery attempt.
    pnpTargetAbsentRetrySeconds: 60,
    apkPath: raw.apkPath || "",
    logDir,
    dataDir,
    cacheDir,
    configWarnings: validateConfig(raw)
  };
}

function normalizeScreenDeviceProfiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const profiles = {};
  for (const [serial, candidate] of Object.entries(value)) {
    const adbSerial = String(serial || "").trim();
    if (!adbSerial || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const profile = {};
    if (Number.isFinite(Number(candidate.maxFps))) {
      profile.maxFps = Math.max(5, Math.min(60, Number(candidate.maxFps)));
    }
    if (Number.isFinite(Number(candidate.videoBitRate))) {
      profile.videoBitRate = Math.max(500_000, Math.min(12_000_000, Number(candidate.videoBitRate)));
    }
    if (Number.isFinite(Number(candidate.maxSize))) {
      profile.maxSize = Math.max(480, Math.min(2160, Number(candidate.maxSize)));
    }
    if (Number.isFinite(Number(candidate.transportPacingBitRate))) {
      profile.transportPacingBitRate = Math.max(2_000_000, Math.min(48_000_000, Number(candidate.transportPacingBitRate)));
    }
    if (typeof candidate.sourceRecovery === "boolean") profile.sourceRecovery = candidate.sourceRecovery;
    if (typeof candidate.isolateControl === "boolean") profile.isolateControl = candidate.isolateControl;
    if (typeof candidate.viewerKeyframeReset === "boolean") profile.viewerKeyframeReset = candidate.viewerKeyframeReset;
    if (Object.keys(profile).length) profiles[adbSerial] = profile;
  }
  return profiles;
}

function validateConfig(raw) {
  const warnings = [];
  if (!raw.agentId) warnings.push("agentId_missing_using_default");
  if (!raw.serverBaseUrl) warnings.push("serverBaseUrl_missing_using_local_default");
  if (/127\.0\.0\.1|localhost/i.test(String(raw.serverBaseUrl || ""))) warnings.push("serverBaseUrl_is_localhost");
  if (!raw.agentToken || raw.agentToken === "dev-windows-token") warnings.push("agentToken_uses_default");
  if (!raw.deviceToken || raw.deviceToken === "dev-device-token") warnings.push("deviceToken_uses_default");
  if (!raw.adbPath) warnings.push("adbPath_missing_using_path_lookup");
  if (raw.airtestEnabled !== false && !raw.pythonCommand) warnings.push("pythonCommand_missing_using_default");
  if (raw.smsNotificationFallbackEnabled === true
    && raw.smsNotificationFallbackAllDevices !== true
    && normalizeDeviceSerialAllowlist(raw.smsNotificationFallbackDeviceSerials).length === 0) {
    warnings.push("sms_notification_fallback_enabled_without_scope");
  }
  return warnings;
}
