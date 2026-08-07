import { MediaSourceScreenPlayer } from "./mse-player.js";
import { WhepScreenPlayer } from "./webrtc-player.js";
import { DirectWebRtcScreenPlayer } from "./direct-webrtc-player.js";
import { createControlInput } from "./control-input.js";
import { createScreenTransport } from "./screen-transport.js";

export function normalizeScreenPlayerMedia(media = {}, browserToken = "") {
  if (!["webrtc", "direct_webrtc"].includes(media?.mode)) return { mode: "websocket" };
  return {
    ...media,
    ...(media.mode === "direct_webrtc" ? { token: String(browserToken || "") } : {})
  };
}

class PhoneCloudScreenController {
  constructor({ video, onStatus, onMetrics, relayBaseUrl = location.origin }) {
    if (!video) throw new Error("缺少实时投屏 video 元素");
    this.video = video;
    this.onStatus = onStatus || (() => {});
    this.onMetrics = onMetrics || (() => {});
    this.relayBaseUrl = relayBaseUrl;
    this.transportClosed = true;
    this.player = null;
    this.failureMessage = "";
    this.media = { mode: "websocket" };
    this.channelMetadata = {};
    this.lastStats = {};
    this.controlSentAt = new Map();
    this.pendingVisualProbe = null;
    this.mediaReaderGeneration = 0;
    this.transportErrorChannel = "";
    this.playbackMetrics = createPlaybackMetricsReporter({ send: (message) => this.send(message) });
    this.controlInput = createControlInput({
      video,
      keyboardTarget: video.parentElement?.querySelector("#userScreenKeyboardBridge") || video,
      send: (message) => this.sendControl(message),
      keyboardEnabled: () => !this.transportClosed
    });
    this.transport = createScreenTransport({
      onControl: (data) => this.consumeTransportData(data),
      onVideo: (data) => this.consumeTransportData(data),
      onError: (channel) => this.handleTransportError(channel),
      onClose: (channel, event) => this.handleTransportClose(channel, event)
    });
  }

  connect({ sessionId, browserToken, media = { mode: "websocket" } }) {
    this.disconnect(false);
    this.transportClosed = false;
    this.transportErrorChannel = "";
    this.media = normalizeScreenPlayerMedia(media, browserToken);
    this.emit("connecting", "正在连接手机画面");
    this.transport.connect({ baseUrl: this.relayBaseUrl, sessionId, browserToken, videoEnabled: !["webrtc", "direct_webrtc"].includes(this.media.mode) });
    // For WHEP, a successful WHIP negotiation alone does not guarantee that
    // MediaMTX has accepted a decodable H.264 access unit. Start only after
    // the Agent confirms that an IDR reached the media service; otherwise the
    // browser creates a storm of expected 404 reader sessions during startup.
    if (this.media.mode === "direct_webrtc") this.setupPlayer("h264");
  }

  consumeTransportData(data) {
    try {
      this.handleMessage({ data });
    } catch (error) {
      this.failPlayer(error);
    }
  }

