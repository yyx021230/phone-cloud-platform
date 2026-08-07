import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createVideoBackpressureGate } from "./screen-backpressure.mjs";
import { selectScreenQuality } from "./screen-quality.mjs";

const MAX_CONTROL_MESSAGES_PER_SECOND = 120;

export function encodeAgentVideoPacket(sessionId, videoPacket) {
  const id = Buffer.from(String(sessionId || ""), "utf8");
  if (!id.length || id.length > 255) throw new Error("invalid_screen_session_id");
  return Buffer.concat([Buffer.from([1, id.length]), id, Buffer.from(videoPacket)]);
}

export function decodeAgentVideoPacket(input) {
  const packet = Buffer.from(input);
  if (packet.length < 3 || packet[0] !== 1) throw new Error("invalid_screen_video_packet");
  const idLength = packet[1];
  if (!idLength || packet.length < 2 + idLength + 10) throw new Error("invalid_screen_video_packet");
  return {
    sessionId: packet.subarray(2, 2 + idLength).toString("utf8"),
    videoPacket: packet.subarray(2 + idLength)
  };
}

export function createScreenRelay(options) {
  const {
    server,
    registry,
    authenticateAgent,
    onSessionClosed = () => {},
    logger = console,
    metrics = null,
    bandwidthMbps = 100,
    qualitySelector = selectScreenQuality,
    buildMediaStart = () => ({ mode: "websocket" })
  } = options;
  const agents = new Map();
  const agentCapabilities = new Map();
  const browsers = new Map();
  const browserControls = new Map();
  const browserVideos = new Map();
  const directWebRtcPeers = new Map();
  const agentVideoPublishers = new Map();
  const videoBootstrapBySession = new Map();
  const browserVideoGates = new Map();
  const browserDisconnectTimers = new Map();
  const browserConnectTimers = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15_000);
  heartbeatTimer.unref?.();

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    const browserMatch = url.pathname.match(/^\/api\/v1\/screen-sessions\/([^/]+)\/stream$/);
    const agentMatch = url.pathname.match(/^\/api\/v1\/windows-agents\/([^/]+)\/screen-relay$/);
    const browserControlMatch = url.pathname.match(/^\/realtime\/v1\/sessions\/([^/]+)\/control$/);
    const browserVideoMatch = url.pathname.match(/^\/realtime\/v1\/sessions\/([^/]+)\/video$/);
    const agentVideoMatch = url.pathname.match(/^\/realtime\/v1\/sessions\/([^/]+)\/video-publish$/);
    const directWebRtcMatch = url.pathname.match(/^\/realtime\/v1\/sessions\/([^/]+)\/direct-webrtc$/);
    if (!browserMatch && !agentMatch && !browserControlMatch && !browserVideoMatch && !agentVideoMatch && !directWebRtcMatch) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on("pong", () => { ws.isAlive = true; });
      if (agentMatch) handleAgentConnection(ws, req, decodeURIComponent(agentMatch[1]));
      else if (agentVideoMatch) handleAgentVideoConnection(
        ws,
        req,
        decodeURIComponent(agentVideoMatch[1]),
        url.searchParams.get("agentId") || ""
      );
      else if (browserControlMatch) handleBrowserControlConnection(ws, decodeURIComponent(browserControlMatch[1]), browserCredential(req, url));
      else if (browserVideoMatch) handleBrowserVideoConnection(ws, decodeURIComponent(browserVideoMatch[1]), browserCredential(req, url));
      else if (directWebRtcMatch) handleDirectWebRtcConnection(
        ws,
        req,
        decodeURIComponent(directWebRtcMatch[1]),
        String(url.searchParams.get("role") || "browser").toLowerCase(),
        String(url.searchParams.get("agentId") || ""),
        browserCredential(req, url)
      );
      else handleBrowserConnection(ws, decodeURIComponent(browserMatch[1]), browserCredential(req, url));
    });
  });

  function handleAgentConnection(ws, req, agentId) {
    try {
      authenticateAgent(req, agentId);
    } catch {
      ws.close(1008, "unauthorized");
      return;
    }
    const previous = agents.get(agentId);
    if (previous && previous.readyState === WebSocket.OPEN) {
      // A second local Agent instance must never evict the one that owns
      // active screen sessions. It will retry after the existing socket dies.
      logger.warn?.("screen relay duplicate agent rejected", { agentId });
      ws.close(1013, "agent_already_connected");
      return;
    }
    agents.set(agentId, ws);
    ws.send(JSON.stringify({ type: "screen_relay_ready", agentId }));
    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) return forwardVideo(data);
        handleAgentMessage(agentId, JSON.parse(data.toString("utf8")));
      } catch (error) {
        logger.error("screen relay agent message", { agentId, error: error.message });
      }
    });
    ws.on("close", () => {
      if (agents.get(agentId) !== ws) return;
      agents.delete(agentId);
      agentCapabilities.delete(agentId);
      for (const session of registry.sessions.values()) {
        if (session.agentId !== agentId || !["connecting", "ready", "streaming"].includes(session.status)) continue;
        videoBootstrapBySession.delete(session.sessionId);
        browserVideoGates.delete(session.sessionId);
        closeAgentVideo(session.sessionId, 1011, "agent_disconnected");
        registry.close(session.sessionId, "failed", "Windows 管理器连接已断开");
        metrics?.sessionClosed?.(session.sessionId, "agent_disconnected");
        closeBrowser(session.sessionId, 1011, "agent_disconnected");
        onSessionClosed(registry.get(session.sessionId), "agent_disconnected");
      }
    });
  }

  function handleAgentVideoConnection(ws, req, sessionId, agentId) {
    try {
      authenticateAgent(req, agentId);
    } catch {
      ws.close(1008, "unauthorized");
      return;
    }
    const session = registry.getMutable(sessionId);
    if (!session || session.agentId !== agentId || !["connecting", "ready", "streaming"].includes(session.status)) {
      ws.close(1008, "invalid_session");
      return;
    }
    const previous = agentVideoPublishers.get(sessionId);
    if (previous && previous.readyState === WebSocket.OPEN) previous.close(1000, "video_publisher_replaced");
    agentVideoPublishers.set(sessionId, ws);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      try {
        forwardSessionVideo(sessionId, data);
      } catch (error) {
        logger.error("screen relay dedicated video", { agentId, sessionId, error: error.message });
      }
    });
    ws.on("close", () => {
      if (agentVideoPublishers.get(sessionId) === ws) agentVideoPublishers.delete(sessionId);
    });
  }

  function handleDirectWebRtcConnection(ws, req, sessionId, role, agentId, browserToken) {
    const session = registry.getMutable(sessionId);
    if (!session || !["connecting", "ready", "streaming"].includes(session.status)) {
      ws.close(1008, "invalid_session");
      return;
    }
    if (role === "agent") {
      try {
        authenticateAgent(req, agentId);
      } catch {
        ws.close(1008, "unauthorized");
        return;
      }
      if (!agentId || session.agentId !== agentId) {
        ws.close(1008, "agent_session_mismatch");
        return;
      }
    } else {
      const authorization = registry.authorizeBrowser(sessionId, browserToken);
      if (!authorization.ok) {
        ws.close(1008, "unauthorized");
        return;
      }
    }

    let peer = directWebRtcPeers.get(sessionId);
    if (!peer) {
      peer = { browser: null, agent: null, browserQueue: [], agentQueue: [], closing: false };
      directWebRtcPeers.set(sessionId, peer);
    }
    const field = role === "agent" ? "agent" : "browser";
    const queueField = role === "agent" ? "agentQueue" : "browserQueue";
    const current = peer[field];
    if (current && current !== ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(current.readyState)) {
      current.close(1013, "direct_peer_replaced");
    }
    peer[field] = ws;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, "direct_signaling_text_only");
        return;
      }
      try {
        const message = sanitizeDirectWebRtcSignal(JSON.parse(data.toString("utf8")));
        const target = role === "agent" ? peer.browser : peer.agent;
        const targetQueue = role === "agent" ? "browserQueue" : "agentQueue";
        if (target?.readyState === WebSocket.OPEN) target.send(JSON.stringify(message));
        else if (peer[targetQueue].length < 32) peer[targetQueue].push(message);
      } catch (error) {
        ws.close(1007, error?.message || "invalid_direct_signal");
      }
    });
    ws.on("close", () => {
      if (peer[field] !== ws) return;
      peer[field] = null;
      if (!peer.closing && registry.getMutable(sessionId) && ["connecting", "ready", "streaming"].includes(registry.getMutable(sessionId).status)) {
        stop(sessionId, `direct_webrtc_${role}_closed`);
      }
      if (!peer.browser && !peer.agent) directWebRtcPeers.delete(sessionId);
    });
    ws.on("error", () => {});
    for (const message of peer[queueField].splice(0)) ws.send(JSON.stringify(message));
  }

  function handleBrowserControlConnection(ws, sessionId, token) {
    const authorization = registry.authorizeBrowser(sessionId, token);
    if (!authorization.ok) {
      logger.warn?.("screen relay browser control rejected", {
        sessionId,
        reason: "browser_token_invalid",
        suppliedTokenFingerprint: tokenFingerprint(token),
        expectedTokenFingerprint: authorization.session?.browserTokenHash?.slice(0, 12) || "missing"
      });
      ws.close(1008, "unauthorized");
      return;
    }
    const session = authorization.session;
    const previous = browserControls.get(sessionId);
    if (previous && previous.readyState === WebSocket.OPEN) previous.close(1000, "controller_replaced");
    clearTimeout(browserConnectTimers.get(sessionId));
    browserConnectTimers.delete(sessionId);
    clearTimeout(browserDisconnectTimers.get(sessionId));
    browserDisconnectTimers.delete(sessionId);
    browserControls.set(sessionId, ws);
    registry.update(sessionId, { browserConnected: true });
    logger.info?.("screen relay browser control connected", { sessionId, agentId: session.agentId });
    sendBrowserStatus(sessionId);
    attachBrowserControlMessages(ws, session);
    ws.on("error", (error) => {
      logger.warn?.("screen relay browser control socket error", {
        sessionId,
        error: error?.message || String(error || "socket_error")
      });
    });
    ws.on("close", (code, reasonBuffer) => {
      logger.info?.("screen relay browser control closed", {
        sessionId,
        code,
        reason: Buffer.from(reasonBuffer || "").toString("utf8") || "none"
      });
      if (browserControls.get(sessionId) !== ws) return;
      browserControls.delete(sessionId);
      registry.update(sessionId, { browserConnected: false });
      scheduleBrowserDisconnect(sessionId);
    });
  }

  function handleBrowserVideoConnection(ws, sessionId, token) {
    const authorization = registry.authorizeBrowser(sessionId, token);
    if (!authorization.ok) {
      logger.warn?.("screen relay browser video rejected", {
        sessionId,
        reason: "browser_token_invalid",
        suppliedTokenFingerprint: tokenFingerprint(token),
        expectedTokenFingerprint: authorization.session?.browserTokenHash?.slice(0, 12) || "missing"
      });
      ws.close(1008, "unauthorized");
      return;
    }
    const previous = browserVideos.get(sessionId);
    if (previous && previous.readyState === WebSocket.OPEN) previous.close(1000, "video_consumer_replaced");
    browserVideos.set(sessionId, ws);
    browserVideoGates.set(sessionId, createVideoBackpressureGate());
    sendVideoBootstrap(sessionId, ws);
    ws.on("close", () => {
      if (browserVideos.get(sessionId) !== ws) return;
      browserVideos.delete(sessionId);
      browserVideoGates.delete(sessionId);
    });
  }

  function attachBrowserControlMessages(ws, session) {
    let rateWindowAt = Date.now();
    let rateCount = 0;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const message = JSON.parse(data.toString("utf8"));
        if (message?.type === "screen_playback_metrics") {
          const playbackMetrics = sanitizeBrowserPlaybackMetrics(message.metrics);
          metrics?.browserPlaybackReported?.(session.sessionId, playbackMetrics);
          logger.info?.("screen relay browser metrics", {
            sessionId: session.sessionId,
            agentId: session.agentId,
            ...playbackMetrics
          });
          return;
        }
        if (message?.type === "screen_playback_diagnostic") {
          logger.info?.("screen relay browser playback", {
            sessionId: session.sessionId,
            agentId: session.agentId,
            ...sanitizeBrowserPlaybackDiagnostic(message.diagnostic)
          });
          return;
        }
        if (message?.type === "screen_media_reader_ready") {
          const generation = sanitizeMediaReaderGeneration(message.generation);
          if (sendAgent(session.agentId, {
            type: "screen_media_reader_ready",
            sessionId: session.sessionId,
            generation
          })) {
            logger.info?.("screen relay media reader ready", {
              sessionId: session.sessionId,
              agentId: session.agentId,
              generation
            });
          }
          return;
        }
        const control = validateControlMessage(message);
        const now = Date.now();
        if (now - rateWindowAt >= 1000) {
          rateWindowAt = now;
          rateCount = 0;
        }
        rateCount += 1;
        if (shouldThrottleControlMessage(control, rateCount)) {
          sendJson(ws, {
            type: "screen_control_ack",
            sequenceId: control.sequenceId,
            status: "coalesced",
            action: "move",
            agentElapsedMs: 0
          });
          return;
        }
        if (sendAgent(session.agentId, { type: "screen_control", sessionId: session.sessionId, control })) {
          metrics?.controlForwarded?.(session.sessionId, control.sequenceId);
        }
      } catch (error) {
        sendJson(ws, { type: "status", status: "failed", detail: error.message });
      }
    });
  }

  function scheduleBrowserDisconnect(sessionId) {
    const timer = setTimeout(() => {
      browserDisconnectTimers.delete(sessionId);
      if (!browserControls.has(sessionId) && !browsers.has(sessionId)) stop(sessionId, "browser_disconnected");
    }, 10_000);
    timer.unref?.();
    browserDisconnectTimers.set(sessionId, timer);
  }

  function scheduleBrowserConnectTimeout(sessionId) {
    clearTimeout(browserConnectTimers.get(sessionId));
    const timer = setTimeout(() => {
      browserConnectTimers.delete(sessionId);
      if (!browserControls.has(sessionId) && !browsers.has(sessionId)) stop(sessionId, "browser_connect_timeout");
    }, 30_000);
    timer.unref?.();
    browserConnectTimers.set(sessionId, timer);
  }

  function handleBrowserConnection(ws, sessionId, token) {
    const authorization = registry.authorizeBrowser(sessionId, token);
    if (!authorization.ok) {
      logger.warn?.("screen relay browser legacy rejected", {
        sessionId,
        reason: "browser_token_invalid",
        suppliedTokenFingerprint: tokenFingerprint(token),
        expectedTokenFingerprint: authorization.session?.browserTokenHash?.slice(0, 12) || "missing"
      });
      ws.close(1008, "unauthorized");
      return;
    }
    const session = authorization.session;
    const previous = browsers.get(sessionId);
    if (previous && previous.readyState === WebSocket.OPEN) previous.close(1000, "controller_replaced");
    clearTimeout(browserConnectTimers.get(sessionId));
    browserConnectTimers.delete(sessionId);
    clearTimeout(browserDisconnectTimers.get(sessionId));
    browserDisconnectTimers.delete(sessionId);
    browsers.set(sessionId, ws);
    browserVideoGates.set(sessionId, createVideoBackpressureGate());
    registry.update(sessionId, { browserConnected: true });
    sendBrowserStatus(sessionId);
    sendVideoBootstrap(sessionId, ws);
    attachBrowserControlMessages(ws, session);
    ws.on("close", () => {
      if (browsers.get(sessionId) !== ws) return;
      browsers.delete(sessionId);
      registry.update(sessionId, { browserConnected: false });
      scheduleBrowserDisconnect(sessionId);
    });
  }

  function handleAgentMessage(agentId, message) {
    if (message?.type === "screen_capabilities") {
      const transports = [
        ...(Array.isArray(message.transports) ? message.transports : []),
        ...(Array.isArray(message.mediaTransports) ? message.mediaTransports : [])
      ].map((item) => String(item || "")).filter(Boolean).slice(0, 16);
      agentCapabilities.set(agentId, {
        transports,
        maxSize: Math.max(0, Number(message.maxSize || 0)),
        maxFps: Math.max(0, Number(message.maxFps || 0)),
        maxVideoBitRate: Math.max(0, Number(message.maxVideoBitRate || 0)),
        maxConcurrentSessions: Math.max(0, Number(message.maxConcurrentSessions || 0))
      });
      return;
    }
    if (message?.type === "screen_session_inventory") {
      const reported = Array.isArray(message.sessions) ? message.sessions : [];
      for (const item of reported.slice(0, 100)) {
        const sessionId = String(item?.sessionId || "");
        if (!sessionId) continue;
        const session = registry.getMutable(sessionId);
        if (session && session.agentId === agentId && ["connecting", "ready", "streaming"].includes(session.status)) continue;
        logger.warn?.("screen relay stopping orphaned agent session", {
          agentId,
          sessionId,
          serial: String(item?.serial || "")
        });
        sendAgent(agentId, { type: "screen_stop", sessionId, reason: "server_session_reconciled" });
      }
      return;
    }
    if (message?.type === "screen_stream_metrics") {
      const session = registry.getMutable(message.sessionId);
      if (!session || session.agentId !== agentId) return;
      const streamMetrics = sanitizeAgentStreamMetrics(message.metrics);
      metrics?.agentStreamReported?.(session.sessionId, streamMetrics);
      logger.info?.("screen relay agent stream metrics", {
        sessionId: session.sessionId,
        agentId,
        ...streamMetrics
      });
      return;
    }
    if (message?.type === "screen_source_frame_diagnostic") {
      const session = registry.getMutable(message.sessionId);
      if (!session || session.agentId !== agentId) return;
      logger.info?.("screen relay source frame", {
        sessionId: session.sessionId,
        agentId,
        ...sanitizeScreenSourceFrameDiagnostic(message.diagnostic)
      });
      return;
    }
    if (message?.type === "screen_control_ack") {
      const session = registry.getMutable(message.sessionId);
      if (!session || session.agentId !== agentId) return;
      metrics?.controlAcknowledged?.(session.sessionId, message.sequenceId, message.agentElapsedMs);
      sendJson(browserControls.get(session.sessionId) || browsers.get(session.sessionId), sanitizeControlAcknowledgement(message));
      return;
    }
    if (!message || message.type !== "screen_status") return;
    const session = registry.getMutable(message.sessionId);
    if (!session || session.agentId !== agentId) return;
    const statusMap = { preparing: "connecting", recovering: "connecting", ready: "ready", live: "streaming", failed: "failed", closed: "closed" };
    const status = statusMap[message.status] || "connecting";
    const previousStatus = session.status;
    registry.update(session.sessionId, {
      status,
      statusMessage: String(message.detail || ""),
      metadata: sanitizeScreenMetadata(message.metadata),
      agentConnected: !["failed", "closed"].includes(status)
    });
    logger.info?.("screen relay status", {
      sessionId: session.sessionId,
      agentId,
      previousStatus,
      status,
      wireStatus: String(message.status || ""),
      detail: String(message.detail || "").slice(0, 180)
    });
    sendBrowserStatus(session.sessionId, message.status);
    if (["failed", "closed"].includes(status)) {
      videoBootstrapBySession.delete(session.sessionId);
      browserVideoGates.delete(session.sessionId);
      metrics?.sessionClosed?.(session.sessionId, status);
      closeBrowser(session.sessionId, status === "failed" ? 1011 : 1000, status);
      onSessionClosed(registry.get(session.sessionId), status);
    }
  }

  function forwardVideo(data) {
    const { sessionId, videoPacket } = decodeAgentVideoPacket(data);
    forwardSessionVideo(sessionId, videoPacket);
  }

  function forwardSessionVideo(sessionId, videoPacketInput) {
    const videoPacket = Buffer.from(videoPacketInput);
    const session = registry.getMutable(sessionId);
    if (session) rememberVideoBootstrap(sessionId, videoPacket);
    const browser = browserVideos.get(sessionId) || browsers.get(sessionId);
    if (!session || !browser || browser.readyState !== WebSocket.OPEN) return;
    const gate = browserVideoGates.get(sessionId) || createVideoBackpressureGate();
    browserVideoGates.set(sessionId, gate);
    const decision = gate.inspect(videoPacket, browser.bufferedAmount);
    metrics?.videoForwarded?.(sessionId, videoPacket.length, !decision.forward);
    if (!decision.forward) return;
    if (session.status !== "streaming") registry.update(sessionId, { status: "streaming", statusMessage: "实时画面已连接" });
    browser.send(videoPacket, { binary: true });
  }

  function rememberVideoBootstrap(sessionId, videoPacket) {
    if (videoPacket.length < 2) return;
    const current = videoBootstrapBySession.get(sessionId) || { configuration: null, keyframe: null };
    if (videoPacket[0] === 0) current.configuration = Buffer.from(videoPacket);
    if (videoPacket[0] === 1 && videoPacket[1] === 1) current.keyframe = Buffer.from(videoPacket);
    videoBootstrapBySession.set(sessionId, current);
  }

  function sendVideoBootstrap(sessionId, browser) {
    const bootstrap = videoBootstrapBySession.get(sessionId);
    if (!bootstrap || browser.readyState !== WebSocket.OPEN) return;
    if (bootstrap.configuration) browser.send(bootstrap.configuration, { binary: true });
    if (bootstrap.keyframe) browser.send(bootstrap.keyframe, { binary: true });
  }

  function start(session) {
    if (!agentOnline(session.agentId)) return false;
    const supportsSplit = agentCapabilities.get(session.agentId)?.transports?.includes("split-v1");
    const transportMode = supportsSplit ? "split-v1" : "multiplexed";
    const capabilities = agentCapabilities.get(session.agentId) || {};
    const quality = qualitySelector({
      requestedProfile: session.requestedQualityProfile || "auto",
      activeSessions: Math.max(0, registry.activeCount() - 1),
      bandwidthMbps,
      agentCapabilities: capabilities
    });
    if (session.mediaTransport === "direct_webrtc" && !capabilities.transports?.includes("webrtc-direct-v1")) {
      registry.update(session.sessionId, { status: "failed", statusMessage: "Windows 管理器尚未准备直连 WebRTC" });
      onSessionClosed(registry.get(session.sessionId), "direct_webrtc_unavailable");
      return false;
    }
    registry.update(session.sessionId, { agentConnected: true, transportMode, qualityProfile: quality.profile });
    const media = buildMediaStart(session);
    if (session.mediaTransport === "webrtc" && media.mode !== "webrtc") {
      registry.update(session.sessionId, { status: "failed", statusMessage: "WebRTC 媒体服务尚未就绪" });
      onSessionClosed(registry.get(session.sessionId), "media_unavailable");
      return false;
    }
    if (session.mediaTransport === "direct_webrtc" && media.mode !== "direct_webrtc") {
      registry.update(session.sessionId, { status: "failed", statusMessage: "WebRTC 媒体服务尚未就绪" });
      onSessionClosed(registry.get(session.sessionId), "media_unavailable");
      return false;
    }
    const sent = sendAgent(session.agentId, {
      type: "screen_start",
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      adbSerial: session.adbSerial,
      transportMode,
      options: quality,
      media
    });
    if (sent) {
      scheduleBrowserConnectTimeout(session.sessionId);
      metrics?.sessionStarted?.(session);
    }
    return sent;
  }

  function stop(sessionId, reason = "user_closed") {
    const session = registry.getMutable(sessionId);
    if (!session) return false;
    clearTimeout(browserDisconnectTimers.get(sessionId));
    browserDisconnectTimers.delete(sessionId);
    clearTimeout(browserConnectTimers.get(sessionId));
    browserConnectTimers.delete(sessionId);
    videoBootstrapBySession.delete(sessionId);
    browserVideoGates.delete(sessionId);
    closeDirectWebRtcPeer(sessionId, 1000, reason);
    closeAgentVideo(sessionId, 1000, reason);
    sendAgent(session.agentId, { type: "screen_stop", sessionId, reason });
    closeBrowser(sessionId, 1000, reason);
    registry.close(sessionId, "closed", "投屏已结束");
    metrics?.sessionClosed?.(sessionId, reason);
    onSessionClosed(registry.get(sessionId), reason);
    return true;
  }

  function sendAgent(agentId, message) {
    const ws = agents.get(agentId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  function agentOnline(agentId) {
    return agents.get(agentId)?.readyState === WebSocket.OPEN;
  }

  function sendBrowserStatus(sessionId, wireStatus = "") {
    const ws = browserControls.get(sessionId) || browsers.get(sessionId);
    const session = registry.get(sessionId);
    if (!ws || !session) return;
    sendJson(ws, {
      type: "status",
      status: wireStatus || (session.status === "streaming" ? "live" : session.status),
      detail: session.statusMessage,
      metadata: session.metadata
    });
    if (session.metadata?.codec) sendJson(ws, { type: "metadata", ...session.metadata });
  }

  function closeBrowser(sessionId, code, reason) {
    const sockets = [browsers.get(sessionId), browserControls.get(sessionId), browserVideos.get(sessionId)].filter(Boolean);
    browsers.delete(sessionId);
    browserControls.delete(sessionId);
    browserVideos.delete(sessionId);
    browserVideoGates.delete(sessionId);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
    }
  }

  function closeAgentVideo(sessionId, code, reason) {
    const ws = agentVideoPublishers.get(sessionId);
    if (!ws) return;
    agentVideoPublishers.delete(sessionId);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
  }

  function closeDirectWebRtcPeer(sessionId, code, reason) {
    const peer = directWebRtcPeers.get(sessionId);
    if (!peer) return;
    peer.closing = true;
    directWebRtcPeers.delete(sessionId);
    for (const ws of [peer.browser, peer.agent]) {
      if (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) ws.close(code, reason);
    }
  }

  function close() {
    clearInterval(heartbeatTimer);
    for (const timer of browserDisconnectTimers.values()) clearTimeout(timer);
    browserDisconnectTimers.clear();
    for (const timer of browserConnectTimers.values()) clearTimeout(timer);
    browserConnectTimers.clear();
    videoBootstrapBySession.clear();
    browserVideoGates.clear();
    directWebRtcPeers.clear();
    agentCapabilities.clear();
    for (const session of registry.sessions.values()) {
      if (["connecting", "ready", "streaming"].includes(session.status)) stop(session.sessionId, "server_shutdown");
    }
    wss.close();
  }

  return { agentOnline, close, start, stop };
}

