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
  return { back: 4, home: 3, overview: 187, wakeup: 224, volume_up: 24, enter: 66, delete: 67 }[key] || 0;
}

export function createScreenVideoCodecOptions(config = {}) {
  // Do not force an H.264 profile: some MediaTek encoders reject it. We do
  // require frequent IDR frames, however. Without them a WHEP viewer that
  // joins after startup receives P-frames only and remains on "preparing"
  // until the screen changes enough for Android to emit another keyframe.
  return {
    videoCodecOptions: new ScrcpyCodecOptions({
      iFrameInterval: Math.max(1, Math.min(10, Number(config.screenIFrameIntervalSeconds || 1)))
    })
  };
}

export function createScreenScrcpyOptions({ requestedOptions = {}, maxSize, config, video = true, control = true }) {
  return new AdbScrcpyOptions3_3_3({
    video,
    audio: false,
    control,
    tunnelForward: false,
    videoCodec: "h264",
    ...createScreenVideoCodecOptions(config),
    maxSize,
    maxFps: bounded(requestedOptions.maxFps, 5, 60, config.screenMaxFps),
    videoBitRate: bounded(requestedOptions.videoBitRate, 500_000, 12_000_000, config.screenVideoBitRate),
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

export async function ensureDeviceAwake({ adbPath, serial, remoteWakeHelperPath = "", run = execFileAsync }) {
  const commandOptions = { timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024 };
  const { stdout = "" } = await run(adbPath, ["-s", serial, "shell", "dumpsys", "power"], commandOptions);
  const powerState = devicePowerState(stdout);
  const wakeRequested = powerState === "asleep";
  if (wakeRequested) {
    if (remoteWakeHelperPath) {
      await run(adbPath, ["-s", serial, "shell", `CLASSPATH=${remoteWakeHelperPath} app_process / com.phonecloud.wake.Main`], commandOptions);
    } else {
      await run(adbPath, ["-s", serial, "shell", "input", "keyevent", "26"], commandOptions);
    }
  }
  await run(adbPath, ["-s", serial, "shell", "wm", "dismiss-keyguard"], commandOptions);
  if (!wakeRequested) return { powerState, finalPowerState: powerState, wakeRequested: false };
  let { stdout: finalOutput = "" } = await run(adbPath, ["-s", serial, "shell", "dumpsys", "power"], commandOptions);
  let finalPowerState = devicePowerState(finalOutput);
  if (finalPowerState === "asleep" && remoteWakeHelperPath) {
    await run(adbPath, ["-s", serial, "shell", "input", "keyevent", "224"], commandOptions);
    await run(adbPath, ["-s", serial, "shell", "wm", "dismiss-keyguard"], commandOptions);
    ({ stdout: finalOutput = "" } = await run(adbPath, ["-s", serial, "shell", "dumpsys", "power"], commandOptions));
    finalPowerState = devicePowerState(finalOutput);
  }
  return { powerState, finalPowerState, wakeRequested: true };
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
    return {
      enabled: Boolean(this.config.screenStreamEnabled),
      connected: this.socket?.readyState === WebSocket.OPEN,
      activeSessions: this.sessions.size,
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
        mediaTransports: this.webrtcPublisherReady()
          ? [this.config.screenPublisherMode === "direct_webrtc" ? "webrtc-direct-v1" : "webrtc-rtsp-v1"]
          : [],
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
      controlClient: null,
      reader: null,
      controlQueue: null,
      controlGeneration: 0,
      controlRecovering: false,
      controlRecoveryPromise: null,
      requestedOptions: message.options || {},
      transportMode: message.transportMode === "split-v1" ? "split-v1" : "multiplexed",
      media: ["webrtc", "direct_webrtc"].includes(message.media?.mode) ? message.media : { mode: "websocket" },
      videoChannel: null,
      videoChannelFailed: false,
      mediaPublisher: null,
      mediaPacketDiagnostics: 0,
      captureTimeline: null,
      visualLatencyProbe: null,
      videoWidth: 0,
      videoHeight: 0,
      closed: false
    };
    session.videoBackpressure = createVideoBackpressureGate();
    this.sessions.set(sessionId, session);
    this.runSession(session, message.options || {})
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
      const wake = await phase("wake_check", () => ensureDeviceAwake({
        adbPath: this.config.adbPath,
        serial: session.serial,
        remoteWakeHelperPath: REMOTE_WAKE_HELPER_PATH
      }));
      this.log("screen wake check", { sessionId: session.sessionId, serial: session.serial, ...wake });
      if (wake.powerState === "asleep" && wake.finalPowerState !== "awake") {
        throw new Error("手机仍处于深度息屏，自动唤醒失败");
      }
    } catch (error) {
      this.log("screen wake check failed", { sessionId: session.sessionId, serial: session.serial, error: error?.message || String(error) });
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
    const requestedMaxSize = bounded(requestedOptions.maxSize, 480, 2160, this.config.screenMaxSize);
    let maxSize = Math.min(requestedMaxSize, this.compatibleMaxSizes.get(session.serial) || requestedMaxSize);
    session.maxSize = maxSize;
    let encoderRestarts = 0;

    while (!session.closed) {
      const connector = new AdbServerNodeTcpConnector({ host: this.config.adbServerHost, port: this.config.adbServerPort });
      const adbServer = new AdbServerClient(connector);
      const adb = await adbServer.createAdb({ serial: session.serial });
      // scrcpy maps touch positions from the encoded video size to the physical
      // display inside one server session. Starting a separate control-only
      // server loses that mapping whenever maxSize downscales the video.
      const options = createScreenScrcpyOptions({ requestedOptions, maxSize, config: this.config, video: true, control: true });
      const videoClient = await phase("scrcpy_video_start", () => AdbScrcpyClient.start(adb, REMOTE_SERVER_PATH, options));
      session.videoClient = videoClient;
      if (!session.controlClient && !session.controlRecovering) {
        await phase("scrcpy_control_bind", () => this.startControlClient(session));
      }
      const outputMonitor = monitorScrcpyOutput(videoClient.output, (line) => {
        this.log("scrcpy server output", { sessionId: session.sessionId, serial: session.serial, line });
      });
      try {
        await injectScreenKey(session.controlClient?.controller, "wakeup");
        this.log("screen auto wakeup", { sessionId: session.sessionId, serial: session.serial });
      } catch (error) {
        this.log("screen auto wakeup failed", { sessionId: session.sessionId, serial: session.serial, error: error?.message || String(error) });
      }
      try {
        const guard = await dismissVendorScreenGuard({
          adbPath: this.config.adbPath,
          serial: session.serial,
          controller: session.controlClient?.controller
        });
        if (guard.detected) {
          this.log("screen vendor guard dismissed", { sessionId: session.sessionId, serial: session.serial });
          await delay(250);
        }
      } catch (error) {
        this.log("screen vendor guard check failed", { sessionId: session.sessionId, serial: session.serial, error: error?.message || String(error) });
      }
      const video = await videoClient.videoStream;
      const reader = video.stream.getReader();
      session.reader = reader;
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
      if (firstPacket.done) throw new Error("scrcpy_video_stream_ended_before_first_frame");
      this.updateSessionVideoSize(session, video);
      const metadata = {
        codec: video.metadata.codec || "h264",
        deviceName: video.metadata.deviceName || session.serial,
        serial: session.serial,
        maxSize,
        width: session.videoWidth,
        height: session.videoHeight
      };
      if (["webrtc", "direct_webrtc"].includes(session.media.mode)) {
        session.mediaPublisher = createScreenWebRtcPublisher({
          ffmpegPath: this.config.ffmpegPath,
          whipPublisherPath: this.config.screenWhipPublisherPath,
          mode: session.media.mode === "direct_webrtc" ? "direct_webrtc" : this.config.screenPublisherMode,
          publishUrl: session.media.mode === "direct_webrtc" ? session.media.signalUrl : session.media.publishUrl,
          agentToken: this.config.agentToken,
          iceServers: session.media.iceServers || [],
          h264ProfileLevelId: h264ProfileLevelId(firstPacket.value),
          frameRate: bounded(requestedOptions.maxFps, 5, 60, this.config.screenMaxFps),
          pacingBitRate: Math.max(
            Number(requestedOptions.videoBitRate || 0),
            Number(this.config.screenTransportPacingBitRate || 0)
          ),
          statsIntervalMs: Math.round(Number(this.config.screenPublisherStatsIntervalSeconds || 0) * 1000),
          onLog: (entry) => this.log("screen WebRTC publisher", { sessionId: session.sessionId, serial: session.serial, ...entry }),
          onKeyframeRequest: (reason) => {
            void this.requestWebRtcKeyframe(session, reason);
          }
        });
        await phase(session.media.mode === "direct_webrtc" ? "direct_webrtc_start" : "ffmpeg_rtsp_start", () => session.mediaPublisher.start());
        metadata.decoderBackend = "webrtc";
      }
      this.sendStatus(session.sessionId, "live", "实时画面已连接", metadata);
      await this.forwardVideoPacket(session, firstPacket.value);
      let streamError = null;
      try {
        while (!session.closed && this.socket?.readyState === WebSocket.OPEN && this.videoTransportReady(session)) {
          const { done, value } = await reader.read();
          if (done) break;
          this.updateSessionVideoSize(session, video);
          await this.forwardVideoPacket(session, value);
        }
      } catch (error) {
        streamError = error;
      }
      if (session.videoChannelFailed) throw new Error("screen_video_channel_disconnected");
      if (streamError) throw streamError;
      return;
    }
  }

  async startControlClient(session) {
    if (session.closed) return null;
    const controlClient = session.videoClient;
    if (!controlClient?.controller) throw new Error("scrcpy_control_unavailable");
    session.controlClient = controlClient;
    this.installControlQueue(session, controlClient);
    this.log("screen control channel ready", {
      sessionId: session.sessionId,
      serial: session.serial,
      generation: session.controlGeneration,
      transport: "shared_scrcpy_session"
    });
    return controlClient;
  }

  async restartControlClient(session) {
    if (session.closed) return;
    // A control-only restart would create a second scrcpy server and reintroduce
    // coordinate drift. Rebind the queue to the active video/control session.
    session.controlClient = null;
    session.controlQueue = null;
    await delay(100);
    await this.startControlClient(session);
    if (!session.closed) this.sendStatus(session.sessionId, "live", "控制通道已重新绑定");
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
    const stats = session.streamStats || { startedAt: now, windowStartedAt: now, frames: 0, bytes: 0, droppedFrames: 0 };
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
    if (packet?.type === "data" && packet?.keyframe) {
      session.lastSourceKeyframeAt = now;
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
    if (packet.type === "data") stats.frames += 1;
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
    }
    session.streamStats = stats;
  }

  recordSourceFrameTiming(session, packet, now = Date.now()) {
    if (packet?.type !== "data" || packet?.pts === undefined || packet?.pts === null) return;
    const probe = session.visualLatencyProbe;
    const ptsMs = scrcpyPtsToMilliseconds(packet.pts);
    if (!Number.isFinite(ptsMs)) return;
    if (!session.captureTimeline) {
      session.captureTimeline = {
        firstPtsMs: ptsMs,
        firstObservedAtMs: now,
        lastCaptureAtMs: now
      };
    }
    const timeline = session.captureTimeline;
    const capturedAtMs = timeline.firstObservedAtMs + (ptsMs - timeline.firstPtsMs);
    timeline.lastCaptureAtMs = capturedAtMs;
    if (probe && !probe.firstPacketLogged) {
      probe.firstPacketLogged = true;
      const diagnostic = {
        sequenceId: probe.sequenceId,
        action: probe.action,
        event: "next_h264_packet_after_input",
        inputToAgentFrameMs: Math.max(0, now - probe.injectedAtMs),
        sourcePtsMs: Math.round(ptsMs)
      };
      this.log("screen control next H264 packet", { sessionId: session.sessionId, serial: session.serial, ...diagnostic });
      this.sendJson({ type: "screen_source_frame_diagnostic", sessionId: session.sessionId, diagnostic });
    }
    if (!probe || capturedAtMs + 8 < probe.injectedAtMs) return;
    session.visualLatencyProbe = null;
    const diagnostic = {
      sequenceId: probe.sequenceId,
      action: probe.action,
      inputToCapturedFrameMs: Math.max(0, capturedAtMs - probe.injectedAtMs),
      capturedFrameToAgentMs: Math.max(0, now - capturedAtMs),
      inputToAgentFrameMs: Math.max(0, now - probe.injectedAtMs),
      sourcePtsMs: Math.round(ptsMs)
    };
    this.log("screen control source frame", {
      sessionId: session.sessionId,
      serial: session.serial,
      ...diagnostic
    });
    this.sendJson({ type: "screen_source_frame_diagnostic", sessionId: session.sessionId, diagnostic });
  }

  async requestWebRtcKeyframe(session, reason = "pli") {
    if (session.closed || session.media?.mode !== "webrtc") return false;
    // The scrcpy session is configured with a one-second IDR interval. Calling
    // resetVideo() for every browser PLI was creating a 400KB+ IDR burst every
    // few seconds, which caused fresh packet loss and an endless freeze loop.
    // Consume the PLI in the publisher, let the scheduled source IDR repair
    // the decoder, and keep the active encoder uninterrupted.
    this.log("screen keyframe request observed", {
      sessionId: session.sessionId,
      serial: session.serial,
      reason,
      detail: "scheduled_source_idr"
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
      if (message.key === "wakeup") {
        try {
          await this.ensureWakeHelper(session.serial);
          const wake = await ensureDeviceAwake({
            adbPath: this.config.adbPath,
            serial: session.serial,
            remoteWakeHelperPath: REMOTE_WAKE_HELPER_PATH
          });
          this.log("screen manual wake check", { sessionId: session.sessionId, serial: session.serial, ...wake });
          if (wake.powerState === "asleep" && wake.finalPowerState !== "awake") {
            this.sendStatus(session.sessionId, "live", "手机仍处于深度息屏，自动唤醒失败");
          }
        } catch (error) {
          this.log("screen manual wake check failed", { sessionId: session.sessionId, serial: session.serial, error: error?.message || String(error) });
        }
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
      injectedAtMs: Date.now()
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
  const keyCode = screenKeyCode(key);
  if (!controller || !keyCode) return false;
  if (key === "wakeup") await controller.setScreenPowerMode(AndroidScreenPowerMode.Normal);
  await controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: 0 });
  await controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: 0 });
  return true;
}

export async function injectScreenText(controller, text) {
  if (!controller || !String(text || "").length) return false;
  await controller.injectText(String(text));
  return true;
}

export function buildScreenStreamMetrics({ session = {}, stats = {}, elapsedMs = 0, relayBufferedBytes = 0 } = {}) {
  const duration = Math.max(1, Number(elapsedMs || 0));
  return {
    fps: Number((Math.max(0, Number(stats.frames || 0)) * 1000 / duration).toFixed(1)),
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

function bounded(value, min, max, fallback) {
  const number = Number(value || fallback);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