  handleMessage(event) {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      if (message.type === "screen_control_ack") {
        this.handleControlAcknowledgement(message);
        return;
      }
      if (message.type === "metadata") {
        this.channelMetadata = { ...this.channelMetadata, ...message };
        this.updateControlSourceSize(message);
        if (!["webrtc", "direct_webrtc"].includes(this.media.mode)) this.setupPlayer(message.codec);
      }
      if (message.type === "status") {
        if (message.metadata) {
          this.channelMetadata = { ...this.channelMetadata, ...message.metadata };
          this.updateControlSourceSize(message.metadata);
        }
        if (message.status === "recovering") {
          this.cleanupPlayer();
          this.emit("preparing", message.detail || "控制通道异常，正在自动恢复");
          return;
        }
        if (!["webrtc", "direct_webrtc"].includes(this.media.mode) && message.metadata?.codec && !this.player) this.setupPlayer(message.metadata.codec);
        if (message.status === "failed") {
          this.failureMessage = message.detail || "投屏启动失败";
          this.emit("failed", this.failureMessage, message.metadata || {});
          return;
        }
        if (message.status === "live" || message.status === "streaming") {
          if (this.media.mode === "webrtc" && !this.player) this.setupPlayer("h264");
          // The control status can arrive after WebRTC has already rendered a
          // frame. Never downgrade a visible live screen back to its loader.
          const playback = liveScreenPlaybackStatus(this.player?.hasFirstFrame);
          this.emit(playback.status, playback.detail, {
            ...message.metadata,
            decoderBackend: ["webrtc", "direct_webrtc"].includes(this.media.mode) ? this.media.mode : "mse",
            ...this.lastStats
          });
          return;
        }
        this.emit(message.status, message.detail || message.status, message.metadata || {});
      }
      return;
    }
    if (["webrtc", "direct_webrtc"].includes(this.media.mode)) return;
    if (!this.player) this.setupPlayer("h264");
    const packet = decodeVideoPacket(event.data);
    this.player.write(packet.data);
  }

  setupPlayer(codec) {
    if (this.player) return;
    if (this.media.mode === "webrtc") {
      this.player = new WhepScreenPlayer({
        video: this.video,
        onFirstFrame: (metadata) => this.emit("live", "实时画面已连接", { ...this.channelMetadata, ...metadata, ...this.lastStats }),
        onReaderReady: () => {
          this.mediaReaderGeneration += 1;
          this.send({ type: "screen_media_reader_ready", generation: this.mediaReaderGeneration });
        },
        onVideoFrame: (frame) => this.handleVideoFrame(frame),
        onStats: (stats) => this.handlePlaybackStats(stats),
        onError: (error) => this.failPlayer(error)
      });
      this.player.start(this.media).catch((error) => this.failPlayer(error));
      return;
    }
    if (this.media.mode === "direct_webrtc") {
      this.player = new DirectWebRtcScreenPlayer({
        video: this.video,
        onFirstFrame: (metadata) => this.emit("live", "实时画面已连接", { ...this.channelMetadata, ...metadata, ...this.lastStats }),
        onStats: (stats) => this.handlePlaybackStats(stats),
        onError: (error) => this.failPlayer(error)
      });
      this.player.start(this.media).catch((error) => this.failPlayer(error));
      return;
    }
    if (codec && !String(codec).toLowerCase().includes("264") && codec !== 0x68323634) {
      throw new Error(`当前投屏只支持 H.264，收到 ${codec}`);
    }
    this.player = new MediaSourceScreenPlayer({
      video: this.video,
      onFirstFrame: (metadata) => {
        this.emit("live", "实时画面已连接", { ...this.channelMetadata, ...metadata, ...this.lastStats });
      },
      onStats: (stats) => this.handlePlaybackStats(stats),
      onError: (error) => this.failPlayer(error)
    });
    this.player.start();
  }

  handlePlaybackStats(stats) {
    if (stats?.diagnostic) {
      this.send({ type: "screen_playback_diagnostic", diagnostic: stats.diagnostic });
      return;
    }
    this.lastStats = { ...this.lastStats, ...stats };
    this.video.dataset.screenFps = Number(stats.fps || 0).toFixed(1);
    this.video.dataset.screenDecoded = String(stats.decoded || 0);
    this.video.dataset.screenDropped = String(stats.dropped || 0);
    this.video.dataset.screenPresented = String(stats.presented || 0);
    this.video.dataset.screenBufferMs = String(Math.round(Number(stats.bufferSeconds || 0) * 1000));
    this.onMetrics(this.lastStats);
    this.playbackMetrics.report(this.lastStats);
  }

  failPlayer(error) {
    if (this.failureMessage) return;
    this.failureMessage = `视频播放失败：${error?.message || error || "浏览器不支持当前视频流"}`;
    this.emit("failed", this.failureMessage, {
      decoderBackend: ["webrtc", "direct_webrtc"].includes(this.media.mode) ? this.media.mode : "mse",
      ...this.lastStats
    });
    this.transport.close(1000, "player_failed");
  }

  send(message) {
    this.transport.send(message);
  }

  sendControl(message) {
    this.controlSentAt.set(message.sequenceId, {
      sentAt: globalThis.performance?.now?.() || Date.now(),
      control: message
    });
    while (this.controlSentAt.size > 256) this.controlSentAt.delete(this.controlSentAt.keys().next().value);
    this.send(message);
  }

  updateControlSourceSize(metadata = {}) {
    const width = Number(metadata.width || metadata.videoWidth || 0);
    const height = Number(metadata.height || metadata.videoHeight || 0);
    if (width > 0 && height > 0) this.controlInput.setSourceSize(width, height);
  }

  handleControlAcknowledgement(message) {
    const sent = this.controlSentAt.get(message.sequenceId);
    this.controlSentAt.delete(message.sequenceId);
    if (message.status !== "injected" || !sent) return;
    const now = globalThis.performance?.now?.() || Date.now();
    this.lastStats = {
      ...this.lastStats,
      controlRttMs: Math.max(0, now - sent.sentAt),
      agentControlMs: Math.max(0, Number(message.agentElapsedMs || 0))
    };
    if (shouldProbeVisualLatency(sent.control, message)) {
      this.pendingVisualProbe = {
        sequenceId: Number(message.sequenceId || 0),
        action: String(message.action || "unknown"),
        sentAt: sent.sentAt,
        acknowledgedAt: now
      };
    }
    this.video.dataset.screenControlRttMs = this.lastStats.controlRttMs.toFixed(1);
    this.video.dataset.screenAgentControlMs = this.lastStats.agentControlMs.toFixed(1);
    this.onMetrics(this.lastStats);
    this.playbackMetrics.report(this.lastStats);
  }

  handleVideoFrame(frame = {}) {
    const probe = this.pendingVisualProbe;
    if (!probe) return;
    const presentedAt = Number(frame.presentedAt || globalThis.performance?.now?.() || Date.now());
    if (presentedAt < probe.acknowledgedAt) return;
    this.pendingVisualProbe = null;
    this.handlePlaybackStats({
      diagnostic: {
        event: "control_to_presented_frame",
        sequenceId: probe.sequenceId,
        action: probe.action,
        controlToPresentedMs: Math.max(0, presentedAt - probe.sentAt),
        acknowledgementToPresentedMs: Math.max(0, presentedAt - probe.acknowledgedAt),
        mediaTime: Number(frame.mediaTime || 0),
        presentedFrames: Number(frame.presentedFrames || 0)
      }
    });
  }

  key(key) {
    this.controlInput.key(key);
  }

  text(value) {
    this.controlInput.text(value);
  }

  disconnect(closeSocket = true) {
    this.failureMessage = "";
    this.transportClosed = true;
    if (closeSocket) this.transport.close(1000, "user_closed");
    this.cleanupPlayer();
  }

  handleTransportError(channel) {
    if (this.transportClosed) return;
    // Browsers emit a generic error before the close event. Keep waiting for
    // close so the UI can show the real WebSocket code/reason instead of a
    // misleading catch-all error.
    this.transportErrorChannel = channel || "control";
  }

  handleTransportClose(channel = "control", event = {}) {
    if (this.transportClosed) return;
    this.transportClosed = true;
    const effectiveChannel = channel || this.transportErrorChannel || "control";
    const label = effectiveChannel === "control" ? "控制通道" : "视频通道";
    const closeCode = Number(event?.code || 0);
    const closeReason = String(event?.reason || "").trim();
    const message = this.failureMessage || `${label}连接失败${closeCode ? `（${closeCode}${closeReason ? `：${closeReason}` : ""}）` : ""}`;
    this.transport.close(1000, "peer_closed");
    this.cleanupPlayer();
    this.emit(this.failureMessage ? "failed" : "closed", message);
  }

  destroy() {
    this.disconnect();
    this.controlInput.destroy();
  }

  cleanupPlayer() {
    this.player?.stop();
    this.player = null;
    this.lastStats = {};
    this.channelMetadata = {};
    this.media = { mode: "websocket" };
    this.controlInput.setSourceSize(0, 0);
    this.controlSentAt.clear();
    this.pendingVisualProbe = null;
    this.mediaReaderGeneration = 0;
    this.playbackMetrics.reset();
  }

  emit(status, detail, metadata = {}) {
    this.onStatus({ status, detail, metadata });
  }
}

