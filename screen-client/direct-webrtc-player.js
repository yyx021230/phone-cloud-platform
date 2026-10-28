import { extractInboundVideoMetrics, summarizeWhepNegotiation, waitForIceGathering } from "./webrtc-player.js";

export class DirectWebRtcScreenPlayer {
  constructor({
    video,
    onFirstFrame = () => {},
    onStats = () => {},
    onError = () => {},
    RTCPeerConnectionCtor = globalThis.RTCPeerConnection,
    WebSocketCtor = globalThis.WebSocket,
    now = () => globalThis.performance?.now?.() || Date.now(),
    setRepeatingTimer = globalThis.setInterval.bind(globalThis),
    clearRepeatingTimer = globalThis.clearInterval.bind(globalThis)
  } = {}) {
    if (!video) throw new Error("缺少实时投屏 video 元素");
    if (!RTCPeerConnectionCtor || !WebSocketCtor) throw new Error("当前浏览器不支持直连 WebRTC");
    this.video = video;
    this.onFirstFrame = onFirstFrame;
    this.onStats = onStats;
    this.onError = onError;
    this.RTCPeerConnectionCtor = RTCPeerConnectionCtor;
    this.WebSocketCtor = WebSocketCtor;
    this.now = now;
    this.setRepeatingTimer = setRepeatingTimer;
    this.clearRepeatingTimer = clearRepeatingTimer;
    this.pc = null;
    this.signal = null;
    this.monitorTimer = null;
    this.started = false;
    this.failed = false;
    this.hasFirstFrame = false;
    this.presentedFrames = 0;
    this.frameCallbackId = null;
    this.previousRtc = {};
    this.negotiatedFeedback = {
      rtcNegotiatedNack: false,
      rtcNegotiatedPli: false,
      rtcNegotiatedFir: false,
      rtcNegotiatedRtx: false
    };
  }

  async start({ signalUrl, token, iceServers = [] } = {}) {
    if (this.started) return;
    if (!signalUrl || !token) throw new Error("直连 WebRTC 信令凭证缺失");
    this.started = true;
    const pc = new this.RTCPeerConnectionCtor({ iceServers: normalizeIceServers(iceServers) });
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      this.video.srcObject = stream;
      this.video.play?.().catch((error) => this.fail(error));
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState || "";
      this.onStats({ diagnostic: { event: "direct_peer_connection_state", connectionState: state, iceConnectionState: pc.iceConnectionState || "" } });
      if (this.started && ["failed", "closed"].includes(state)) this.fail(new Error(`WebRTC 连接${state}`));
    };
    pc.oniceconnectionstatechange = () => this.onStats({ diagnostic: {
      event: "direct_ice_connection_state",
      connectionState: pc.connectionState || "",
      iceConnectionState: pc.iceConnectionState || ""
    } });
    this.video.addEventListener("loadeddata", this.handleLoadedData);
    this.video.addEventListener("error", this.handleVideoError);
    this.video.addEventListener("playing", this.handlePlaying);
    this.video.addEventListener("waiting", this.handleWaiting);
    this.video.addEventListener("stalled", this.handleStalled);
    const signal = new this.WebSocketCtor(signalUrl, [String(token)]);
    this.signal = signal;
    await waitForSocketOpen(signal, 12_000);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    const answerPromise = waitForSignal(signal, "answer");
    signal.send(JSON.stringify({ type: "offer", sdp: pc.localDescription?.sdp || offer.sdp }));
    const answerMessage = await answerPromise;
    this.negotiatedFeedback = summarizeWhepNegotiation(answerMessage.sdp);
    await pc.setRemoteDescription({ type: "answer", sdp: answerMessage.sdp });
    this.requestNextVideoFrame();
    this.monitorTimer = this.setRepeatingTimer(() => this.monitorPlayback(), 250);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    if (this.monitorTimer) this.clearRepeatingTimer(this.monitorTimer);
    if (this.frameCallbackId != null && typeof this.video.cancelVideoFrameCallback === "function") {
      this.video.cancelVideoFrameCallback(this.frameCallbackId);
    }
    this.monitorTimer = null;
    this.frameCallbackId = null;
    this.video.removeEventListener("loadeddata", this.handleLoadedData);
    this.video.removeEventListener("error", this.handleVideoError);
    this.video.removeEventListener("playing", this.handlePlaying);
    this.video.removeEventListener("waiting", this.handleWaiting);
    this.video.removeEventListener("stalled", this.handleStalled);
    try { this.signal?.close(1000, "browser_closed"); } catch {}
    try { this.pc?.close(); } catch {}
    this.signal = null;
    this.pc = null;
    this.video.srcObject = null;
  }

  requestNextVideoFrame() {
    if (!this.started || typeof this.video.requestVideoFrameCallback !== "function") return;
    this.frameCallbackId = this.video.requestVideoFrameCallback(() => {
      if (!this.started) return;
      this.presentedFrames += 1;
      this.markFirstFrame();
      this.requestNextVideoFrame();
    });
  }

  async monitorPlayback() {
    if (!this.started || this.failed || !this.pc?.getStats) return;
    try {
      const reports = await this.pc.getStats();
      const metrics = extractInboundVideoMetrics(reports, { at: this.now(), previous: this.previousRtc });
      if (metrics) {
        this.previousRtc = metrics;
        this.onStats({ ...metrics, ...this.negotiatedFeedback, decoderBackend: "direct_webrtc" });
      }
    } catch (error) {
      this.onStats({ diagnostic: { event: "direct_webrtc_stats_error", message: String(error?.message || error || "unknown") } });
    }
  }

  markFirstFrame() {
    if (!this.started || this.hasFirstFrame || this.failed) return;
    this.hasFirstFrame = true;
    this.onFirstFrame({ decoderBackend: "direct_webrtc", videoWidth: Number(this.video.videoWidth || 0), videoHeight: Number(this.video.videoHeight || 0) });
  }

  fail(error) {
    if (this.failed || !this.started) return;
    this.failed = true;
    this.onError(error instanceof Error ? error : new Error(String(error || "直连 WebRTC 播放失败")));
  }

  handleLoadedData = () => this.markFirstFrame();
  handleVideoError = () => this.fail(new Error("浏览器无法播放直连 WebRTC 视频"));
  handlePlaying = () => {};
  handleWaiting = () => {};
  handleStalled = () => {};
}

function normalizeIceServers(iceServers) {
  return Array.isArray(iceServers) ? iceServers.slice(0, 8).map((item) => ({
    urls: item?.urls,
    ...(item?.username ? { username: item.username } : {}),
    ...(item?.credential ? { credential: item.credential } : {})
  })).filter((item) => item.urls) : [];
}

function waitForSocketOpen(socket, timeoutMs) {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("direct_webrtc_signal_timeout")); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("error", onError);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error instanceof Error ? error : new Error("direct_webrtc_signal_error")); };
    socket.addEventListener?.("open", onOpen);
    socket.addEventListener?.("error", onError);
  });
}

function waitForSignal(socket, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === type) {
          cleanup();
          resolve(message);
        } else if (message.type === "error") {
          cleanup();
          reject(new Error(message.message || "direct_webrtc_signal_error"));
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = () => { cleanup(); reject(new Error("direct_webrtc_signal_closed")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`direct_webrtc_${type}_timeout`)); }, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener?.("message", onMessage);
      socket.removeEventListener?.("close", onClose);
    };
    socket.addEventListener?.("message", onMessage);
    socket.addEventListener?.("close", onClose);
  });
}