function browserCredential(req, url) {
  const protocols = String(req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return protocols.find((item) => item.startsWith("pcs_")) || url.searchParams.get("token") || "";
}

function sanitizeDirectWebRtcSignal(input = {}) {
  const type = String(input?.type || "").trim().toLowerCase();
  if (!["offer", "answer", "candidate", "ice-complete", "error"].includes(type)) {
    throw new Error("invalid_direct_signal_type");
  }
  if (type === "offer" || type === "answer") {
    const sdp = String(input.sdp || "");
    if (!sdp || sdp.length > 256 * 1024) throw new Error("invalid_direct_signal_sdp");
    return { type, sdp };
  }
  if (type === "candidate") {
    const candidate = String(input.candidate || "");
    if (!candidate || candidate.length > 16 * 1024) throw new Error("invalid_direct_signal_candidate");
    return {
      type,
      candidate,
      sdpMid: input.sdpMid == null ? null : String(input.sdpMid).slice(0, 128),
      sdpMLineIndex: input.sdpMLineIndex == null ? null : Number(input.sdpMLineIndex)
    };
  }
  if (type === "error") return { type, message: String(input.message || "direct_webrtc_error").slice(0, 240) };
  return { type };
}

function tokenFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function sanitizeAgentStreamMetrics(input = {}) {
  return {
    fps: metricNumber(input.fps, 0, 240),
    ...(Number.isFinite(Number(input.capturedFps)) ? { capturedFps: metricNumber(input.capturedFps, 0, 240) } : {}),
    megabitsPerSecond: metricNumber(input.megabitsPerSecond, 0, 1_000),
    droppedFrames: metricNumber(input.droppedFrames, 0, 10_000_000),
    relayBufferedBytes: metricNumber(input.relayBufferedBytes, 0, 256 * 1024 * 1024),
    width: metricNumber(input.width, 0, 20_000),
    height: metricNumber(input.height, 0, 20_000)
  };
}

function sanitizeBrowserPlaybackMetrics(input = {}) {
  return {
    fps: metricNumber(input.fps, 0, 240),
    decoded: metricNumber(input.decoded, 0, 1_000_000_000),
    dropped: metricNumber(input.dropped, 0, 1_000_000_000),
    presented: metricNumber(input.presented, 0, 1_000_000_000),
    bufferSeconds: metricNumber(input.bufferSeconds, 0, 60),
    controlRttMs: metricNumber(input.controlRttMs, 0, 60_000),
    agentControlMs: metricNumber(input.agentControlMs, 0, 60_000),
    ...optionalPlaybackMetric(input, "rtcFramesDecoded", 0, 1_000_000_000),
    ...optionalPlaybackMetric(input, "rtcFramesDecodedDelta", 0, 1_000_000_000),
    ...optionalPlaybackMetric(input, "rtcFramesDropped", 0, 1_000_000_000),
    ...optionalPlaybackMetric(input, "rtcFramesPerSecond", 0, 240),
    ...optionalPlaybackMetric(input, "rtcPacketsLost", 0, 1_000_000_000),
    ...optionalPlaybackMetric(input, "rtcPacketsLostDelta", 0, 1_000_000_000),
    ...optionalPlaybackMetric(input, "rtcJitterMs", 0, 60_000),
    ...optionalPlaybackMetric(input, "rtcBytesReceived", 0, 1_000_000_000_000),
    ...optionalPlaybackMetric(input, "rtcBytesReceivedDelta", 0, 1_000_000_000_000),
    ...optionalPlaybackMetric(input, "rtcStatsWindowMs", 0, 60_000),
    ...optionalPlaybackMetric(input, "rtcReceiveMbps", 0, 1_000),
    ...optionalPlaybackMetric(input, "rtcDecodeMsPerFrame", 0, 60_000),
    ...optionalPlaybackMetric(input, "rtcFreezeCount", 0, 1_000_000),
    ...optionalPlaybackMetric(input, "rtcFreezeCountDelta", 0, 1_000_000),
    ...optionalPlaybackMetric(input, "rtcTotalFreezeMs", 0, 60_000_000),
    ...optionalPlaybackMetric(input, "rtcTotalFreezeMsDelta", 0, 60_000_000),
    ...optionalPlaybackEnum(input, "rtcIceProtocol", ["udp", "tcp"]),
    ...optionalPlaybackEnum(input, "rtcIceLocalType", ["host", "srflx", "prflx", "relay"]),
    ...optionalPlaybackEnum(input, "rtcIceRemoteType", ["host", "srflx", "prflx", "relay"]),
    ...optionalPlaybackEnum(input, "rtcIcePairState", ["frozen", "waiting", "in-progress", "failed", "succeeded"]),
    ...optionalPlaybackEnum(input, "pageVisibilityState", ["visible", "hidden", "prerender", "unknown"]),
    ...optionalPlaybackBoolean(input, "pageFocused"),
    ...optionalPlaybackBoolean(input, "videoInViewport"),
    ...optionalPlaybackBoolean(input, "playbackVisible")
  };
}

function optionalPlaybackMetric(input, key, min, max) {
  if (input[key] === undefined || input[key] === null) return {};
  return { [key]: metricNumber(input[key], min, max) };
}

function optionalPlaybackEnum(input, key, allowed) {
  if (input[key] === undefined || input[key] === null) return {};
  const value = String(input[key] || "").trim().toLowerCase();
  return allowed.includes(value) ? { [key]: value } : {};
}

function optionalPlaybackBoolean(input, key) {
  if (input[key] === undefined || input[key] === null) return {};
  return { [key]: Boolean(input[key]) };
}

function sanitizeBrowserPlaybackDiagnostic(input = {}) {
  return {
    event: String(input?.event || "unknown").slice(0, 64),
    connectionState: String(input?.connectionState || "").slice(0, 24),
    iceConnectionState: String(input?.iceConnectionState || "").slice(0, 24),
    signalingState: String(input?.signalingState || "").slice(0, 24),
    decoded: metricNumber(input?.decoded, 0, 1_000_000_000),
    presented: metricNumber(input?.presented, 0, 1_000_000_000),
    readyState: metricNumber(input?.readyState, 0, 4),
    paused: Boolean(input?.paused),
    videoWidth: metricNumber(input?.videoWidth, 0, 20_000),
    videoHeight: metricNumber(input?.videoHeight, 0, 20_000),
    sequenceId: metricNumber(input?.sequenceId, 0, Number.MAX_SAFE_INTEGER),
    action: String(input?.action || "").slice(0, 40),
    controlToPresentedMs: metricNumber(input?.controlToPresentedMs, 0, 60_000),
    acknowledgementToPresentedMs: metricNumber(input?.acknowledgementToPresentedMs, 0, 60_000),
    mediaTime: metricNumber(input?.mediaTime, 0, 60_000),
    presentedFrames: metricNumber(input?.presentedFrames, 0, 1_000_000_000),
    decodedDelta: metricNumber(input?.decodedDelta, 0, 1_000_000_000),
    bytesReceivedDelta: metricNumber(input?.bytesReceivedDelta, 0, 1_000_000_000_000),
    stalledForMs: metricNumber(input?.stalledForMs, 0, 60_000),
    pageVisibilityState: String(input?.pageVisibilityState || "unknown").slice(0, 16),
    pageFocused: Boolean(input?.pageFocused),
    videoInViewport: Boolean(input?.videoInViewport),
    playbackVisible: Boolean(input?.playbackVisible)
  };
}

function sanitizeScreenSourceFrameDiagnostic(input = {}) {
  return {
    event: String(input?.event || "captured_frame_after_input").slice(0, 64),
    sequenceId: metricNumber(input?.sequenceId, 0, Number.MAX_SAFE_INTEGER),
    action: String(input?.action || "").slice(0, 40),
    inputToAgentFrameMs: metricNumber(input?.inputToAgentFrameMs, 0, 60_000),
    sourcePtsMs: metricNumber(input?.sourcePtsMs, 0, 1_000_000_000),
    sourcePtsAdvanceMs: metricNumber(input?.sourcePtsAdvanceMs, 0, 60_000)
  };
}

function metricNumber(value, min, max) {
  const number = Number(value || 0);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : 0));
}

