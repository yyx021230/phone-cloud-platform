import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { AdbServerClient } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AndroidKeyEventAction, AndroidMotionEventAction, AndroidScreenPowerMode, ScrcpyCodecOptions } from "@yume-chan/scrcpy";
import { WebSocket } from "ws";
import { createScreenControlQueue } from "./screen-control-queue.mjs";
import { createVideoBackpressureGate } from "./screen-backpressure.mjs";
import { openScreenVideoChannel } from "./screen-video-channel.mjs";
import { createScreenWebRtcPublisher, h264ProfileLevelId } from "./screen-webrtc-publisher.mjs";

const execFileAsync = promisify(execFile);
const REMOTE_SERVER_PATH = "/data/local/tmp/phone-cloud-scrcpy-server-v3.3.4.jar";
const REMOTE_WAKE_HELPER_PATH = "/data/local/tmp/phone-cloud-wake.jar";
const SCREEN_SERIAL_WAIT_MS = 15_000;
const ANDROID_KEYCODE_A = 29;
const ANDROID_META_CTRL_ON = 0x1000;
const WEBRTC_SOURCE_HIGH_WATER_BYTES = 256 * 1024;
const WEBRTC_SOURCE_LOW_WATER_BYTES = 64 * 1024;

export function buildScreenRelayUrl(serverBaseUrl, agentId) {
  const url = new URL(String(serverBaseUrl || "http://127.0.0.1:8787"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/v1/windows-agents/${encodeURIComponent(agentId)}/screen-relay`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function encodeRelayVideoPacket(sessionId, videoPacket) {
  const id = Buffer.from(String(sessionId || ""), "utf8");
  if (!id.length || id.length > 255) throw new Error("invalid_screen_session_id");
  return Buffer.concat([Buffer.from([1, id.length]), id, Buffer.from(videoPacket)]);
}

export async function waitForSerialReservation(options) {
  const {
    serial,
    reserveSerial,
    timeoutMs = SCREEN_SERIAL_WAIT_MS,
    pollMs = 100,
    onWaiting = () => {},
    now = Date.now,
    delayFn = delay
  } = options;
  const deadline = now() + Math.max(0, timeoutMs);
  let waitingNotified = false;
  while (true) {
    if (reserveSerial(serial)) return true;
    if (now() >= deadline) return false;
    if (!waitingNotified) {
      waitingNotified = true;
      onWaiting();
    }
    await delayFn(Math.max(25, pollMs));
  }
}

export function screenKeyCode(key) {
  return { back: 4, home: 3, overview: 187, wakeup: 224, volume_up: 24, enter: 66, delete: 67, forward_delete: 112 }[key] || 0;
}

export function createScreenVideoCodecOptions(config = {}, requestedOptions = {}) {
  // Do not force an H.264 profile: some MediaTek encoders reject it. We do
  // require frequent IDR frames, however. Without them a WHEP viewer that
  // joins after startup receives P-frames only and remains on "preparing"
  // until the screen changes enough for Android to emit another keyframe.
  return {
    videoCodecOptions: new ScrcpyCodecOptions({
      iFrameInterval: bounded(
        requestedOptions.iFrameIntervalSeconds,
        1,
        10,
        bounded(config.screenIFrameIntervalSeconds, 1, 10, 1)
      ),
      bitrateMode: bounded(
        requestedOptions.encoderBitrateMode,
        0,
        2,
        bounded(config.screenEncoderBitrateMode, 0, 2, 2)
      )
    })
  };
}

export function createScreenScrcpyOptions({ requestedOptions = {}, maxSize, config, video = true, control = true, sessionId = "", channel = "video" }) {
  // Reverse tunnelling uses `localabstract:scrcpy` when no SCID is supplied.
  // Reusing that name lets a delayed teardown of the previous session remove
  // the listener which the next server has just connected to.  Give every
  // platform session a stable SCID so its server socket has an independent
  // name (`scrcpy_<scid>`). The Android server parses it as a *signed* Java
  // int, so keep it within 0x0fffffff instead of accepting all 8 hex digits.
  const sessionHex = String(sessionId || "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  const scid = `${channel === "control" ? "c" : ""}${sessionHex}`.slice(0, 7);
  const videoEncoder = normalizeScreenVideoEncoder(requestedOptions.videoEncoder);
  return new AdbScrcpyOptions3_3_3({
    video,
    audio: false,
    control,
    ...(scid ? { scid } : {}),
    tunnelForward: false,
    videoCodec: "h264",
    ...(videoEncoder ? { videoEncoder } : {}),
    ...createScreenVideoCodecOptions(config, requestedOptions),
    maxSize,
    maxFps: boundedByConfiguredCeiling(requestedOptions.maxFps, 5, 60, config.screenMaxFps, 60),
    videoBitRate: boundedByConfiguredCeiling(
      requestedOptions.videoBitRate,
      500_000,
      12_000_000,
      config.screenVideoBitRate,
      8_000_000
    ),
    sendFrameMeta: true,
    sendDeviceMeta: true,
    sendCodecMeta: true,
    sendDummyByte: true,
    stayAwake: true,
    powerOffOnClose: false,
    // The library registers clipboard write acknowledgements behind this
    // switch. Inbound clipboard values are intentionally not forwarded.
    clipboardAutosync: true,
    cleanup: false
  }, { version: "3.3.4" });
}

export function screenControlIsolationEnabled(config = {}, serial = "") {
  const deviceValue = config.screenDeviceProfiles?.[serial]?.isolateControl;
  return typeof deviceValue === "boolean" ? deviceValue : config.screenIsolateControlEnabled === true;
}

export function screenSourceRecoveryEnabled(config = {}, serial = "", requestedOptions = {}) {
  const requestedValue = requestedOptions.sourceRecoveryEnabled;
  if (typeof requestedValue === "boolean") return requestedValue;
  const deviceValue = config.screenDeviceProfiles?.[serial]?.sourceRecovery;
  return typeof deviceValue === "boolean" ? deviceValue : config.screenSourceRecoveryEnabled === true;
}

export function screenViewerKeyframeResetEnabled(config = {}, serial = "", requestedOptions = {}) {
  const requestedValue = requestedOptions.viewerKeyframeResetEnabled;
  if (typeof requestedValue === "boolean") return requestedValue;
  const deviceValue = config.screenDeviceProfiles?.[serial]?.viewerKeyframeReset;
  return typeof deviceValue === "boolean" ? deviceValue : config.screenViewerKeyframeResetEnabled === true;
}

export function resolveScreenSourceRecoveryPolicy({ requestedOptions = {}, config = {}, serial = "" }) {
  return {
    enabled: screenSourceRecoveryEnabled(config, serial, requestedOptions),
    maxAttempts: bounded(
      requestedOptions.sourceRecoveryMaxAttempts,
      1,
      8,
      bounded(config.screenSourceRecoveryMaxAttempts, 1, 8, 3)
    ),
    windowSeconds: bounded(
      requestedOptions.sourceRecoveryWindowSeconds,
      10,
      300,
      bounded(config.screenSourceRecoveryWindowSeconds, 10, 300, 30)
    )
  };
}

export function resolveScreenRealtimeQueueLatencyMs({ requestedOptions = {}, config = {} }) {
  return bounded(
    requestedOptions.realtimeQueueLatencyMs,
    100,
    1_500,
    bounded(config.screenRealtimeQueueLatencyMs, 100, 1_500, 400)
  );
}

export function resolveScreenKeyframeRecoveryCooldownMs({ requestedOptions = {}, config = {} }) {
  return bounded(
    requestedOptions.keyframeRecoveryCooldownMs,
    500,
    10_000,
    bounded(config.screenKeyframeRecoveryCooldownMs, 500, 10_000, 2_000)
  );
}

export function screenSourceRecoveryDelayMs(attempt) {
  const delays = [200, 500, 1_000, 2_000, 3_000, 4_000, 5_000, 5_000];
  const index = Math.max(0, Math.min(delays.length - 1, Math.round(Number(attempt || 1)) - 1));
  return delays[index];
}

// A device profile is the normal session ceiling. A versioned server hot
// policy may explicitly override selected fields, but the Agent-wide encoder
// capability ceiling is still enforced when scrcpy starts.
export function applyScreenDeviceProfile({ requestedOptions = {}, config = {}, serial = "" }) {
  const profile = config.screenDeviceProfiles?.[serial];
  if (!profile || typeof profile !== "object") return { ...requestedOptions };
  const options = { ...requestedOptions };
  const hotFields = new Set(
    Array.isArray(options.screenHotConfigFields)
      ? options.screenHotConfigFields.filter((key) => ["maxFps", "videoBitRate", "maxSize"].includes(key))
      : []
  );
  for (const key of ["maxFps", "videoBitRate", "maxSize"]) {
    if (hotFields.has(key)) continue;
    const ceiling = Number(profile[key]);
    if (!Number.isFinite(ceiling) || ceiling <= 0) continue;
    const requested = Number(options[key]);
    options[key] = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, ceiling)
      : ceiling;
  }
  return options;
}

// Encoder bitrate controls the sustained media budget; transport pacing is a
// separate, short-lived wire-rate ceiling. A handset with a large but rare IDR
// needs the latter to be high enough to drain that one frame before its next
// P-frames arrive. Keep this device-scoped so concurrent phones retain the
// normal aggregate bandwidth budget.
export function resolveScreenTransportPacingBitRate({ requestedOptions = {}, config = {}, serial = "" }) {
  const requestedPacing = Number(requestedOptions.transportPacingBitRate);
  const profilePacing = Number(config.screenDeviceProfiles?.[serial]?.transportPacingBitRate);
  const configuredPacing = Number(config.screenTransportPacingBitRate || 12_000_000);
  const requestedVideoBitRate = Number(requestedOptions.videoBitRate || 0);
  const selectedPacing = Number.isFinite(requestedPacing) && requestedPacing > 0
    ? requestedPacing
    : (Number.isFinite(profilePacing) && profilePacing > 0 ? profilePacing : configuredPacing);
  return Math.max(
    requestedVideoBitRate,
    Math.max(2_000_000, Math.min(48_000_000, Math.round(selectedPacing || 12_000_000)))
  );
}

// Packet grouping changes the instantaneous UDP burst size, not the encoder
// bitrate. Keep it independently device-scoped so two canaries can use smaller
// groups while every other session retains the established eight-packet path.
export function resolveScreenTransportPacketsPerBurst({ requestedOptions = {}, config = {}, serial = "" }) {
  const requestedValue = Number(requestedOptions.transportPacketsPerBurst);
  const profileValue = Number(config.screenDeviceProfiles?.[serial]?.transportPacketsPerBurst);
  const configuredValue = Number(config.screenTransportPacketsPerBurst || 2);
  const selected = Number.isFinite(requestedValue) && requestedValue > 0
    ? requestedValue
    : (Number.isFinite(profileValue) && profileValue > 0 ? profileValue : configuredValue);
  return Math.max(1, Math.min(8, Math.round(Number(selected) || 8)));
}

// The baseline stays at the proven global pacing rate. Only an explicitly
// enabled device profile may enter the temporary mid/max tiers, and the Go
// publisher decides when to move tiers from its real pending-byte backlog.
export function resolveScreenTransportAdaptivePacing({ requestedOptions = {}, config = {}, serial = "", baselineBitRate = 12_000_000 }) {
  const deviceValue = config.screenDeviceProfiles?.[serial]?.transportAdaptivePacing;
  const enabled = typeof requestedOptions.transportAdaptivePacing === "boolean"
    ? requestedOptions.transportAdaptivePacing
    : (typeof deviceValue === "boolean" ? deviceValue : config.screenTransportAdaptivePacingEnabled === true);
  const baseline = Math.max(2_000_000, Math.min(48_000_000, Math.round(Number(baselineBitRate) || 12_000_000)));
  const midBitRate = Math.max(
    baseline,
    Math.min(48_000_000, Math.round(Number(config.screenTransportAdaptiveMidBitRate) || 15_000_000))
  );
  const maxBitRate = Math.max(
    midBitRate,
    Math.min(48_000_000, Math.round(Number(config.screenTransportAdaptiveMaxBitRate) || 20_000_000))
  );
  const upThresholdMs = Math.max(40, Math.min(1_000, Math.round(Number(config.screenTransportAdaptiveUpThresholdMs) || 160)));
  const maxThresholdMs = Math.max(upThresholdMs + 1, Math.min(1_500, Math.round(Number(config.screenTransportAdaptiveMaxThresholdMs) || 260)));
  const downThresholdMs = Math.max(10, Math.min(upThresholdMs - 1, Math.round(Number(config.screenTransportAdaptiveDownThresholdMs) || 80)));
  const holdMs = Math.max(100, Math.min(2_000, Math.round(Number(config.screenTransportAdaptiveHoldMs) || 300)));
  return {
    enabled,
    midBitRate,
    maxBitRate,
    upThresholdMs,
    maxThresholdMs,
    downThresholdMs,
    holdMs
  };
}

// Browser feedback controls only RTP packet grouping, never the encoder or
// the proven drain rate. A loss burst switches two-packet writes to one-packet
// writes without creating a source-side queue; recovery is deliberately slow.
export function resolveScreenTransportReceiverFeedback({ requestedOptions = {}, config = {}, serial = "" }) {
  const deviceValue = config.screenDeviceProfiles?.[serial]?.transportReceiverFeedback;
  const enabled = typeof requestedOptions.transportReceiverFeedback === "boolean"
    ? requestedOptions.transportReceiverFeedback
    : (typeof deviceValue === "boolean" ? deviceValue : config.screenTransportReceiverFeedbackEnabled === true);
  return {
    enabled,
    stableHoldMs: Math.max(5_000, Math.min(60_000, Math.round(
      Number(requestedOptions.transportReceiverStableHoldMs)
      || Number(config.screenTransportReceiverStableHoldMs)
      || 15_000
    )))
  };
}

export function parseScrcpyFallbackMaxSize(line) {
  const match = String(line || "").match(/Retrying with -m(\d+)/i);
  const maxSize = Number(match?.[1] || 0);
  return Number.isInteger(maxSize) && maxSize >= 480 && maxSize <= 2160 ? maxSize : 0;
}

export function isScrcpyDiagnosticLine(line) {
  return /\b(?:WARN|ERROR)\b|Exception|Ignore positional event|inject(?:ing|ion)?/i.test(String(line || ""));
}

export function mapScreenControlCoordinates(message, actualSize = {}) {
  const sourceWidth = Math.max(1, Number(message?.videoWidth || actualSize.width || 1));
  const sourceHeight = Math.max(1, Number(message?.videoHeight || actualSize.height || 1));
  const videoWidth = Math.max(1, Math.round(Number(actualSize.width || sourceWidth)));
  const videoHeight = Math.max(1, Math.round(Number(actualSize.height || sourceHeight)));
  return {
    x: Math.min(videoWidth - 1, Math.max(0, Math.round(Number(message?.x || 0) / sourceWidth * videoWidth))),
    y: Math.min(videoHeight - 1, Math.max(0, Math.round(Number(message?.y || 0) / sourceHeight * videoHeight))),
    videoWidth,
    videoHeight
  };
}

export async function selectScrcpyStartupOutcome({ firstPacketPromise, fallbackPromise }) {
  return Promise.race([
    firstPacketPromise.then((packet) => ({ type: "packet", packet })),
    fallbackPromise.then((maxSize) => ({ type: "fallback", maxSize }))
  ]);
}

export function devicePowerState(output) {
  const text = String(output || "");
  if (/mWakefulness=(?:Awake|Dreaming)\b/i.test(text) || /Display Power:\s*state=ON\b/i.test(text)) return "awake";
  if (/mWakefulness=(?:Asleep|Dozing)\b/i.test(text) || /Display Power:\s*state=OFF\b/i.test(text)) return "asleep";
  return "unknown";
}

export async function ensureDeviceAwake({
  adbPath,
  serial,
  remoteWakeHelperPath = "",
  refreshActivity = false,
  run = execFileAsync
}) {
  const commandOptions = { timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024 };
  // Some vendor builds append a very large wake-lock history to `dumpsys
  // power`. We only need the wakefulness line; collecting the whole dump can
  // overflow Node's stdout buffer and reject an otherwise healthy phone
  // before scrcpy starts.
  const powerCommand = "dumpsys power | grep -m 1 mWakefulness";
  const { stdout = "" } = await run(adbPath, ["-s", serial, "shell", powerCommand], commandOptions);
  const powerState = devicePowerState(stdout);
  const wakeRequested = powerState !== "awake";
  const wakeRefreshRequested = refreshActivity && powerState === "awake";
  let wakeMethod = "none";
  let wakeHelperFailed = false;
  if (wakeRequested || wakeRefreshRequested) {
    if (remoteWakeHelperPath) {
      // The helper uses hidden Android APIs and is not portable across every
      // vendor build.  Its failure must not abort screen startup while the
      // standard, non-toggling KEYCODE_WAKEUP path remains available.
      try {
        await run(adbPath, ["-s", serial, "shell", `CLASSPATH=${remoteWakeHelperPath} app_process / com.phonecloud.wake.Main`], commandOptions);
        wakeMethod = "helper";
      } catch {
        wakeHelperFailed = true;
        await run(adbPath, ["-s", serial, "shell", "input", "keyevent", "224"], commandOptions);
        wakeMethod = "keycode_wakeup_after_helper_failure";
      }
    } else {
      // KEYCODE_WAKEUP is idempotent: unlike KEYCODE_POWER it can never turn
      // an already-awake display off.  Alipay/Poco startup also uses this as a
      // bounded activity refresh before each instrumentation attach so an OEM
      // screen timeout cannot suspend TestActivity halfway through UiAutomation
      // registration.
      await run(adbPath, ["-s", serial, "shell", "input", "keyevent", "224"], commandOptions);
      wakeMethod = wakeRefreshRequested ? "keycode_wakeup_refresh" : "keycode_wakeup";
    }
  }
  await run(adbPath, ["-s", serial, "shell", "wm", "dismiss-keyguard"], commandOptions);
  if (!wakeRequested && !wakeRefreshRequested) {
    return { powerState, finalPowerState: powerState, wakeRequested: false, wakeRefreshRequested: false, wakeMethod };
  }
  let { stdout: finalOutput = "" } = await run(adbPath, ["-s", serial, "shell", powerCommand], commandOptions);
  let finalPowerState = devicePowerState(finalOutput);
  if (finalPowerState === "asleep") {
    await run(adbPath, ["-s", serial, "shell", "input", "keyevent", "224"], commandOptions);
    wakeMethod = remoteWakeHelperPath && !wakeHelperFailed
      ? "keycode_wakeup_after_helper_no_effect"
      : `${wakeMethod || "keycode_wakeup"}_retry`;
    await run(adbPath, ["-s", serial, "shell", "wm", "dismiss-keyguard"], commandOptions);
    ({ stdout: finalOutput = "" } = await run(adbPath, ["-s", serial, "shell", powerCommand], commandOptions));
    finalPowerState = devicePowerState(finalOutput);
  }
  return {
    powerState,
    finalPowerState,
    wakeRequested,
    wakeRefreshRequested,
    wakeMethod,
    wakeHelperFailed
  };
}

export async function dismissVendorScreenGuard({ adbPath, serial, controller, run = execFileAsync }) {
  const { stdout = "" } = await run(adbPath, ["-s", serial, "shell", "dumpsys", "window"], {
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 512 * 1024
  });
  const detected = /ScreenOnProximitySensorGuide/i.test(String(stdout || ""));
  if (detected) await injectScreenKey(controller, "volume_up");
  return { detected };
}

export async function inspectScrcpyInputCapability({ adbPath, serial, run = execFileAsync }) {
  try {
    const { stdout = "" } = await run(adbPath, ["-s", serial, "shell", "getprop", "persist.security.adbinput"], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024
    });
    const securityInputSetting = String(stdout || "").trim();
    return {
      ready: securityInputSetting !== "0",
      securityInputSetting
    };
  } catch {
    return {
      ready: true,
      securityInputSetting: ""
    };
  }
}

export function createScreenStreamManager(options) {
  return new ScreenStreamManager(options);
}

export function createScreenAdbOwner(adb) {
  if (!adb || typeof adb.close !== "function") throw new TypeError("screen_adb_owner_requires_closeable_adb");
  let closePromise = null;
  let closed = false;
  return {
    adb,
    get closed() {
      return closed;
    },
    close() {
      if (closed) return Promise.resolve();
      if (!closePromise) {
        closePromise = Promise.resolve()
          .then(() => adb.close())
          .then(() => {
            closed = true;
          })
          .catch((error) => {
            closePromise = null;
            throw error;
          });
      }
      return closePromise;
    }
  };
}

class ScreenStreamManager {
  constructor(options) {
    this.config = options.config;
    this.agentDir = options.agentDir;
    this.log = options.log || (() => {});
    this.preemptSerial = options.preemptSerial || (async () => {});
    this.reserveSerial = options.reserveSerial || (() => true);
    this.releaseSerial = options.releaseSerial || (() => {});
    this.waitForSerialIdle = options.waitForSerialIdle || (async () => true);
    this.beforeSessionStart = options.beforeSessionStart || (async () => {});
    this.afterSessionEnd = options.afterSessionEnd || (async () => {});
    this.sessions = new Map();
    this.adbOwners = new Set();
    // A stop can arrive while a screen_start is still waiting for ADB or the
    // automation worker. Keep a short-lived cancellation marker so that a
    // late start cannot resurrect a session the server has already closed.
    this.cancelledStartSessions = new Map();
    this.preparedSerials = new Set();
    this.preparedWakeHelperSerials = new Set();
    this.compatibleMaxSizes = new Map();
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = 1_000;
    this.closed = false;
    this.keepAliveTimer = null;
    this.cleanupTimeoutMs = bounded(this.config.screenCleanupTimeoutMs, 20, 10_000, 1_500);
    this.cleanupGraceMs = bounded(this.config.screenCleanupGraceMs, 0, 5_000, 800);
    this.serverJar = this.config.scrcpyServerPath || path.join(this.agentDir, "vendor", "scrcpy-server-v3.3.4");
    this.wakeHelperJar = this.config.screenWakeHelperPath || path.join(this.agentDir, "vendor", "phone-cloud-wake.jar");
  }

  start() {
    if (!this.config.screenStreamEnabled || this.closed) return;
    if (!existsSync(this.serverJar)) {
      this.log("screen relay disabled", { error: `scrcpy server not found: ${this.serverJar}` });
      return;
    }
    this.connect();
  }

  health() {
    const sessionOwners = new Set();
    for (const session of this.sessions.values()) {
      for (const owner of [
        ...(session.adbOwners || []),
        session.videoAdbOwner,
        session.controlAdbOwner
      ].filter(Boolean)) sessionOwners.add(owner);
    }
    const owners = new Set([...this.adbOwners, ...sessionOwners]);
    const activeOwners = [...owners].filter((owner) => !owner.closed);
    return {
      enabled: Boolean(this.config.screenStreamEnabled),
      connected: this.socket?.readyState === WebSocket.OPEN,
      activeSessions: this.sessions.size,
      adbOwners: activeOwners.length,
      orphanedAdbOwners: activeOwners.filter((owner) => !sessionOwners.has(owner)).length,
      serverJarReady: existsSync(this.serverJar),
      serverJar: this.serverJar,
      wakeHelperReady: existsSync(this.wakeHelperJar)
    };
  }

  connect() {
    if (this.closed || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    const url = buildScreenRelayUrl(this.config.serverBaseUrl, this.config.agentId);
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.config.agentToken}` }, handshakeTimeout: 15_000 });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectDelayMs = 1_000;
      socket.isAlive = true;
      this.log("screen relay connected", { url });
      this.sendJson({
        type: "screen_capabilities",
        transports: ["multiplexed", "split-v1"],
        mediaTransports: [
          ...(this.webrtcPublisherReady() ? ["webrtc-rtsp-v1"] : []),
          ...(this.directWebRtcPublisherReady() ? ["webrtc-direct-v1"] : [])
        ],
        maxSize: this.config.screenMaxSize,
        maxFps: this.config.screenMaxFps,
        maxVideoBitRate: this.config.screenVideoBitRate,
        maxConcurrentSessions: this.config.screenMaxConcurrentSessions
      });
      // Screen sessions are owned by the server. If it restarted while this
      // Agent stayed alive, this inventory lets the server explicitly stop
      // orphaned scrcpy / ffmpeg processes instead of leaving devices locked.
      this.sendJson({
        type: "screen_session_inventory",
        sessions: [...this.sessions.values()].map((session) => ({
          sessionId: session.sessionId,
          serial: session.serial
        }))
      });
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.isAlive === false) {
          this.log("screen relay heartbeat timed out", { url });
          socket.terminate();
          return;
        }
        socket.isAlive = false;
        socket.ping();
        this.sendJson({ type: "screen_keepalive", at: new Date().toISOString() });
      }, 15_000);
      this.keepAliveTimer.unref?.();
    });
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.handleMessage(JSON.parse(data.toString("utf8"))).catch((error) => this.log("screen relay message failed", error?.stack || error?.message || error));
    });
    socket.on("error", (error) => this.log("screen relay error", error.message));
    socket.on("close", (code, reason) => {
      this.log("screen relay closed", {
        code: Number(code || 0),
        reason: Buffer.from(reason || "").toString("utf8").slice(0, 180),
        activeSessions: this.sessions.size
      });
      if (this.socket === socket) this.socket = null;
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      this.closeAll("relay_disconnected").catch(() => {});
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async handleMessage(message) {
    if (message?.type === "screen_start") {
      this.log("screen start requested", { sessionId: String(message.sessionId || ""), serial: String(message.adbSerial || "") });
      return this.startSession(message);
    }
    if (message?.type === "screen_stop") {
      const sessionId = String(message.sessionId || "");
      this.rememberCancelledStart(sessionId);
      this.log("screen stop requested", { sessionId, reason: message.reason || "remote_stop", active: this.sessions.has(sessionId) });
      await this.closeSession(sessionId, message.reason || "remote_stop");
      this.log("screen stop completed", { sessionId, active: this.sessions.has(sessionId) });
      return;
    }
    if (message?.type === "screen_control") return this.handleControl(message.sessionId, message.control);
    if (message?.type === "screen_media_reader_ready") {
      return this.handleMediaReaderReady(message.sessionId, message.generation);
    }
    if (message?.type === "screen_playback_feedback") {
      return this.handlePlaybackFeedback(message.sessionId, message.metrics);
    }
  }

  async startSession(message) {
    const sessionId = String(message.sessionId || "");
    const serial = String(message.adbSerial || "");
    if (this.isStartCancelled(sessionId)) {
      this.log("screen start ignored after prior stop", { sessionId, serial });
      return;
    }
    const requestedAtMs = Date.now();
    const phase = async (name, operation) => {
      const startedAt = Date.now();
      try {
        return await operation();
      } finally {
        this.log("screen preparation phase", {
          sessionId,
          serial,
          phase: name,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          totalElapsedMs: Math.max(0, Date.now() - requestedAtMs)
        });
      }
    };
    if (!sessionId || !serial) return;
    if (this.sessions.has(sessionId)) return;
    if (this.sessions.size >= this.config.screenMaxConcurrentSessions) {
      this.sendStatus(sessionId, "failed", "Windows 管理器实时控制并发已满，请稍后重试");
      return;
    }
    await phase("wait_closing_session", () => this.waitForClosingSession(serial));
    if ([...this.sessions.values()].some((item) => item.serial === serial)) {
      this.sendStatus(sessionId, "failed", "这台手机正在执行其他控制任务");
      return;
    }
    try {
      await phase("preempt_background_work", () => this.preemptSerial(serial));
    } catch (error) {
      this.log("screen priority preemption failed", { sessionId, serial, error: error?.message || String(error) });
    }
    if (this.isStartCancelled(sessionId)) {
      this.log("screen start cancelled before serial reservation", { sessionId, serial });
      return;
    }
    const reserved = await phase("reserve_device_channel", () => waitForSerialReservation({
      serial,
      reserveSerial: this.reserveSerial,
      timeoutMs: SCREEN_SERIAL_WAIT_MS,
      onWaiting: () => this.sendStatus(sessionId, "preparing", "投屏优先，正在暂停当前后台操作")
    }));
    if (!reserved) {
      this.sendStatus(sessionId, "failed", "设备通道繁忙，请稍后重试");
      return;
    }
    if (this.isStartCancelled(sessionId)) {
      this.releaseSerial(serial);
      this.log("screen start cancelled after serial reservation", { sessionId, serial });
      return;
    }
    try {
      await phase("wait_adb_idle", () => this.waitForSerialIdle(serial));
      await phase("pause_automation", () => this.beforeSessionStart(serial));
    } catch (error) {
      this.releaseSerial(serial);
      this.log("screen session preparation failed", { sessionId, serial, error: error?.message || String(error) });
      this.sendStatus(sessionId, "failed", friendlyScreenError(error));
      return;
    }
    if (this.isStartCancelled(sessionId)) {
      this.releaseSerial(serial);
      await this.afterSessionEnd(serial, "screen_stop_before_start").catch((error) => {
        this.log("screen start cancellation cleanup failed", { sessionId, serial, error: error?.message || String(error) });
      });
      this.log("screen start cancelled before session creation", { sessionId, serial });
      return;
    }
    const session = {
      sessionId,
      serial,
      startedAtMs: Date.now(),
      videoClient: null,
      videoAdbOwner: null,
      adbOwners: new Set(),
      controlClient: null,
      controlAdbOwner: null,
      reader: null,
      controlQueue: null,
      controlGeneration: 0,
      controlRecovering: false,
      controlRecoveryPromise: null,
      requestedOptions: applyScreenDeviceProfile({
        requestedOptions: message.options || {},
        config: this.config,
        serial
      }),
      transportMode: message.transportMode === "split-v1" ? "split-v1" : "multiplexed",
      media: ["webrtc", "direct_webrtc"].includes(message.media?.mode) ? message.media : { mode: "websocket" },
      videoChannel: null,
      videoChannelFailed: false,
      mediaPublisher: null,
      mediaPacketDiagnostics: 0,
      viewerKeyframeRecovery: {
        attempts: 0,
        pending: false,
        completed: false,
        generation: 0
      },
      captureTimeline: null,
      visualLatencyProbe: null,
      mediaWriteError: null,
      mediaWaitingForKeyframe: false,
      receiverFeedbackEnabled: false,
      latestVideoConfiguration: null,
      videoWidth: 0,
      videoHeight: 0,
      closed: false
    };
    session.videoBackpressure = createVideoBackpressureGate();
    this.sessions.set(sessionId, session);
    if (this.config.screenDeviceProfiles?.[serial]) {
      this.log("screen device profile applied", {
        sessionId,
        serial,
        profile: this.config.screenDeviceProfiles[serial],
        effectiveOptions: session.requestedOptions
      });
    }
    this.runSession(session, session.requestedOptions)
      .then(() => this.closeSession(sessionId, "stream_ended", true))
      .catch((error) => {
        const serverOutput = Array.isArray(error?.output) ? error.output.join("\n").slice(0, 4000) : "";
        this.log("screen session failed", { sessionId, serial, error: error?.stack || error?.message || error, serverOutput });
        this.sendStatus(sessionId, "failed", friendlyScreenError(error));
        return this.closeSession(sessionId, "session_failed", false);
      });
  }

  async runSession(session, requestedOptions) {
    const phase = async (name, operation) => {
      const startedAt = Date.now();
      try {
        return await operation();
      } finally {
        this.log("screen startup phase", {
          sessionId: session.sessionId,
          serial: session.serial,
          phase: name,
          elapsedMs: Math.max(0, Date.now() - startedAt)
        });
      }
    };
    if (["webrtc", "direct_webrtc"].includes(session.media.mode) && !this.webrtcPublisherReady()) {
      throw new Error("screen_webrtc_publisher_unavailable");
    }
    if (!["webrtc", "direct_webrtc"].includes(session.media.mode) && session.transportMode === "split-v1") {
      session.videoChannel = await openScreenVideoChannel({
        serverBaseUrl: this.config.serverBaseUrl,
        sessionId: session.sessionId,
        agentId: this.config.agentId,
        agentToken: this.config.agentToken
      });
      session.videoChannel.socket.once("close", () => {
        if (session.closed) return;
        session.videoChannelFailed = true;
        session.reader?.cancel().catch(() => {});
      });
    }
    this.sendStatus(session.sessionId, "preparing", "正在准备手机画面");
    try {
      await phase("wake_helper", () => this.ensureWakeHelper(session.serial));
      this.log("screen wake deferred", {
        sessionId: session.sessionId,
        serial: session.serial,
        policy: "after_whep_ice_connected"
      });
    } catch (error) {
      this.log("screen wake helper preparation failed", { sessionId: session.sessionId, serial: session.serial, error: error?.message || String(error) });
      throw error;
    }
    const inputCapability = await phase("input_capability", () => inspectScrcpyInputCapability({
      adbPath: this.config.adbPath,
      serial: session.serial
    }));
    this.log("screen input capability checked", {
      sessionId: session.sessionId,
      serial: session.serial,
      ...inputCapability
    });
    if (!inputCapability.ready) {
      const error = new Error("手机未开启“USB 调试（安全设置）”，当前只能投屏不能控制。请在开发者选项开启“允许通过 USB 调试模拟输入”，重启手机后再连接。");
      error.code = "screen_input_security_disabled";
      throw error;
    }
    await phase("scrcpy_server", () => this.ensureServerJar(session.serial));
    const requestedMaxSize = boundedByConfiguredCeiling(
      requestedOptions.maxSize,
      480,
      2_160,
      this.config.screenMaxSize,
      1_600
    );
    let maxSize = Math.min(requestedMaxSize, this.compatibleMaxSizes.get(session.serial) || requestedMaxSize);
    session.maxSize = maxSize;
    let encoderRestarts = 0;
    let sourceGeneration = 0;
    const sourceRecoveryAttempts = [];
    session.controlIsolated = screenControlIsolationEnabled(this.config, session.serial);
    const sourceRecoveryPolicy = resolveScreenSourceRecoveryPolicy({
      requestedOptions,
      config: this.config,
      serial: session.serial
    });
    session.sourceRecoveryEnabled = sourceRecoveryPolicy.enabled;
    session.sourceRecoveryMaxAttempts = sourceRecoveryPolicy.maxAttempts;
    session.sourceRecoveryWindowSeconds = sourceRecoveryPolicy.windowSeconds;
    session.viewerKeyframeResetEnabled = screenViewerKeyframeResetEnabled(this.config, session.serial, requestedOptions);
    session.iFrameIntervalSeconds = bounded(
      requestedOptions.iFrameIntervalSeconds,
      1,
      10,
      bounded(this.config.screenIFrameIntervalSeconds, 1, 10, 1)
    );
    session.keyframeRecoveryCooldownMs = resolveScreenKeyframeRecoveryCooldownMs({
      requestedOptions,
      config: this.config
    });
    this.log("screen scrcpy lifecycle policy", {
      sessionId: session.sessionId,
      serial: session.serial,
      transportPolicyRevision: Math.max(0, Math.round(Number(requestedOptions.transportPolicyRevision || 0))),
      hotConfigFields: Array.isArray(requestedOptions.screenHotConfigFields)
        ? requestedOptions.screenHotConfigFields
        : [],
      maxSize,
      maxFps: boundedByConfiguredCeiling(
        requestedOptions.maxFps,
        5,
        60,
        this.config.screenMaxFps,
        60
      ),
      videoBitRate: boundedByConfiguredCeiling(
        requestedOptions.videoBitRate,
        500_000,
        12_000_000,
        this.config.screenVideoBitRate,
        8_000_000
      ),
      videoEncoder: normalizeScreenVideoEncoder(requestedOptions.videoEncoder) || "auto",
      encoderBitrateMode: bounded(
        requestedOptions.encoderBitrateMode,
        0,
        2,
        bounded(this.config.screenEncoderBitrateMode, 0, 2, 2)
      ),
      realtimeQueueLatencyMs: resolveScreenRealtimeQueueLatencyMs({ requestedOptions, config: this.config }),
      controlIsolated: session.controlIsolated,
      sourceRecoveryEnabled: session.sourceRecoveryEnabled,
      sourceRecoveryMaxAttempts: session.sourceRecoveryMaxAttempts,
      sourceRecoveryWindowSeconds: session.sourceRecoveryWindowSeconds,
      viewerKeyframeResetEnabled: session.viewerKeyframeResetEnabled,
      iFrameIntervalSeconds: session.iFrameIntervalSeconds,
      keyframeRecoveryCooldownMs: session.keyframeRecoveryCooldownMs
    });
    if (session.controlIsolated) {
      await phase("scrcpy_control_start", () => this.startControlClient(session));
    }

    while (!session.closed) {
      sourceGeneration += 1;
      const videoGeneration = sourceGeneration;
      session.videoSourceGeneration = videoGeneration;
      let videoClient;
      let videoAdbOwner;
      try {
        const connector = new AdbServerNodeTcpConnector({ host: this.config.adbServerHost, port: this.config.adbServerPort });
        const adbServer = new AdbServerClient(connector);
        const adb = await adbServer.createAdb({ serial: session.serial });
        videoAdbOwner = createScreenAdbOwner(adb);
        this.adbOwners.add(videoAdbOwner);
        session.adbOwners.add(videoAdbOwner);
        session.videoAdbOwner = videoAdbOwner;
        if (session.closed) {
          await this.releaseAdbOwner(session, "videoAdbOwner", videoAdbOwner, "video_adb_close_after_session_closed");
          return;
        }
        const options = createScreenScrcpyOptions({
          requestedOptions,
          maxSize,
          config: this.config,
          video: true,
          // User input still uses the isolated control session. This source-
          // local control socket exists only for the one-shot ResetVideo that
          // gives each new WHEP reader a decoder-safe configuration + IDR.
          control: !session.controlIsolated || session.viewerKeyframeResetEnabled,
          sessionId: session.sessionId,
          channel: "video"
        });
        videoClient = await phase("scrcpy_video_start", () => AdbScrcpyClient.start(adb, REMOTE_SERVER_PATH, options));
        if (session.closed) {
          try { await videoClient.close(); } catch {}
          await this.releaseAdbOwner(session, "videoAdbOwner", videoAdbOwner, "video_adb_close_after_session_closed");
          return;
        }
      } catch (error) {
        await this.releaseAdbOwner(session, "videoAdbOwner", videoAdbOwner, "video_adb_close_after_start_failure");
        if (!this.reserveSourceRecoveryAttempt(session, sourceRecoveryAttempts)) throw error;
        const attempt = sourceRecoveryAttempts.length;
        const delayMs = screenSourceRecoveryDelayMs(attempt);
        this.log("scrcpy video source recovery retry", {
          sessionId: session.sessionId,
          serial: session.serial,
          generation: videoGeneration,
          attempt,
          delayMs,
          stage: "source_start",
          error: error?.message || String(error)
        });
        this.sendStatus(session.sessionId, "live", "手机 ADB 视频通道短暂中断，正在等待设备自动重连", {
          serial: session.serial,
          sourceGeneration: videoGeneration,
          recoveringSource: true,
          recoveryAttempt: attempt
        });
        session.mediaWaitingForKeyframe = true;
        session.latestVideoConfiguration = null;
        session.captureTimeline = null;
        session.mediaWriteError = null;
        await delay(delayMs);
        continue;
      }
      session.videoClient = videoClient;
      session.videoProcessEndedAtMs = 0;
      void videoClient.exited.then(() => {
        session.videoProcessEndedAtMs = Date.now();
        this.log("scrcpy channel ended", {
          sessionId: session.sessionId,
          serial: session.serial,
          channel: "video",
          generation: videoGeneration,
          event: "process_socket_closed",
          readerEndedAtMs: Number(session.videoReaderEndedAtMs || 0),
          deltaFromReaderMs: session.videoReaderEndedAtMs
            ? session.videoProcessEndedAtMs - session.videoReaderEndedAtMs
            : null
        });
      }).catch((error) => {
        session.videoProcessEndedAtMs = Date.now();
        this.log("scrcpy channel ended", {
          sessionId: session.sessionId,
          serial: session.serial,
          channel: "video",
          generation: videoGeneration,
          event: "process_socket_error",
          error: error?.message || String(error)
        });
      });
      if (!session.controlIsolated && !session.controlClient && !session.controlRecovering) {
        await phase("scrcpy_control_bind", () => this.startControlClient(session));
      }
      const outputMonitor = monitorScrcpyOutput(videoClient.output, (line) => {
        this.log("scrcpy server output", { sessionId: session.sessionId, serial: session.serial, line });
      });
      const video = await videoClient.videoStream;
      const reader = video.stream.getReader();
      session.reader = reader;
      session.videoReaderEndedAtMs = 0;
      const startup = await phase("first_h264_packet", () => selectScrcpyStartupOutcome({
        firstPacketPromise: reader.read(),
        fallbackPromise: outputMonitor.fallbackPromise
      }));

      if (startup.type === "fallback") {
        const fallbackMaxSize = Number(startup.maxSize || 0);
        if (!fallbackMaxSize || fallbackMaxSize >= maxSize || encoderRestarts >= 3) {
          throw new Error(`scrcpy_encoder_fallback_failed:${maxSize}:${fallbackMaxSize}`);
        }
        encoderRestarts += 1;
        this.compatibleMaxSizes.set(session.serial, fallbackMaxSize);
        this.log("scrcpy encoder max size adapted", {
          sessionId: session.sessionId,
          serial: session.serial,
          from: maxSize,
          to: fallbackMaxSize,
          attempt: encoderRestarts
        });
        this.sendStatus(session.sessionId, "preparing", `正在适配手机画面（${fallbackMaxSize}）`);
        try { await reader.cancel(); } catch {}
        try { await videoClient.close(); } catch {}
        await this.releaseAdbOwner(session, "videoAdbOwner", videoAdbOwner, "video_adb_close_after_encoder_fallback");
        session.reader = null;
        session.videoClient = null;
        if (session.controlClient === videoClient) {
          session.controlQueue?.close("scrcpy_video_restarting");
          session.controlClient = null;
          session.controlQueue = null;
        }
        maxSize = fallbackMaxSize;
        session.maxSize = maxSize;
        await delay(300);
        continue;
      }

      const firstPacket = startup.packet;
      if (firstPacket.done) {
        throw new Error("scrcpy_video_stream_ended_before_first_frame");
      }
      this.updateSessionVideoSize(session, video);
      const metadata = {
        codec: video.metadata.codec || "h264",
        deviceName: video.metadata.deviceName || session.serial,
        serial: session.serial,
        maxSize,
        width: session.videoWidth,
        height: session.videoHeight
      };
      let sourceKeyframeAnnounced = false;
      const announceSourceKeyframeLive = () => {
        if (sourceKeyframeAnnounced || session.closed) return;
        sourceKeyframeAnnounced = true;
        this.sendStatus(
          session.sessionId,
          "live",
          videoGeneration > 1 ? "手机画面已自动恢复" : "手机关键帧已送达媒体服务，正在建立浏览器画面",
          { ...metadata, sourceGeneration: videoGeneration }
        );
      };
      session.onMediaReady = announceSourceKeyframeLive;
      if (["webrtc", "direct_webrtc"].includes(session.media.mode) && !session.mediaPublisher) {
        const pacingBitRate = resolveScreenTransportPacingBitRate({
          requestedOptions,
          config: this.config,
          serial: session.serial
        });
        const receiverFeedback = resolveScreenTransportReceiverFeedback({
          requestedOptions,
          config: this.config,
          serial: session.serial,
          baselineBitRate: pacingBitRate
        });
        session.receiverFeedbackEnabled = receiverFeedback.enabled;
        session.mediaPublisher = createScreenWebRtcPublisher({
          ffmpegPath: this.config.ffmpegPath,
          whipPublisherPath: this.config.screenWhipPublisherPath,
          mode: session.media.mode === "direct_webrtc" ? "direct_webrtc" : this.config.screenPublisherMode,
          publishUrl: session.media.mode === "direct_webrtc" ? session.media.signalUrl : session.media.publishUrl,
          agentToken: this.config.agentToken,
          iceServers: session.media.iceServers || [],
          h264ProfileLevelId: h264ProfileLevelId(firstPacket.value),
          frameRate: boundedByConfiguredCeiling(
            requestedOptions.maxFps,
            5,
            60,
            this.config.screenMaxFps,
            60
          ),
          pacingBitRate,
          adaptivePacing: resolveScreenTransportAdaptivePacing({
            requestedOptions,
            config: this.config,
            serial: session.serial,
            baselineBitRate: pacingBitRate
          }),
          receiverFeedback,
          maxPacketsPerBurst: resolveScreenTransportPacketsPerBurst({
            requestedOptions,
            config: this.config,
            serial: session.serial
          }),
          queueLatencyMs: resolveScreenRealtimeQueueLatencyMs({ requestedOptions, config: this.config }),
          statsIntervalMs: Math.round(Number(this.config.screenPublisherStatsIntervalSeconds || 0) * 1000),
          onLog: (entry) => this.log("screen WebRTC publisher", { sessionId: session.sessionId, serial: session.serial, ...entry }),
          onKeyframeRequest: (reason) => {
            void this.requestWebRtcKeyframe(session, reason);
          },
          onResyncRequired: () => {
            void this.requestWebRtcKeyframeRecovery(session, "publisher_overload");
          },
          onMediaReady: () => session.onMediaReady?.()
        });
        await phase(session.media.mode === "direct_webrtc" ? "direct_webrtc_start" : "ffmpeg_rtsp_start", () => session.mediaPublisher.start());
        metadata.decoderBackend = "webrtc";
      }
      if (["webrtc", "direct_webrtc"].includes(session.media.mode)) metadata.decoderBackend = "webrtc";
      const forwardAndAnnounceLive = async (packet) => {
        const forwarded = await this.forwardVideoPacket(session, packet);
        if (forwarded === false) return;
        // A configuration access unit alone makes the WHIP track visible to
        // MediaMTX but is not decodable video. WHEP readers can attach in that
        // gap, therefore don't advertise the source as live until a real IDR
        // has entered the publisher.
        if (session.media.mode === "webrtc" && this.config.screenPublisherMode === "whip") return;
        if (packet?.type !== "data" || !packet?.keyframe) return;
        announceSourceKeyframeLive();
      };
      const enqueueVideoPacket = (packet) => {
        if (!['webrtc', 'direct_webrtc'].includes(session.media.mode)) return forwardAndAnnounceLive(packet);
        void forwardAndAnnounceLive(packet).catch((error) => {
          if (session.closed || session.videoSourceGeneration !== videoGeneration || session.mediaWriteError) return;
          session.mediaWriteError = error;
          this.log("screen WebRTC source delivery failed", {
            sessionId: session.sessionId,
            serial: session.serial,
            error: error?.message || String(error)
          });
          session.reader?.cancel().catch(() => {});
        });
      };
      await enqueueVideoPacket(firstPacket.value);
      let streamError = null;
      let readerEnded = false;
      try {
        while (!session.closed && this.socket?.readyState === WebSocket.OPEN && this.videoTransportReady(session)) {
          if (session.mediaWriteError) throw session.mediaWriteError;
          const { done, value } = await reader.read();
          if (done) {
            readerEnded = true;
            session.videoReaderEndedAtMs = Date.now();
            this.log("scrcpy channel ended", {
              sessionId: session.sessionId,
              serial: session.serial,
              channel: "video",
              generation: videoGeneration,
              event: "reader_eof",
              processEndedAtMs: Number(session.videoProcessEndedAtMs || 0),
              deltaFromProcessMs: session.videoProcessEndedAtMs
                ? session.videoReaderEndedAtMs - session.videoProcessEndedAtMs
                : null
            });
            break;
          }
          this.updateSessionVideoSize(session, video);
          await enqueueVideoPacket(value);
        }
      } catch (error) {
        streamError = error;
      }
      if (session.videoChannelFailed) throw new Error("screen_video_channel_disconnected");
      if (streamError) throw streamError;
      const relayOpen = this.socket?.readyState === WebSocket.OPEN;
      const transportReady = this.videoTransportReady(session);
      this.log("screen stream loop ended", {
        sessionId: session.sessionId,
        serial: session.serial,
        reason: session.closed ? "session_closed" : readerEnded ? "reader_eof" : !relayOpen ? "relay_closed" : !transportReady ? "publisher_stopped" : "unknown"
      });
      if (session.closed) return;
      if (!relayOpen) throw new Error("screen_relay_disconnected");
      if (!transportReady) throw new Error("screen_media_publisher_stopped");
      if (readerEnded && this.reserveSourceRecoveryAttempt(session, sourceRecoveryAttempts)) {
        const attempt = sourceRecoveryAttempts.length;
        const delayMs = screenSourceRecoveryDelayMs(attempt);
        this.log("scrcpy video source recovery scheduled", {
          sessionId: session.sessionId,
          serial: session.serial,
          generation: videoGeneration,
          attempt,
          delayMs,
          publisherRunning: Boolean(session.mediaPublisher?.running),
          controlIsolated: session.controlIsolated
        });
        this.sendStatus(session.sessionId, "live", "手机视频源短暂中断，正在自动恢复，控制和媒体连接保持", {
          ...metadata,
          sourceGeneration: videoGeneration,
          recoveringSource: true,
          recoveryAttempt: attempt
        });
        session.mediaWaitingForKeyframe = true;
        session.latestVideoConfiguration = null;
        session.captureTimeline = null;
        session.mediaWriteError = null;
        session.reader = null;
        if (session.controlClient === videoClient) {
          session.controlQueue?.close("scrcpy_video_source_recovering");
          session.controlClient = null;
          session.controlQueue = null;
          session.controlRecovering = false;
        }
        session.videoClient = null;
        try { await reader.cancel(); } catch {}
        try { await videoClient.close(); } catch {}
        await this.releaseAdbOwner(session, "videoAdbOwner", videoAdbOwner, "video_adb_close_after_source_recovery");
        await delay(delayMs);
        continue;
      }
      if (readerEnded) throw new Error("scrcpy_video_stream_ended");
      return;
    }
  }

  async startControlClient(session) {
    if (session.closed) return null;
    let controlClient = session.videoClient;
    let controlAdbOwner = null;
    let transport = "shared_scrcpy_session";
    if (session.controlIsolated) {
      try {
        const connector = new AdbServerNodeTcpConnector({ host: this.config.adbServerHost, port: this.config.adbServerPort });
        const adbServer = new AdbServerClient(connector);
        const adb = await adbServer.createAdb({ serial: session.serial });
        controlAdbOwner = createScreenAdbOwner(adb);
        this.adbOwners.add(controlAdbOwner);
        session.adbOwners.add(controlAdbOwner);
        session.controlAdbOwner = controlAdbOwner;
        if (session.closed) {
          await this.releaseAdbOwner(session, "controlAdbOwner", controlAdbOwner, "control_adb_close_after_session_closed");
          return null;
        }
        const options = createScreenScrcpyOptions({
          requestedOptions: session.requestedOptions,
          maxSize: session.maxSize,
          config: this.config,
          video: false,
          control: true,
          sessionId: session.sessionId,
          channel: "control"
        });
        controlClient = await AdbScrcpyClient.start(adb, REMOTE_SERVER_PATH, options);
        transport = "isolated_control_only_scrcpy";
        monitorScrcpyOutput(controlClient.output, (line) => {
          this.log("scrcpy server output", { sessionId: session.sessionId, serial: session.serial, channel: "control", line });
        });
      } catch (error) {
        await this.releaseAdbOwner(session, "controlAdbOwner", controlAdbOwner, "control_adb_close_after_start_failure");
        throw error;
      }
    }
    if (!controlClient?.controller) {
      try { await controlClient?.close(); } catch {}
      await this.releaseAdbOwner(session, "controlAdbOwner", controlAdbOwner, "control_adb_close_when_unavailable");
      throw new Error("scrcpy_control_unavailable");
    }
    if (session.closed) {
      try { await controlClient.close(); } catch {}
      await this.releaseAdbOwner(session, "controlAdbOwner", controlAdbOwner, "control_adb_close_after_session_closed");
      return null;
    }
    session.controlClient = controlClient;
    this.installControlQueue(session, controlClient);
    const generation = session.controlGeneration;
    if (session.controlIsolated) {
      void controlClient.exited.then(() => {
        this.handleControlClientEnded(session, controlClient, generation, "process_socket_closed");
      }).catch((error) => {
        this.handleControlClientEnded(session, controlClient, generation, "process_socket_error", error);
      });
    }
    this.log("screen control channel ready", {
      sessionId: session.sessionId,
      serial: session.serial,
      generation: session.controlGeneration,
      transport
    });
    return controlClient;
  }

  async restartControlClient(session) {
    if (session.closed) return;
    const previous = session.controlClient;
    const previousAdbOwner = session.controlAdbOwner;
    session.controlClient = null;
    session.controlQueue = null;
    if (session.controlIsolated && previous && previous !== session.videoClient) {
      try { await previous.close(); } catch {}
    }
    await this.releaseAdbOwner(session, "controlAdbOwner", previousAdbOwner, "control_adb_close_before_recovery");
    const maximum = session.sourceRecoveryEnabled
      ? bounded(session.sourceRecoveryMaxAttempts, 1, 8, 3)
      : 1;
    let lastError = null;
    for (let attempt = 1; attempt <= maximum && !session.closed; attempt += 1) {
      await delay(attempt === 1 ? 100 : screenSourceRecoveryDelayMs(attempt));
      try {
        await this.startControlClient(session);
        if (!session.closed) this.sendStatus(session.sessionId, "live", "控制通道已重新绑定");
        return;
      } catch (error) {
        lastError = error;
        this.log("screen control recovery retry", {
          sessionId: session.sessionId,
          serial: session.serial,
          attempt,
          maximum,
          error: error?.message || String(error)
        });
      }
    }
    if (!session.closed) throw lastError || new Error("scrcpy_control_recovery_exhausted");
  }

  handleControlClientEnded(session, client, generation, event, error = null) {
    this.log("scrcpy channel ended", {
      sessionId: session.sessionId,
      serial: session.serial,
      channel: "control",
      generation,
      event,
      error: error?.message || (error ? String(error) : "")
    });
    if (session.closed || session.controlClient !== client || session.controlGeneration !== generation) return;
    this.requestControlRecovery(session, { type: "internal", action: "channel_ended", sequenceId: 0 }, generation);
  }

  reserveSourceRecoveryAttempt(session, attempts) {
    if (
      !session.sourceRecoveryEnabled
      || !["webrtc", "direct_webrtc"].includes(session.media?.mode)
      || !session.mediaPublisher?.running
      || this.socket?.readyState !== WebSocket.OPEN
    ) return false;
    const now = Date.now();
    const windowMs = bounded(session.sourceRecoveryWindowSeconds, 10, 300, 30) * 1_000;
    const maximum = bounded(session.sourceRecoveryMaxAttempts, 1, 8, 3);
    while (attempts.length && now - attempts[0] > windowMs) attempts.shift();
    if (attempts.length >= maximum) {
      this.log("scrcpy video source recovery exhausted", {
        sessionId: session.sessionId,
        serial: session.serial,
        attempts: attempts.length,
        windowMs,
        maximum
      });
      return false;
    }
    attempts.push(now);
    return true;
  }

  installControlQueue(session, client) {
    session.controlQueue?.close("screen_control_replaced");
    const generation = session.controlGeneration + 1;
    session.controlGeneration = generation;
    session.controlRecovering = false;
    session.controlQueue = createScreenControlQueue({
      execute: (control) => this.injectControl(session, control, client, generation),
      acknowledge: (control, result) => this.sendControlAcknowledgement(session, control, result),
      timeoutMs: (control) => control?.type === "text" ? 6_000 : 2_500,
      onTimeout: (control) => this.requestControlRecovery(session, control, generation)
    });
  }

  requestControlRecovery(session, control, generation) {
    if (session.closed || session.controlRecovering || session.controlGeneration !== generation) return;
    session.controlRecovering = true;
    session.controlQueue?.close("screen_control_recovering");
    this.log("screen control channel stalled", {
      sessionId: session.sessionId,
      serial: session.serial,
      generation,
      sequenceId: Math.max(0, Math.round(Number(control?.sequenceId || 0))),
      action: screenControlActionName(control)
    });
    this.sendStatus(session.sessionId, "live", "控制通道异常，正在恢复，画面保持连接");
    session.controlRecoveryPromise = this.restartControlClient(session)
      .catch((error) => {
        this.log("screen control recovery failed", {
          sessionId: session.sessionId,
          serial: session.serial,
          error: error?.message || String(error)
        });
        if (!session.closed) this.sendStatus(session.sessionId, "live", "控制通道恢复失败，请重新连接控制");
      })
      .finally(() => {
        if (!session.closed) session.controlRecovering = false;
      });
  }

  async forwardVideoPacket(session, packet) {
    if (["webrtc", "direct_webrtc"].includes(session.media.mode)) return this.forwardWebRtcVideoPacket(session, packet);
    const encoded = encodeScrcpyPacket(packet);
    const videoSocket = session.videoChannel?.socket || this.socket;
    const now = Date.now();
    const stats = session.streamStats || { startedAt: now, windowStartedAt: now, frames: 0, bytes: 0, droppedFrames: 0 };
    const decision = session.videoBackpressure.inspect(encoded, videoSocket?.bufferedAmount || 0);
    if (decision.forward) {
      if (session.videoChannel) session.videoChannel.send(encoded);
      else this.socket.send(encodeRelayVideoPacket(session.sessionId, encoded), { binary: true });
      if (packet.type === "data") stats.frames += 1;
      stats.bytes += encoded.byteLength;
    } else if (packet.type === "data") {
      stats.droppedFrames += 1;
    }
    const elapsedMs = now - stats.windowStartedAt;
    if (elapsedMs >= 5_000) {
      const metrics = buildScreenStreamMetrics({
        session,
        stats,
        elapsedMs,
        relayBufferedBytes: Math.max(0, Number(videoSocket?.bufferedAmount || 0))
      });
      this.log("screen stream stats", {
        sessionId: session.sessionId,
        serial: session.serial,
        ...metrics
      });
      this.sendJson({ type: "screen_stream_metrics", sessionId: session.sessionId, metrics });
      stats.windowStartedAt = now;
      stats.frames = 0;
      stats.bytes = 0;
      stats.droppedFrames = 0;
    }
    session.streamStats = stats;
  }

  async forwardWebRtcVideoPacket(session, packet) {
    const now = Date.now();
    const stats = session.streamStats || { startedAt: now, windowStartedAt: now, frames: 0, bytes: 0, droppedFrames: 0, capturedFrames: 0, firstCapturePtsMs: 0, lastCapturePtsMs: 0 };
    const configuration = packet?.type === "configuration";
    const videoData = packet?.type === "data";
    if (configuration) session.latestVideoConfiguration = packet;
    if (videoData) {
      stats.capturedFrames += 1;
      const ptsMs = scrcpyPtsToMilliseconds(packet.pts);
      if (Number.isFinite(ptsMs)) {
        if (!stats.firstCapturePtsMs) stats.firstCapturePtsMs = ptsMs;
        stats.lastCapturePtsMs = ptsMs;
      }
    }
    if (session.mediaPacketDiagnostics < 8) {
      session.mediaPacketDiagnostics += 1;
      const data = packet?.data || packet || new Uint8Array();
      this.log("screen H264 packet", {
        sessionId: session.sessionId,
        serial: session.serial,
        index: session.mediaPacketDiagnostics,
        type: packet?.type || "raw",
        keyframe: Boolean(packet?.keyframe),
        bytes: Number(data?.byteLength || 0),
        prefixHex: Buffer.from(data.buffer, data.byteOffset || 0, Math.min(8, data.byteLength || 0)).toString("hex")
      });
    }
    const publisherBufferedBytes = Math.max(0, Number(session.mediaPublisher?.bufferedBytes || 0));
    const requiresFreshKeyframe = session.mediaWaitingForKeyframe || publisherBufferedBytes > WEBRTC_SOURCE_HIGH_WATER_BYTES;
    if (videoData && requiresFreshKeyframe) {
      const canResume = Boolean(packet?.keyframe) && publisherBufferedBytes <= WEBRTC_SOURCE_LOW_WATER_BYTES;
      if (!canResume) {
        if (!session.mediaWaitingForKeyframe) {
          this.log("screen WebRTC source backpressure", {
            sessionId: session.sessionId,
            serial: session.serial,
            bufferedBytes: publisherBufferedBytes,
            policy: "drop_until_next_idr"
          });
        }
        session.mediaWaitingForKeyframe = true;
        stats.droppedFrames += 1;
        session.streamStats = stats;
        return false;
      }
      const configurationPacket = session.latestVideoConfiguration;
      if (configurationPacket && configurationPacket !== packet) await session.mediaPublisher.write(configurationPacket);
      session.mediaWaitingForKeyframe = false;
      this.log("screen WebRTC source backpressure recovered", {
        sessionId: session.sessionId,
        serial: session.serial,
        bufferedBytes: publisherBufferedBytes
      });
    }
    if (configuration && session.mediaWaitingForKeyframe) return false;
    if (videoData && packet?.keyframe) {
      session.lastSourceKeyframeAt = now;
      session.keyframeRecoveryPending = false;
      const viewerRecovery = session.viewerKeyframeRecovery;
      if (viewerRecovery?.pending) {
        viewerRecovery.pending = false;
        viewerRecovery.completed = true;
        this.log("screen viewer keyframe recovered", {
          sessionId: session.sessionId,
          serial: session.serial,
          attempts: viewerRecovery.attempts,
          elapsedMs: Math.max(0, now - Number(session.startedAtMs || now))
        });
      }
      session.mediaKeyframeDiagnostics = Number(session.mediaKeyframeDiagnostics || 0) + 1;
      if (session.mediaKeyframeDiagnostics <= 3) {
        this.log("screen H264 keyframe", {
          sessionId: session.sessionId,
          serial: session.serial,
          index: session.mediaKeyframeDiagnostics,
          elapsedMs: Math.max(0, now - Number(session.startedAtMs || now))
        });
      }
    }
    this.recordSourceFrameTiming(session, packet, now);
    await session.mediaPublisher.write(packet);
    if (videoData) stats.frames += 1;
    stats.bytes += Number(packet?.data?.byteLength || 0);
    const elapsedMs = now - stats.windowStartedAt;
    if (elapsedMs >= 5_000) {
      const metrics = buildScreenStreamMetrics({
        session,
        stats,
        elapsedMs,
        relayBufferedBytes: Math.max(0, Number(session.mediaPublisher.bufferedBytes || 0))
      });
      this.log("screen stream stats", { sessionId: session.sessionId, serial: session.serial, transport: "webrtc", ...metrics });
      this.sendJson({ type: "screen_stream_metrics", sessionId: session.sessionId, metrics });
      stats.windowStartedAt = now;
      stats.frames = 0;
      stats.bytes = 0;
      stats.droppedFrames = 0;
      stats.capturedFrames = 0;
      stats.firstCapturePtsMs = 0;
      stats.lastCapturePtsMs = 0;
    }
    session.streamStats = stats;
    return true;
  }

  recordSourceFrameTiming(session, packet, now = Date.now()) {
    if (packet?.type !== "data" || packet?.pts === undefined || packet?.pts === null) return;
    const probe = session.visualLatencyProbe;
    const ptsMs = scrcpyPtsToMilliseconds(packet.pts);
    if (!Number.isFinite(ptsMs)) return;
    if (!session.captureTimeline) {
      session.captureTimeline = {
        firstPtsMs: ptsMs,
        lastPtsMs: ptsMs,
        lastObservedAtMs: now
      };
    }
    const timeline = session.captureTimeline;
    timeline.lastPtsMs = ptsMs;
    timeline.lastObservedAtMs = now;
    if (!probe) return;
    session.visualLatencyProbe = null;
    const diagnostic = {
      sequenceId: probe.sequenceId,
      action: probe.action,
      event: "next_h264_packet_after_input",
      inputToAgentFrameMs: Math.max(0, now - probe.injectedAtMs),
      sourcePtsMs: Math.round(ptsMs),
      sourcePtsAdvanceMs: Number.isFinite(Number(probe.sourcePtsMsAtInput))
        ? Math.max(0, ptsMs - Number(probe.sourcePtsMsAtInput))
        : 0
    };
    this.log("screen control next H264 packet", {
      sessionId: session.sessionId,
      serial: session.serial,
      ...diagnostic
    });
    this.sendJson({ type: "screen_source_frame_diagnostic", sessionId: session.sessionId, diagnostic });
  }

  async handleMediaReaderReady(sessionId, generationInput) {
    const session = this.sessions.get(String(sessionId || ""));
    const generation = Math.round(Number(generationInput || 0));
    if (
      !session
      || session.closed
      || session.media?.mode !== "webrtc"
      || !session.viewerKeyframeResetEnabled
      || !Number.isSafeInteger(generation)
      || generation < 1
      || generation <= Number(session.viewerKeyframeRecovery?.generation || 0)
    ) return false;
    const recovery = session.viewerKeyframeRecovery || {
      attempts: 0,
      pending: false,
      completed: false,
      generation: 0
    };
    recovery.generation = generation;
    recovery.attempts = 1;
    recovery.pending = true;
    recovery.completed = false;
    session.viewerKeyframeRecovery = recovery;
    try {
      const wake = await this.wakeSessionForMediaReader(session, generation);
      if (session.closed || generation !== Number(session.viewerKeyframeRecovery?.generation || 0)) {
        recovery.pending = false;
        return false;
      }
      const controller = session.videoClient?.controller;
      if (!controller?.resetVideo) {
        recovery.pending = false;
        this.log("screen viewer keyframe reset unavailable", {
          sessionId: session.sessionId,
          serial: session.serial,
          generation
        });
        return false;
      }
      await controller.resetVideo();
      this.log("screen viewer keyframe reset requested", {
        sessionId: session.sessionId,
        serial: session.serial,
        generation,
        policy: "once_after_whep_ice_connected",
        wakeRequested: Boolean(wake?.wakeRequested),
        wakeMethod: String(wake?.wakeMethod || "none")
      });
      return true;
    } catch (error) {
      recovery.pending = false;
      this.log("screen viewer keyframe reset failed", {
        sessionId: session.sessionId,
        serial: session.serial,
        generation,
        error: error?.message || String(error)
      });
      return false;
    }
  }

  async handlePlaybackFeedback(sessionId, metrics = {}) {
    const session = this.sessions.get(String(sessionId || ""));
    if (
      !session
      || session.closed
      || session.media?.mode !== "webrtc"
      || !session.receiverFeedbackEnabled
      || typeof session.mediaPublisher?.updatePlaybackFeedback !== "function"
    ) return false;
    return session.mediaPublisher.updatePlaybackFeedback(metrics);
  }

  async wakeSessionForMediaReader(session, generation) {
    const wake = await ensureDeviceAwake({
      adbPath: this.config.adbPath,
      serial: session.serial,
      remoteWakeHelperPath: REMOTE_WAKE_HELPER_PATH
    });
    this.log("screen viewer wake check", {
      sessionId: session.sessionId,
      serial: session.serial,
      generation,
      ...wake
    });
    if (wake.powerState === "asleep" && wake.finalPowerState !== "awake") {
      throw new Error("手机仍处于深度息屏，自动唤醒失败");
    }
    try {
      const guard = await dismissVendorScreenGuard({
        adbPath: this.config.adbPath,
        serial: session.serial,
        controller: session.controlClient?.controller
      });
      if (guard.detected) {
        this.log("screen vendor guard dismissed", { sessionId: session.sessionId, serial: session.serial, generation });
        await delay(250);
      }
    } catch (error) {
      this.log("screen vendor guard check failed", {
        sessionId: session.sessionId,
        serial: session.serial,
        generation,
        error: error?.message || String(error)
      });
    }
    return wake;
  }

  async requestWebRtcKeyframe(session, reason = "pli") {
    if (session.closed || !["webrtc", "direct_webrtc"].includes(session.media?.mode)) return false;
    this.log("screen keyframe request observed", {
      sessionId: session.sessionId,
      serial: session.serial,
      reason,
      policy: "awaits_next_source_idr",
      iFrameIntervalSeconds: bounded(session.iFrameIntervalSeconds, 1, 10, 1)
    });
    // MediaMTX can emit periodic PLIs even for a healthy reader. Do not insert
    // an old cached IDR into a live GOP: that resets the browser decoder while
    // subsequent P-frames still reference the newer source chain.
    return false;
  }

  async requestWebRtcKeyframeRecovery(session, reason) {
    if (session.closed || !["webrtc", "direct_webrtc"].includes(session.media?.mode)) return false;
    const cooldownMs = bounded(session.keyframeRecoveryCooldownMs, 500, 10_000, 2_000);
    const now = Date.now();
    if (now - Number(session.lastSourceKeyframeRecoveryAtMs || 0) < cooldownMs) return false;
    session.lastSourceKeyframeRecoveryAtMs = now;
    // A publisher queue drop is expected under short H.264 bursts. Calling
    // resetVideo() here tears down and recreates the Android MediaCodec encoder,
    // which turns a recoverable transport resync into a source-stream failure on
    // some devices. The publisher is already discarding stale frames and waiting
    // for an IDR; keep the source encoder running and use its regular IDR cadence.
    this.log("screen keyframe recovery waiting for source idr", {
      sessionId: session.sessionId,
      serial: session.serial,
      reason,
      policy: "drop_until_next_source_idr",
      iFrameIntervalSeconds: bounded(session.iFrameIntervalSeconds, 1, 10, 1)
    });
    return false;
  }

  videoTransportReady(session) {
    if (["webrtc", "direct_webrtc"].includes(session.media.mode)) return this.socket?.readyState === WebSocket.OPEN && Boolean(session.mediaPublisher?.running);
    if (session.transportMode !== "split-v1") return this.socket?.readyState === WebSocket.OPEN;
    return !session.videoChannelFailed && session.videoChannel?.socket?.readyState === WebSocket.OPEN;
  }

  updateSessionVideoSize(session, video) {
    const width = Math.max(0, Math.round(Number(video?.width || 0)));
    const height = Math.max(0, Math.round(Number(video?.height || 0)));
    if (!width || !height || (session.videoWidth === width && session.videoHeight === height)) return;
    session.videoWidth = width;
    session.videoHeight = height;
    this.log("screen video size updated", { sessionId: session.sessionId, serial: session.serial, width, height });
  }

  async ensureServerJar(serial) {
    // The scrcpy server jar lives in /data/local/tmp and survives normal app
    // lifecycle changes. Re-checking it through ADB before every screen
    // connection serializes an avoidable shell round trip on the same phone.
    // A fresh Agent process still performs the real check below once.
    if (this.preparedSerials.has(serial)) return;
    const exists = await execFileAsync(this.config.adbPath, ["-s", serial, "shell", "test", "-s", REMOTE_SERVER_PATH], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024
    }).then(() => true).catch(() => false);
    if (exists) {
      this.preparedSerials.add(serial);
      return;
    }
    await execFileAsync(this.config.adbPath, ["-s", serial, "push", this.serverJar, REMOTE_SERVER_PATH], {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    this.preparedSerials.add(serial);
  }

  async ensureWakeHelper(serial) {
    if (!existsSync(this.wakeHelperJar)) throw new Error(`唤醒组件不存在: ${this.wakeHelperJar}`);
    // Same principle as the scrcpy jar: cache a successful device-side check
    // for this Agent lifetime, instead of adding a second serial ADB command
    // to every user-initiated connection.
    if (this.preparedWakeHelperSerials.has(serial)) return;
    const exists = await execFileAsync(this.config.adbPath, ["-s", serial, "shell", "test", "-s", REMOTE_WAKE_HELPER_PATH], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024
    }).then(() => true).catch((error) => {
      if (Number(error?.code) === 1) return false;
      throw screenAdbError(error, "wake_helper_check");
    });
    if (exists) {
      this.preparedWakeHelperSerials.add(serial);
      return;
    }
    await execFileAsync(this.config.adbPath, ["-s", serial, "push", this.wakeHelperJar, REMOTE_WAKE_HELPER_PATH], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 256 * 1024
    }).catch((error) => {
      throw screenAdbError(error, "wake_helper_push");
    });
    this.preparedWakeHelperSerials.add(serial);
  }

  async handleControl(sessionId, message) {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session || !message) return;
    if (!session.controlQueue || session.controlRecovering) {
      this.sendControlAcknowledgement(session, message, {
        status: "failed",
        action: screenControlActionName(message),
        agentElapsedMs: 0
      });
      return;
    }
    session.controlQueue.enqueue(message);
  }

  async injectControl(session, message, client = session?.controlClient, generation = session?.controlGeneration) {
    const controller = client?.controller;
    if (
      !controller
      || session.closed
      || session.controlRecovering
      || session.controlClient !== client
      || session.controlGeneration !== generation
      || !message
    ) {
      throw new Error("screen_controller_unavailable");
    }
    if (message.type === "touch") {
      const actions = {
        down: AndroidMotionEventAction.Down,
        move: AndroidMotionEventAction.Move,
        up: AndroidMotionEventAction.Up,
        cancel: AndroidMotionEventAction.Cancel
      };
      const action = actions[message.action];
      if (action === undefined) return;
      const position = mapScreenControlCoordinates(message, {
        width: session.videoWidth,
        height: session.videoHeight
      });
      await controller.injectTouch({
        action,
        pointerId: BigInt(message.pointerId ?? 0),
        pointerX: position.x,
        pointerY: position.y,
        videoWidth: position.videoWidth,
        videoHeight: position.videoHeight,
        pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
        actionButton: 0,
        buttons: action === AndroidMotionEventAction.Up ? 0 : 1
      });
      if (message.action !== "move") {
        this.log("screen control injected", {
          sessionId: session.sessionId,
          serial: session.serial,
          type: "touch",
          action: message.action,
          x: position.x,
          y: position.y,
          videoWidth: position.videoWidth,
          videoHeight: position.videoHeight,
          browserVideoWidth: Math.round(message.videoWidth),
          browserVideoHeight: Math.round(message.videoHeight)
        });
      }
      this.markVisualLatencyProbe(session, message);
      return;
    }
    if (message.type === "text") {
      await injectScreenText(controller, message.text);
      this.log("screen control injected", { sessionId: session.sessionId, serial: session.serial, type: "text" });
      this.markVisualLatencyProbe(session, message);
      return;
    }
    if (message.type === "key") {
      let wakeHandledByAdb = false;
      if (message.key === "wakeup") {
        try {
          await this.ensureWakeHelper(session.serial);
          const wake = await ensureDeviceAwake({
            adbPath: this.config.adbPath,
            serial: session.serial,
            remoteWakeHelperPath: REMOTE_WAKE_HELPER_PATH
          });
          this.log("screen manual wake check", { sessionId: session.sessionId, serial: session.serial, ...wake });
          wakeHandledByAdb = wake.finalPowerState === "awake";
          if (wake.powerState === "asleep" && wake.finalPowerState !== "awake") {
            this.sendStatus(session.sessionId, "live", "手机仍处于深度息屏，自动唤醒失败");
          }
        } catch (error) {
          this.log("screen manual wake check failed", { sessionId: session.sessionId, serial: session.serial, error: error?.message || String(error) });
        }
      }
      if (wakeHandledByAdb) {
        this.log("screen control wakeup skipped", {
          sessionId: session.sessionId,
          serial: session.serial,
          reason: "already_awake_by_adb"
        });
        this.markVisualLatencyProbe(session, message);
        return;
      }
      await injectScreenKey(controller, message.key);
      this.log("screen control injected", { sessionId: session.sessionId, serial: session.serial, type: "key", key: message.key });
      this.markVisualLatencyProbe(session, message);
    }
  }

  markVisualLatencyProbe(session, message) {
    if (!session || !message) return;
    if (message.type === "touch" && message.action !== "up") return;
    if (message.type === "touch" && message.action === "move") return;
    session.visualLatencyProbe = {
      sequenceId: Math.max(0, Math.round(Number(message.sequenceId || 0))),
      action: screenControlActionName(message),
      injectedAtMs: Date.now(),
      sourcePtsMsAtInput: Number(session.captureTimeline?.lastPtsMs)
    };
  }

  sendControlAcknowledgement(session, control, result) {
    this.sendJson({
      type: "screen_control_ack",
      sessionId: session.sessionId,
      sequenceId: Math.max(0, Math.round(Number(control?.sequenceId || 0))),
      status: result.status,
      action: result.action,
      agentElapsedMs: result.agentElapsedMs
    });
  }

  sendStatus(sessionId, status, detail, metadata = {}) {
    this.sendJson({ type: "screen_status", sessionId, status, detail, metadata });
  }

  sendJson(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  async closeSession(sessionId, reason = "closed", notify = true) {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session) return;
    if (!session.closingPromise) {
      session.closingPromise = (async () => {
        session.closed = true;
        session.controlQueue?.close("screen_session_closed");
        await this.runCleanupStep(session, "reader_cancel", () => session.reader?.cancel());
        await this.runCleanupStep(session, "webrtc_publisher_stop", () => session.mediaPublisher?.stop());
        await this.runCleanupStep(session, "video_client_close", () => session.videoClient?.close());
        if (session.controlClient && session.controlClient !== session.videoClient) {
          await this.runCleanupStep(session, "control_client_close", () => session.controlClient?.close());
        }
        await this.releaseAdbOwner(session, "controlAdbOwner", session.controlAdbOwner, "control_adb_close");
        await this.releaseAdbOwner(session, "videoAdbOwner", session.videoAdbOwner, "video_adb_close");
        for (const owner of [...(session.adbOwners || [])]) {
          await this.releaseAdbOwner(session, null, owner, "registered_adb_close");
        }
        session.videoChannel?.close(1000, reason);
        // scrcpy starts a short-lived Android cleanup process. Keep this serial
        // reserved until it has had time to exit, otherwise an immediate reconnect
        // can be aborted by the previous cleanup process.
        await delay(this.cleanupGraceMs);
        this.sessions.delete(session.sessionId);
        this.releaseSerial(session.serial);
        this.log("screen session released", { sessionId: session.sessionId, serial: session.serial, reason });
        if (notify) this.sendStatus(session.sessionId, "closed", reason);
        try {
          await this.afterSessionEnd(session.serial, reason);
        } catch (error) {
          this.log("screen session cleanup failed", {
            sessionId: session.sessionId,
            serial: session.serial,
            error: error?.message || String(error)
          });
        }
      })();
    }
    await session.closingPromise;
  }

  webrtcPublisherReady() {
    if (!this.config.screenWebRtcEnabled) return false;
    if (["whip", "direct_webrtc"].includes(this.config.screenPublisherMode)) return existsSync(this.config.screenWhipPublisherPath);
    return existsSync(this.config.ffmpegPath);
  }

  directWebRtcPublisherReady() {
    return Boolean(this.config.screenWebRtcEnabled && existsSync(this.config.screenWhipPublisherPath));
  }

  async runCleanupStep(session, step, operation) {
    try {
      await withTimeout(operation, this.cleanupTimeoutMs, `screen_cleanup_timeout:${step}`);
    } catch (error) {
      this.log("screen cleanup step skipped", {
        sessionId: session.sessionId,
        serial: session.serial,
        step,
        error: error?.message || String(error)
      });
    }
  }

  async releaseAdbOwner(session, slot, owner, step) {
    if (!owner) return;
    await this.runCleanupStep(session, step, () => owner.close());
    if (owner.closed) {
      if (slot && session?.[slot] === owner) session[slot] = null;
      if (session?.videoAdbOwner === owner) session.videoAdbOwner = null;
      if (session?.controlAdbOwner === owner) session.controlAdbOwner = null;
      session?.adbOwners?.delete(owner);
      this.adbOwners.delete(owner);
      this.log("screen adb owner released", {
        sessionId: session?.sessionId || "",
        serial: session?.serial || "",
        channel: slot === "controlAdbOwner" ? "control" : (slot === "videoAdbOwner" ? "video" : "registered"),
        step
      });
    }
  }

  async waitForClosingSession(serial) {
    const deadline = Date.now() + 5_000;
    while ([...this.sessions.values()].some((item) => item.serial === serial && item.closed)) {
      if (Date.now() >= deadline) break;
      await delay(100);
    }
  }

  async closeAll(reason) {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId, reason, false)));
  }

  rememberCancelledStart(sessionId) {
    const id = String(sessionId || "");
    if (!id) return;
    const now = Date.now();
    this.cancelledStartSessions.set(id, now);
    for (const [candidate, at] of this.cancelledStartSessions) {
      if (now - at > 5 * 60_000) this.cancelledStartSessions.delete(candidate);
    }
  }

  isStartCancelled(sessionId) {
    const id = String(sessionId || "");
    const at = this.cancelledStartSessions.get(id);
    if (!at) return false;
    if (Date.now() - at <= 5 * 60_000) return true;
    this.cancelledStartSessions.delete(id);
    return false;
  }

  async close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepAliveTimer);
    await this.closeAll("agent_shutdown");
    this.socket?.close(1000, "agent_shutdown");
  }
}

export async function injectScreenKey(controller, key) {
  if (key === "select_all") return injectScreenSelectAll(controller);
  if (key === "clear") return injectScreenClear(controller);
  const keyCode = screenKeyCode(key);
  if (!controller || !keyCode) return false;
  if (key === "wakeup") await controller.setScreenPowerMode(AndroidScreenPowerMode.Normal);
  await controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: 0 });
  await controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: 0 });
  return true;
}

export async function injectScreenClear(controller) {
  if (!controller) return false;
  // Android text fields use the standard Ctrl+A selection shortcut. Send it
  // through scrcpy, then delete the selected range, so this affects the
  // focused phone input rather than the browser's helper input.
  await injectScreenSelectAll(controller);
  await injectScreenKey(controller, "delete");
  return true;
}

export async function injectScreenSelectAll(controller) {
  if (!controller) return false;
  await controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode: ANDROID_KEYCODE_A, repeat: 0, metaState: ANDROID_META_CTRL_ON });
  await controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode: ANDROID_KEYCODE_A, repeat: 0, metaState: ANDROID_META_CTRL_ON });
  return true;
}

export async function injectScreenText(controller, text) {
  const content = String(text || "");
  if (!controller || !content.length) return false;
  // Native InjectText is not accepted by a subset of vendor WebViews and
  // secure-looking Android text fields: they show a cursor but consume the
  // characters as empty input. scrcpy's SetClipboard `paste` control writes
  // Unicode text to the device clipboard and asks Android to paste it into
  // the current focus, which also works for CJK input and these fields.
  if (typeof controller.setClipboard === "function") {
    try {
      await controller.setClipboard({ sequence: 0n, paste: true, content });
      return true;
    } catch {
      // Keep standard text fields working on older scrcpy servers that do not
      // implement the clipboard paste control.
    }
  }
  await controller.injectText(content);
  return true;
}

export function buildScreenStreamMetrics({ session = {}, stats = {}, elapsedMs = 0, relayBufferedBytes = 0 } = {}) {
  const duration = Math.max(1, Number(elapsedMs || 0));
  const captureSpanMs = Math.max(0, Number(stats.lastCapturePtsMs || 0) - Number(stats.firstCapturePtsMs || 0));
  const capturedFrames = Math.max(0, Number(stats.capturedFrames || 0));
  return {
    fps: Number((Math.max(0, Number(stats.frames || 0)) * 1000 / duration).toFixed(1)),
    // This is counted before the native publisher write. It separates Android
    // capture cadence from publisher backpressure in real incident analysis.
    capturedFps: Number((capturedFrames * 1000 / Math.max(duration, captureSpanMs || duration)).toFixed(1)),
    megabitsPerSecond: Number((Math.max(0, Number(stats.bytes || 0)) * 8 / duration / 1_000).toFixed(3)),
    droppedFrames: Math.max(0, Math.round(Number(stats.droppedFrames || 0))),
    relayBufferedBytes: Math.max(0, Math.round(Number(relayBufferedBytes || 0))),
    width: Math.max(0, Math.round(Number(session.videoWidth || 0))),
    height: Math.max(0, Math.round(Number(session.videoHeight || 0)))
  };
}

function encodeScrcpyPacket(packet) {
  const header = Buffer.allocUnsafe(10);
  header[0] = packet.type === "configuration" ? 0 : 1;
  header[1] = packet.type === "data" && packet.keyframe ? 1 : 0;
  header.writeBigInt64BE(packet.type === "data" && packet.pts !== undefined ? packet.pts : -1n, 2);
  return Buffer.concat([header, Buffer.from(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength)]);
}

function monitorScrcpyOutput(output, onLine = () => {}) {
  let resolveFallback;
  const fallbackPromise = new Promise((resolve) => { resolveFallback = resolve; });
  const donePromise = (async () => {
    const reader = output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const line = String(value || "");
        const fallbackMaxSize = parseScrcpyFallbackMaxSize(line);
        if (fallbackMaxSize || isScrcpyDiagnosticLine(line)) {
          onLine(line);
        }
        if (fallbackMaxSize) {
          resolveFallback(fallbackMaxSize);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })().catch((error) => onLine(`output_error:${error?.message || String(error)}`));
  return { fallbackPromise, donePromise };
}

function screenControlActionName(message) {
  if (message?.type === "key") return `key:${message.key || "unknown"}`;
  if (message?.type === "text") return "text";
  return String(message?.action || "unknown");
}

function scrcpyPtsToMilliseconds(value) {
  try {
    const numeric = typeof value === "bigint" ? Number(value) : Number(value);
    return Number.isFinite(numeric) ? numeric / 1_000 : NaN;
  } catch {
    return NaN;
  }
}

function normalizeScreenVideoEncoder(value) {
  const encoder = String(value || "").trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(encoder) ? encoder : "";
}

function boundedByConfiguredCeiling(value, min, max, configuredValue, configuredFallback) {
  const ceiling = bounded(configuredValue, min, max, configuredFallback);
  return Math.min(ceiling, bounded(value, min, max, ceiling));
}

function bounded(value, min, max, fallback) {
  const number = Number(value || fallback);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientAdbDeviceUnavailable(error) {
  return /device ['"][^'"]+['"] not found|device .* not found|device offline/i.test(
    String(error?.message || error || "")
  );
}

async function withTimeout(operation, timeoutMs, errorMessage) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function friendlyScreenError(error) {
  const message = String(error?.message || error || "投屏启动失败");
  const serverOutput = Array.isArray(error?.output) ? error.output.filter(Boolean).join(" · ") : "";
  if (serverOutput) return serverOutput.slice(0, 500);
  if (error?.code === "screen_adb_timeout") return "手机 ADB 通道响应超时，后台操作尚未释放，请稍后重新连接";
  if (error?.code === "wake_helper_push_failed") return "唤醒组件传输失败，请检查手机 USB 调试连接";
  if (/device.*offline|device not found|closed/i.test(message)) return "手机 ADB 已断开";
  if (/unauthorized/i.test(message)) return "手机尚未授权 ADB";
  return message.slice(0, 500);
}

function screenAdbError(error, stage) {
  const timedOut = Boolean(error?.killed || error?.signal || /timed?\s*out|timeout/i.test(String(error?.message || "")));
  const wrapped = new Error(String(error?.message || error || "ADB command failed"));
  wrapped.code = timedOut ? "screen_adb_timeout" : stage === "wake_helper_push" ? "wake_helper_push_failed" : "screen_adb_failed";
  wrapped.stage = stage;
  wrapped.cause = error;
  return wrapped;
}