function shouldProbeVisualLatency(control = {}, acknowledgement = {}) {
  if (control?.type === "touch") return control.action === "up" && acknowledgement.action === "up";
  return acknowledgement.action !== "move";
}

export function createPlaybackMetricsReporter({
  send = () => false,
  now = () => globalThis.performance?.now?.() || Date.now(),
  intervalMs = 5_000
} = {}) {
  let lastReportedAt = -Infinity;
  const minimumIntervalMs = Math.max(1_000, Number(intervalMs || 5_000));
  return {
    report(metrics = {}) {
      const at = now();
      if (at - lastReportedAt < minimumIntervalMs) return false;
      const metricsPayload = {
        fps: Number(metrics.fps || 0),
        decoded: Number(metrics.decoded || 0),
        dropped: Number(metrics.dropped || 0),
        presented: Number(metrics.presented || 0),
        bufferSeconds: Number(metrics.bufferSeconds || 0),
        controlRttMs: Number(metrics.controlRttMs || 0),
        agentControlMs: Number(metrics.agentControlMs || 0)
      };
      for (const key of [
        "rtcStatsWindowMs", "rtcFramesDecoded", "rtcFramesDecodedDelta", "rtcFramesDropped", "rtcFramesPerSecond",
        "rtcPacketsLost", "rtcPacketsLostDelta", "rtcJitterMs", "rtcBytesReceived", "rtcBytesReceivedDelta",
        "rtcReceiveMbps", "rtcDecodeMsPerFrame", "rtcFreezeCount", "rtcFreezeCountDelta", "rtcTotalFreezeMs", "rtcTotalFreezeMsDelta"
      ]) {
        if (metrics[key] !== undefined && metrics[key] !== null) metricsPayload[key] = Number(metrics[key] || 0);
      }
      for (const key of ["rtcIceProtocol", "rtcIceLocalType", "rtcIceRemoteType", "rtcIcePairState"]) {
        if (metrics[key] !== undefined && metrics[key] !== null) metricsPayload[key] = String(metrics[key] || "").slice(0, 24);
      }
      for (const key of ["pageFocused", "videoInViewport", "playbackVisible"]) {
        if (metrics[key] !== undefined && metrics[key] !== null) metricsPayload[key] = Boolean(metrics[key]);
      }
      if (metrics.pageVisibilityState !== undefined && metrics.pageVisibilityState !== null) {
        metricsPayload.pageVisibilityState = String(metrics.pageVisibilityState || "unknown").slice(0, 16);
      }
      const sent = send({
        type: "screen_playback_metrics",
        metrics: metricsPayload
      });
      if (sent === false) return false;
      lastReportedAt = at;
      return true;
    },
    reset() {
      lastReportedAt = -Infinity;
    }
  };
}

export function liveScreenPlaybackStatus(hasFirstFrame = false) {
  return hasFirstFrame
    ? { status: "live", detail: "实时画面已连接" }
    : { status: "preparing", detail: "执行器已连接，正在等待手机首帧" };
}

function decodeVideoPacket(buffer) {
  const view = new DataView(buffer);
  const type = view.getUint8(0);
  const keyframe = view.getUint8(1) === 1;
  const pts = view.getBigInt64(2, false);
  const data = new Uint8Array(buffer, 10);
  if (type === 0) return { type: "configuration", data };
  return { type: "data", keyframe, pts: pts === -1n ? undefined : pts, data };
}

window.PhoneCloudScreenController = PhoneCloudScreenController;

export { PhoneCloudScreenController, decodeVideoPacket };
