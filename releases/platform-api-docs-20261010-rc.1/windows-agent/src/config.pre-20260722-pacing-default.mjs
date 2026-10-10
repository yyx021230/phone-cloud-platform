import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    smsLibraryBatchSize: Math.max(10, Math.min(100, Number(raw.smsLibraryBatchSize || 50))),
    maxConcurrentAdbTasks: Math.max(1, Number(raw.maxConcurrentTasks || raw.maxConcurrentAdbTasks || 15)),
    deviceTaskConcurrency: Math.max(1, Number(raw.deviceTaskConcurrency || 1)),
    airtestEnabled: raw.airtestEnabled !== false,
    autoInstallAirtest: raw.autoInstallAirtest !== false,
    pythonCommand: raw.pythonCommand || (os.platform() === "win32" ? "python.exe" : "python3"),
    airtestPackages: Array.isArray(raw.airtestPackages) && raw.airtestPackages.length
      ? raw.airtestPackages
      : ["airtest==1.4.3", "pocoui==1.0.94"],
    airtestRunnerPath: resolveAgentPath(raw.airtestRunnerPath || path.join(agentDir, "scripts", "xhs_airtest_poco.py"), ""),
    automationPreflightEnabled: raw.automationPreflightEnabled !== false,
    automationPreflightIntervalSeconds: Math.max(60, Number(raw.automationPreflightIntervalSeconds || 600)),
    xhsPackageName: raw.xhsPackageName || "com.xingin.xhs",
    xhsTaskTimeoutSeconds: Math.max(60, Number(raw.xhsTaskTimeoutSeconds || 180)),
    screenStreamEnabled: raw.screenStreamEnabled !== false,
    screenMaxConcurrentSessions: Math.max(1, Math.min(50, Number(raw.screenMaxConcurrentSessions || 20))),
    screenMaxSize: Math.max(480, Math.min(2160, Number(raw.screenMaxSize || 1600))),
    screenMaxFps: Math.max(5, Math.min(60, Number(raw.screenMaxFps || 60))),
    screenVideoBitRate: Math.max(500_000, Math.min(12_000_000, Number(raw.screenVideoBitRate || 8_000_000))),
    screenPublisherStatsIntervalSeconds: Math.max(0, Math.min(60, Number(raw.screenPublisherStatsIntervalSeconds || 0))),
    // WHEP viewers can attach just after the first encoder IDR. Keep a short
    // interval so every new browser gets a decodable H.264 frame promptly.
    screenIFrameIntervalSeconds: Math.max(1, Math.min(10, Number(raw.screenIFrameIntervalSeconds || 1))),
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
    apkPath: raw.apkPath || "",
    logDir,
    dataDir,
    cacheDir,
    configWarnings: validateConfig(raw)
  };
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
  return warnings;
}