export function shouldThrottleControlMessage(control, rateCount) {
  return Number(rateCount || 0) > MAX_CONTROL_MESSAGES_PER_SECOND
    && control?.type === "touch"
    && control.action === "move";
}

function sendJson(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function sanitizeScreenMetadata(input = {}) {
  return {
    codec: typeof input.codec === "number" ? input.codec : String(input.codec || "h264").slice(0, 16),
    deviceName: String(input.deviceName || "").slice(0, 120),
    serial: String(input.serial || "").slice(0, 120),
    width: Math.max(0, Number(input.width || 0)),
    height: Math.max(0, Number(input.height || 0))
  };
}

export function validateControlMessage(message) {
  const sequenceId = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number(message?.sequenceId || 0))));
  if (message?.type === "key" && ["back", "home", "overview", "wakeup", "enter", "delete", "forward_delete", "select_all", "clear"].includes(message.key)) {
    return { type: "key", key: message.key, sequenceId };
  }
  if (message?.type === "text") {
    const text = typeof message.text === "string" ? message.text : "";
    if (!text.length || text.length > 1000 || text.includes("\0")) throw new Error("invalid_screen_text");
    return { type: "text", text, sequenceId };
  }
  if (message?.type === "touch" && ["down", "move", "up", "cancel"].includes(message.action)) {
    const number = (value, min, max) => Math.min(max, Math.max(min, Number(value || 0)));
    return {
      type: "touch",
      action: message.action,
      pointerId: number(message.pointerId, 0, 2_147_483_647),
      x: number(message.x, 0, 20_000),
      y: number(message.y, 0, 20_000),
      videoWidth: number(message.videoWidth, 1, 20_000),
      videoHeight: number(message.videoHeight, 1, 20_000),
      sequenceId
    };
  }
  throw new Error("invalid_screen_control");
}

export function sanitizeMediaReaderGeneration(value) {
  const generation = Math.round(Number(value || 0));
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 10_000) {
    throw new Error("invalid_screen_media_reader_generation");
  }
  return generation;
}

function sanitizeControlAcknowledgement(message) {
  const statuses = new Set(["injected", "coalesced", "failed"]);
  return {
    type: "screen_control_ack",
    sequenceId: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number(message.sequenceId || 0)))),
    status: statuses.has(message.status) ? message.status : "failed",
    action: String(message.action || "unknown").slice(0, 40),
    agentElapsedMs: Math.max(0, Math.min(60_000, Number(message.agentElapsedMs || 0)))
  };
}
