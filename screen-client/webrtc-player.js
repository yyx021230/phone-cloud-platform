export class WhepScreenPlayer {
  constructor({
    video,
    onFirstFrame = () => {},
    onReaderReady = () => {},
    onVideoFrame = () => {},
    onStats = () => {},
    onError = () => {},
    RTCPeerConnectionCtor = globalThis.RTCPeerConnection,
    fetchFn = globalThis.fetch?.bind(globalThis),
    now = () => globalThis.performance?.now?.() || Date.now(),
    setRepeatingTimer = globalThis.setInterval.bind(globalThis),
    clearRepeatingTimer = globalThis.clearInterval.bind(globalThis),
    setDelayTimer = globalThis.setTimeout.bind(globalThis),
    clearDelayTimer = globalThis.clearTimeout.bind(globalThis),
    sleepFn = sleep,
    getPlaybackVisibility = () => readPlaybackVisibility(video)
  } = {}) {
    if (!video) throw new Error("缺少实时投屏 video 元素");
    if (!RTCPeerConnectionCtor || !fetchFn) throw new Error("当前浏览器不支持 WebRTC 实时投屏");
    this.video = video;
    this.onFirstFrame = onFirstFrame;
    this.onReaderReady = onReaderReady;
    this.onVideoFrame = onVideoFrame;
    this.onStats = onStats;
    this.onError = onError;
    this.RTCPeerConnectionCtor = RTCPeerConnectionCtor;
    this.fetch = fetchFn;
    this.now = now;
    this.setRepeatingTimer = setRepeatingTimer;
    this.clearRepeatingTimer = clearRepeatingTimer;
    this.setDelayTimer = setDelayTimer;
    this.clearDelayTimer = clearDelayTimer;
    this.sleep = sleepFn;
    this.getPlaybackVisibility = getPlaybackVisibility;
    this.pc = null;
    this.resourceUrl = "";
    this.controller = null;
    this.token = "";
    this.monitorTimer = null;
    this.disconnectTimer = null;
    this.reconnectTimer = null;
    this.startOptions = null;
    this.reconnectAttempts = 0;
    this.readerReadyAnnounced = false;
    this.frameCallbackId = null;
    this.started = false;
    this.failed = false;
    this.hasFirstFrame = false;
    this.presentedFrames = 0;
    this.lastStats = { decoded: 0, dropped: 0, presented: 0, at: this.now() };
    this.fpsSamples = [];
    this.lastRtcStats = { at: 0, bytesReceived: 0 };
    this.rtcStatsInFlight = false;
    this.lastDiagnostic = { state: "", at: 0 };
    this.presentationWatchdog = { presented: 0, stalledSince: 0, lastReportedAt: -Infinity };
  }

  async start({ whepUrl, token } = {}) {
    if (this.started) return;
    if (!whepUrl || !token) throw new Error("WebRTC 媒体凭证缺失");
    this.startOptions = { whepUrl, token };
    this.started = true;
    this.token = String(token);
    this.controller = new AbortController();
    this.readerReadyAnnounced = false;
    const pc = new this.RTCPeerConnectionCtor();
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      this.video.srcObject = stream;
      this.video.play?.().catch((error) => this.fail(error));
    };
    pc.onconnectionstatechange = () => {
      this.reportDiagnostic("peer_connection_state", {
        connectionState: pc.connectionState || "",
        iceConnectionState: pc.iceConnectionState || "",
        signalingState: pc.signalingState || ""
      });
      if (!this.started) return;
      if (pc.connectionState === "disconnected") {
        // "disconnected" is an ICE liveness hint, not a terminal state. A
        // brief UDP/NAT gap commonly transitions through it and then recovers.
        // Treating it as fatal immediately creates a false "video failed"
        // error even though the same PeerConnection can resume by itself.
        this.deferDisconnectedFailure(pc);
        return;
      }
      this.clearDisconnectedFailure();
      if (pc.connectionState === "connected") {
        this.reconnectAttempts = 0;
        this.notifyReaderReadyIfConnected(pc);
      }
      if (["failed", "closed"].includes(pc.connectionState)) {
        this.fail(new Error(`WebRTC 连接${pc.connectionState}`));
      }
    };
    pc.oniceconnectionstatechange = () => {
      this.reportDiagnostic("ice_connection_state", {
        connectionState: pc.connectionState || "",
        iceConnectionState: pc.iceConnectionState || "",
        signalingState: pc.signalingState || ""
      });
      this.notifyReaderReadyIfConnected(pc);
    };
    this.video.addEventListener("loadeddata", this.handleLoadedData);
    this.video.addEventListener("error", this.handleVideoError);
    this.video.addEventListener("playing", this.handlePlaying);
    this.video.addEventListener("waiting", this.handleWaiting);
    this.video.addEventListener("stalled", this.handleStalled);
    this.video.addEventListener("emptied", this.handleEmptied);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    const response = await requestWhepAnswer({
      fetchFn: this.fetch,
      whepUrl,
      token,
      sdp: pc.localDescription?.sdp || offer.sdp,
      signal: this.controller.signal,
      // The WHEP endpoint correctly returns 404 until the Windows publisher
      // finishes WHIP negotiation. This is normal during cold start, but a
      // one-second retry ceiling leaves a visible blank screen after READY.
      // Keep retries bounded while checking often enough to attach to the
      // initial IDR promptly.
      retryDelayMs: 150,
      maxRetryDelayMs: 250,
      retryBackoffMultiplier: 1.35,
      maxAttempts: 3,
      sleepFn: this.sleep
    });
    if (!response.ok) throw new Error(`WebRTC 媒体服务返回 ${response.status}`);
    const answerSdp = await response.text();
    if (!answerSdp.trim()) throw new Error("WebRTC 媒体服务未返回会话描述");
    this.resourceUrl = resolveWhepResourceUrl(whepUrl, response.headers.get("location"));
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    // setRemoteDescription() only completes WHEP signaling. ICE may still be
    // checking, and an IDR emitted here can be sent before the browser has a
    // usable media path. Notify the source only after the peer transport is
    // actually connected so its one-shot ResetVideo reaches this reader.
    this.notifyReaderReadyIfConnected(pc);
    this.requestNextVideoFrame();
    this.monitorTimer = this.setRepeatingTimer(() => this.monitorPlayback(), 250);
  }

  notifyReaderReadyIfConnected(pc = this.pc) {
    if (!this.started || this.failed || this.pc !== pc || this.readerReadyAnnounced) return false;
    const transportConnected = pc?.connectionState === "connected"
      || ["connected", "completed"].includes(pc?.iceConnectionState);
    if (!transportConnected) return false;
    this.readerReadyAnnounced = true;
    this.onReaderReady();
    return true;
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.controller?.abort();
    if (this.monitorTimer) this.clearRepeatingTimer(this.monitorTimer);
    this.clearDisconnectedFailure();
    if (this.reconnectTimer != null) this.clearDelayTimer(this.reconnectTimer);
    if (this.frameCallbackId != null && typeof this.video.cancelVideoFrameCallback === "function") {
      this.video.cancelVideoFrameCallback(this.frameCallbackId);
    }
    const resourceUrl = this.resourceUrl;
    const pc = this.pc;
    this.pc = null;
    this.readerReadyAnnounced = false;
    this.resourceUrl = "";
    this.monitorTimer = null;
    this.reconnectTimer = null;
    this.frameCallbackId = null;
    this.video.removeEventListener("loadeddata", this.handleLoadedData);
    this.video.removeEventListener("error", this.handleVideoError);
    this.video.removeEventListener("playing", this.handlePlaying);
    this.video.removeEventListener("waiting", this.handleWaiting);
    this.video.removeEventListener("stalled", this.handleStalled);
    this.video.removeEventListener("emptied", this.handleEmptied);
    this.video.srcObject = null;
    try { pc?.close(); } catch {}
    const token = this.token;
    this.token = "";
    if (resourceUrl) this.fetch(resourceUrl, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  }

  requestNextVideoFrame() {
    if (!this.started || typeof this.video.requestVideoFrameCallback !== "function") return;
    this.frameCallbackId = this.video.requestVideoFrameCallback((now, metadata = {}) => {
      if (!this.started) return;
      this.presentedFrames += 1;
      this.markFirstFrame();
      this.onVideoFrame({
        presentedAt: Number(now || this.now()),
        presentedFrames: this.presentedFrames,
        mediaTime: Number(metadata.mediaTime || 0),
        expectedDisplayTime: Number(metadata.expectedDisplayTime || 0)
      });
      this.requestNextVideoFrame();
    });
  }

  monitorPlayback() {
    if (!this.started || this.failed) return;
    const quality = this.video.getVideoPlaybackQuality?.();
    const at = this.now();
    const decoded = quality ? Number(quality.totalVideoFrames || 0) : this.presentedFrames;
    const dropped = quality ? Number(quality.droppedVideoFrames || 0) : 0;
    const elapsedSeconds = Math.max(0.001, (at - this.lastStats.at) / 1000);
    const fps = this.presentedFps(at);
    const previous = this.lastStats;
    const visibility = this.playbackVisibility();
    this.lastStats = { decoded, dropped, presented: this.presentedFrames, at, ...visibility };
    if (this.hasFirstFrame && decoded === previous.decoded && this.presentedFrames === previous.presented) {
      // scrcpy only emits frames when the device image changes. A static screen
      // is therefore idle, not necessarily a broken WebRTC playback session.
      this.reportDiagnostic("video_frames_idle", {
        decoded,
        presented: this.presentedFrames,
        readyState: Number(this.video.readyState || 0),
        paused: Boolean(this.video.paused)
      });
    }
    this.onStats({ decoded, dropped, presented: this.presentedFrames, fps, bufferSeconds: 0, decoderBackend: "webrtc", ...visibility });
    this.collectRtcStats(at);
  }

  presentedFps(at) {
    this.fpsSamples.push({ at, presented: this.presentedFrames });
    while (this.fpsSamples.length > 1 && at - this.fpsSamples[0].at > 1_000) this.fpsSamples.shift();
    const oldest = this.fpsSamples[0];
    const elapsedSeconds = Math.max(0, (at - oldest.at) / 1_000);
    return elapsedSeconds > 0 ? Math.max(0, (this.presentedFrames - oldest.presented) / elapsedSeconds) : 0;
  }

  async collectRtcStats(at = this.now()) {
    if (!this.started || this.rtcStatsInFlight || !this.pc?.getStats) return;
    // getStats is more expensive than local video frame counters. One sample
    // per second is enough to distinguish network loss from decode/render lag.
    if (at - this.lastRtcStats.at < 1_000) return;
    this.rtcStatsInFlight = true;
    try {
      const reports = await this.pc.getStats();
      if (!this.started) return;
      const metrics = extractInboundVideoMetrics(reports, {
        at: this.now(),
        previous: this.lastRtcStats
      });
      if (!metrics) return;
      this.lastRtcStats = { ...this.lastRtcStats, ...metrics, at: metrics.at };
      const visibility = this.playbackVisibility();
      this.observePresentationProgress(metrics, visibility);
      this.onStats({ ...metrics, ...visibility, decoderBackend: "webrtc" });
    } catch (error) {
      this.reportDiagnostic("webrtc_stats_error", { message: String(error?.message || error || "unknown") });
    } finally {
      this.rtcStatsInFlight = false;
    }
  }

  markFirstFrame() {
    if (!this.started || this.hasFirstFrame || this.failed) return;
    this.hasFirstFrame = true;
    this.onFirstFrame({
      decoderBackend: "webrtc",
      videoWidth: Number(this.video.videoWidth || 0),
      videoHeight: Number(this.video.videoHeight || 0)
    });
  }

  playbackVisibility() {
    try {
      const value = this.getPlaybackVisibility?.() || {};
      return {
        pageVisibilityState: String(value.pageVisibilityState || "unknown").slice(0, 16),
        pageFocused: Boolean(value.pageFocused),
        videoInViewport: Boolean(value.videoInViewport),
        playbackVisible: Boolean(value.playbackVisible)
      };
    } catch {
      return { pageVisibilityState: "unknown", pageFocused: false, videoInViewport: false, playbackVisible: false };
    }
  }

  observePresentationProgress(metrics, visibility) {
    const at = Number(metrics?.at || this.now());
    const watchdog = this.presentationWatchdog;
    const presentedAdvanced = this.presentedFrames > watchdog.presented;
    watchdog.presented = this.presentedFrames;
    if (!this.hasFirstFrame || !visibility.playbackVisible || presentedAdvanced || Number(metrics?.rtcFramesDecodedDelta || 0) <= 0) {
      watchdog.stalledSince = 0;
      return;
    }
    if (!watchdog.stalledSince) {
      watchdog.stalledSince = at;
      return;
    }
    const stalledForMs = Math.max(0, at - watchdog.stalledSince);
    if (stalledForMs < 1_250 || at - watchdog.lastReportedAt < 5_000) return;
    watchdog.lastReportedAt = at;
    this.reportDiagnostic("visible_presentation_stall", {
      stalledForMs,
      decoded: Number(metrics?.rtcFramesDecoded || 0),
      decodedDelta: Number(metrics?.rtcFramesDecodedDelta || 0),
      presented: this.presentedFrames,
      bytesReceivedDelta: Number(metrics?.rtcBytesReceivedDelta || 0),
      ...visibility
    });
  }

  fail(error) {
    if (this.failed || !this.started) return;
    this.failed = true;
    this.onError(error instanceof Error ? error : new Error(String(error || "WebRTC 播放失败")));
  }

  deferDisconnectedFailure(pc) {
    if (this.disconnectTimer != null) return;
    const graceMs = 8_000;
    this.reportDiagnostic("peer_connection_disconnected_grace", { graceMs });
    this.disconnectTimer = this.setDelayTimer(() => {
      this.disconnectTimer = null;
      if (!this.started || this.failed || this.pc !== pc || pc.connectionState !== "disconnected") return;
      this.retryDisconnectedPeerConnection();
    }, graceMs);
  }

  retryDisconnectedPeerConnection() {
    const maxAttempts = 3;
    if (this.reconnectAttempts >= maxAttempts || !this.startOptions) {
      this.fail(new Error(`WebRTC 连接持续中断（已自动重连 ${maxAttempts} 次）`));
      return;
    }
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delayMs = [300, 800, 1_500][attempt - 1] || 1_500;
    const options = this.startOptions;
    this.reportDiagnostic("peer_connection_reconnect", { attempt, maxAttempts, delayMs });
    // A WHEP reader cannot be repaired in place once its ICE transport stays
    // disconnected. Tear down only this browser reader and request a new WHEP
    // session; the Android/scrcpy/WHIP publisher continues uninterrupted.
    this.stop();
    this.reconnectTimer = this.setDelayTimer(() => {
      this.reconnectTimer = null;
      this.start(options).catch((error) => this.fail(error));
    }, delayMs);
  }

  clearDisconnectedFailure() {
    if (this.disconnectTimer == null) return;
    this.clearDelayTimer(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  handleLoadedData = () => this.markFirstFrame();
  handleVideoError = () => this.fail(new Error("浏览器无法播放 WebRTC 视频"));
  handlePlaying = () => this.reportDiagnostic("video_playing", this.videoState());
  handleWaiting = () => this.reportDiagnostic("video_waiting", this.videoState());
  handleStalled = () => this.reportDiagnostic("video_stalled", this.videoState());
  handleEmptied = () => this.reportDiagnostic("video_emptied", this.videoState());

  videoState() {
    return {
      readyState: Number(this.video.readyState || 0),
      paused: Boolean(this.video.paused),
      videoWidth: Number(this.video.videoWidth || 0),
      videoHeight: Number(this.video.videoHeight || 0)
    };
  }

  reportDiagnostic(event, detail = {}) {
    const at = this.now();
    const state = `${event}:${JSON.stringify(detail)}`;
    // Browser media events are noisy. Keep state transitions, and at most one
    // identical diagnostic per five seconds, so production logs stay useful.
    if (this.lastDiagnostic.state === state && at - this.lastDiagnostic.at < 5_000) return;
    this.lastDiagnostic = { state, at };
    this.onStats({ diagnostic: { event, ...detail } });
  }
}

export function readPlaybackVisibility(video, {
  documentRef = globalThis.document,
  viewportWidth = Number(globalThis.innerWidth || 0),
  viewportHeight = Number(globalThis.innerHeight || 0)
} = {}) {
  const pageVisibilityState = String(documentRef?.visibilityState || "unknown").toLowerCase();
  const pageFocused = typeof documentRef?.hasFocus === "function" ? Boolean(documentRef.hasFocus()) : true;
  let videoInViewport = !video?.hidden;
  if (videoInViewport && typeof video?.getBoundingClientRect === "function") {
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Number(rect?.width ?? Number(rect?.right || 0) - Number(rect?.left || 0)));
    const height = Math.max(0, Number(rect?.height ?? Number(rect?.bottom || 0) - Number(rect?.top || 0)));
    const viewportKnown = viewportWidth > 0 && viewportHeight > 0;
    videoInViewport = width > 0 && height > 0 && (!viewportKnown || (
      Number(rect?.right || 0) > 0
      && Number(rect?.bottom || 0) > 0
      && Number(rect?.left || 0) < viewportWidth
      && Number(rect?.top || 0) < viewportHeight
    ));
  }
  const pageVisible = pageVisibilityState === "visible" || pageVisibilityState === "unknown";
  return {
    pageVisibilityState,
    pageFocused,
    videoInViewport,
    playbackVisible: pageVisible && pageFocused && videoInViewport
  };
}

export function buildWhepRequestHeaders(token) {
  return {
    "content-type": "application/sdp",
    authorization: `Bearer ${String(token || "").trim()}`
  };
}

export function extractInboundVideoMetrics(reports, { at = Date.now(), previous = {} } = {}) {
  const inbound = selectInboundVideoReport(reports, previous.rtcInboundReportId);
  if (!inbound) return null;
  const bytesReceived = finiteNumber(inbound.bytesReceived);
  const packetsLost = finiteNumber(inbound.packetsLost);
  const framesDecoded = finiteNumber(inbound.framesDecoded);
  const freezeCount = finiteNumber(inbound.freezeCount);
  const totalFreezeMs = finiteNumber(inbound.totalFreezesDuration) * 1_000;
  const sameInboundReport = Boolean(previous.rtcInboundReportId && previous.rtcInboundReportId === inbound.rtcInboundReportId);
  const previousAt = finiteNumber(previous.at);
  const elapsedMs = sameInboundReport ? Math.max(1, Number(at) - previousAt) : 0;
  const bytesReceivedDelta = Math.max(0, bytesReceived - finiteNumber(previous.rtcBytesReceived ?? previous.bytesReceived));
  const packetsLostDelta = Math.max(0, packetsLost - finiteNumber(previous.rtcPacketsLost));
  const framesDecodedDelta = Math.max(0, framesDecoded - finiteNumber(previous.rtcFramesDecoded));
  const freezeCountDelta = Math.max(0, freezeCount - finiteNumber(previous.rtcFreezeCount));
  const totalFreezeMsDelta = Math.max(0, totalFreezeMs - finiteNumber(previous.rtcTotalFreezeMs));
  const receivedMbps = previousAt > 0
    && sameInboundReport ? bytesReceivedDelta * 8 / elapsedMs / 1_000
    : 0;
  const totalDecodeTime = finiteNumber(inbound.totalDecodeTime);
  const icePath = extractSelectedIcePath(reports, inbound);
  return {
    at: Number(at),
    rtcInboundReportId: inbound.rtcInboundReportId,
    rtcStatsWindowMs: previousAt > 0 && sameInboundReport ? elapsedMs : 0,
    rtcFramesDecoded: framesDecoded,
    rtcFramesDecodedDelta: previousAt > 0 && sameInboundReport ? framesDecodedDelta : 0,
    rtcFramesDropped: finiteNumber(inbound.framesDropped),
    rtcFramesPerSecond: finiteNumber(inbound.framesPerSecond),
    rtcPacketsLost: packetsLost,
    rtcPacketsLostDelta: previousAt > 0 && sameInboundReport ? packetsLostDelta : 0,
    rtcJitterMs: finiteNumber(inbound.jitter) * 1_000,
    rtcBytesReceived: bytesReceived,
    rtcBytesReceivedDelta: previousAt > 0 && sameInboundReport ? bytesReceivedDelta : 0,
    rtcReceiveMbps: receivedMbps,
    rtcDecodeMsPerFrame: framesDecoded > 0 ? totalDecodeTime * 1_000 / framesDecoded : 0,
    rtcFreezeCount: freezeCount,
    rtcFreezeCountDelta: previousAt > 0 && sameInboundReport ? freezeCountDelta : 0,
    rtcTotalFreezeMs: totalFreezeMs,
    rtcTotalFreezeMsDelta: previousAt > 0 && sameInboundReport ? totalFreezeMsDelta : 0,
    ...icePath
  };
}

function extractSelectedIcePath(reports, inbound) {
  const entries = new Map();
  for (const [id, report] of reports?.entries?.() || []) {
    entries.set(String(report?.id || id), report);
  }
  const transport = entries.get(String(inbound?.transportId || ""));
  const pair = entries.get(String(transport?.selectedCandidatePairId || ""));
  if (!pair || pair.type !== "candidate-pair") return {};
  const local = entries.get(String(pair.localCandidateId || ""));
  const remote = entries.get(String(pair.remoteCandidateId || ""));
  return {
    ...(iceField("rtcIceProtocol", local?.protocol)),
    ...(iceField("rtcIceLocalType", local?.candidateType)),
    ...(iceField("rtcIceRemoteType", remote?.candidateType)),
    ...(iceField("rtcIcePairState", pair?.state))
  };
}

function iceField(key, value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized ? { [key]: normalized } : {};
}

function selectInboundVideoReport(reports, preferredReportId = "") {
  const codecs = new Map();
  const candidates = [];
  for (const [id, report] of reports?.entries?.() || []) {
    if (report?.type === "codec") codecs.set(String(report.id || id), report);
  }
  for (const [id, report] of reports?.entries?.() || []) {
    const kind = String(report?.kind || report?.mediaType || "").toLowerCase();
    if (report?.type !== "inbound-rtp" || kind !== "video" || report.isRemote) continue;
    const reportId = String(report.id || id);
    const codec = codecs.get(String(report.codecId || ""));
    const mimeType = String(codec?.mimeType || "").toLowerCase();
    candidates.push({ ...report, rtcInboundReportId: reportId, isRetransmission: /(?:\/rtx|\/red|\/ulpfec)$/.test(mimeType) });
  }
  if (!candidates.length) return null;
  const previous = candidates.find((item) => item.rtcInboundReportId === String(preferredReportId || ""));
  if (previous) return previous;
  const primary = candidates.filter((item) => !item.isRetransmission);
  return (primary.length ? primary : candidates)
    .sort((left, right) => finiteNumber(right.bytesReceived) - finiteNumber(left.bytesReceived))[0];
}

function finiteNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolveWhepResourceUrl(whepUrl, location) {
  if (!location) return "";
  const endpoint = new URL(whepUrl);
  const resource = new URL(location, endpoint);
  // MediaMTX returns an absolute upstream path such as `/pc/slot-1/whep/id`.
  // When it sits behind our `/webrtc/` reverse-proxy prefix, resolving that
  // path against the public origin loses the prefix and DELETE goes to the app
  // server instead of MediaMTX. Keep the public mount prefix for that case.
  const marker = endpoint.pathname.indexOf("/pc/");
  if (marker > 0 && String(location).startsWith("/")) {
    resource.pathname = `${endpoint.pathname.slice(0, marker)}${resource.pathname}`;
  }
  return resource.toString();
}

export async function requestWhepAnswer({
  fetchFn,
  whepUrl,
  token,
  sdp,
  signal,
  availabilityTimeoutMs = 15_000,
  retryDelayMs = 250,
  maxRetryDelayMs = 1_000,
  retryBackoffMultiplier = 1.6,
  maxAttempts = 3,
  sleepFn = sleep,
  now = () => Date.now()
} = {}) {
  const deadline = now() + Math.max(0, Number(availabilityTimeoutMs) || 0);
  const request = () => fetchFn(whepUrl, {
    method: "POST",
    headers: buildWhepRequestHeaders(token),
    body: sdp,
    signal
  });
  let delayMs = Math.max(0, Number(retryDelayMs) || 0);
  const maxDelayMs = Math.max(delayMs, Number(maxRetryDelayMs) || delayMs);
  const multiplier = Math.max(1, Number(retryBackoffMultiplier) || 1);
  const attemptLimit = Math.max(1, Math.min(10, Math.round(Number(maxAttempts) || 3)));
  let attempts = 1;
  let response = await request();
  while (response.status === 404 && attempts < attemptLimit && now() < deadline) {
    await sleepFn(delayMs);
    response = await request();
    attempts += 1;
    delayMs = Math.min(maxDelayMs, Math.ceil(delayMs * multiplier));
  }
  return response;
}

export function waitForIceGathering(pc, timeoutMs = 3_000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pc.removeEventListener?.("icegatheringstatechange", listener);
      resolve();
    };
    const listener = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener?.("icegatheringstatechange", listener);
    if (settled) return;
    timer = setTimeout(done, timeoutMs);
  });
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
