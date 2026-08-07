import { spawn as defaultSpawn } from "node:child_process";

// Direct WebRTC needs to finish ICE connectivity before the publisher can
// print READY. Keep this outside the 12s peer-connection timeout used by the
// Go publisher so a valid cross-network handshake is not killed early.
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const WHIP_FRAME_HEADER_BYTES = 13;

export function buildWhipPublisherArgs(publishUrl, { profileLevelId = "42e01f", pacingBitRate = 12_000_000, statsIntervalMs = 0, queueLatencyMs = 400 } = {}) {
  if (!/^https?:\/\//i.test(String(publishUrl || ""))) throw new Error("invalid_whip_publish_url");
  const normalizedProfile = normalizeH264ProfileLevelId(profileLevelId);
  const boundedPacingBitRate = Math.max(2_000_000, Math.min(48_000_000, Math.round(Number(pacingBitRate) || 12_000_000)));
  const args = [
    "--whip-url", String(publishUrl),
    "--profile-level-id", normalizedProfile,
    "--pacing-bitrate", String(boundedPacingBitRate),
    "--queue-latency", `${Math.max(100, Math.min(1_500, Math.round(Number(queueLatencyMs) || 400)))}ms`
  ];
  const boundedStatsIntervalMs = Math.max(0, Math.min(60_000, Math.round(Number(statsIntervalMs) || 0)));
  if (boundedStatsIntervalMs > 0) args.push("--stats-interval", `${boundedStatsIntervalMs}ms`);
  return args;
}

export function buildDirectWebRtcPublisherArgs(signalUrl, agentToken, { profileLevelId = "42e01f", iceServers = [] } = {}) {
  if (!/^wss?:\/\//i.test(String(signalUrl || ""))) throw new Error("invalid_direct_webrtc_signal_url");
  if (!String(agentToken || "").trim()) throw new Error("direct_webrtc_agent_token_required");
  const normalizedProfile = normalizeH264ProfileLevelId(profileLevelId);
  return [
    "--signal-url", String(signalUrl),
    "--signal-token", String(agentToken),
    "--profile-level-id", normalizedProfile,
    "--ice-servers", JSON.stringify(Array.isArray(iceServers) ? iceServers : [])
  ];
}

export function h264ProfileLevelId(packet) {
  const data = Buffer.from(packet?.data || packet || []);
  for (let offset = 0; offset + 4 < data.length; offset += 1) {
    const startCodeLength = data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1
      ? 3
      : data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 0 && data[offset + 3] === 1
        ? 4
        : 0;
    if (!startCodeLength) continue;
    const naluOffset = offset + startCodeLength;
    if ((data[naluOffset] & 0x1f) !== 7 || naluOffset + 3 >= data.length) continue;
    return Buffer.from(data.subarray(naluOffset + 1, naluOffset + 4)).toString("hex");
  }
  return "";
}

export function buildFfmpegWebRtcPublishArgs(publishUrl, { frameRate = 30 } = {}) {
  if (!/^rtsp:\/\//i.test(String(publishUrl || ""))) throw new Error("invalid_webrtc_publish_url");
  const inputFrameRate = Math.max(5, Math.min(60, Math.round(Number(frameRate) || 30)));
  return [
    "-hide_banner",
    "-loglevel", "warning",
    // Do not use `nobuffer` here. With a raw H.264 stdin it can discard the
    // SPS/PPS + first IDR while FFmpeg probes the input, leaving RTSP with no
    // decodable frames for the lifetime of the screen session.
    "-fflags", "+genpts",
    "-flags", "low_delay",
    // A full megabyte probe delayed first publish by ~20 seconds on an idle
    // phone. 64 KiB keeps the SPS/PPS and first IDR together without waiting
    // for an arbitrary amount of later video data.
    "-analyzeduration", "100000",
    "-probesize", "65536",
    "-f", "h264",
    "-r", String(inputFrameRate),
    "-i", "pipe:0",
    "-map", "0:v:0",
    "-c:v", "copy",
    "-an",
    "-rtsp_transport", "tcp",
    "-muxdelay", "0",
    "-muxpreload", "0",
    "-f", "rtsp",
    publishUrl
  ];
}

export function createScreenWebRtcPublisher({
  ffmpegPath,
  whipPublisherPath,
  mode = "rtsp",
  publishUrl,
  h264ProfileLevelId: profileLevelId,
  frameRate = 30,
  pacingBitRate = 24_000_000,
  queueLatencyMs = 400,
  statsIntervalMs = 0,
  onLog = () => {},
  onKeyframeRequest = () => {},
  onResyncRequired = () => {},
  onMediaReady = () => {},
  agentToken = "",
  iceServers = [],
  spawn = defaultSpawn,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS
} = {}) {
  if (mode === "whip") {
    return createWhipScreenWebRtcPublisher({
      publisherPath: whipPublisherPath,
      publishUrl,
      profileLevelId,
      pacingBitRate,
      queueLatencyMs,
      statsIntervalMs,
      onLog,
      onKeyframeRequest,
      onResyncRequired,
      onMediaReady,
      spawn,
      startTimeoutMs,
      stopTimeoutMs
    });
  }
  if (mode === "direct_webrtc") {
    return createDirectWebRtcScreenPublisher({
      publisherPath: whipPublisherPath,
      signalUrl: publishUrl,
      agentToken,
      iceServers,
      profileLevelId,
      onLog,
      onKeyframeRequest,
      spawn,
      startTimeoutMs,
      stopTimeoutMs
    });
  }
  let child = null;
  let started = false;
  let closed = false;
  let stderr = "";
  let startup = null;

  const start = async () => {
    if (started) return;
    if (closed) throw new Error("webrtc_publisher_closed");
    const args = buildFfmpegWebRtcPublishArgs(publishUrl, { frameRate });
    child = spawn(String(ffmpegPath || ""), args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    startup = waitForStart(child, startTimeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-8_000);
      const text = stderr.trim();
      if (text) onLog({ type: "ffmpeg", detail: text.split(/\r?\n/).at(-1) });
    });
    child.once("exit", (code, signal) => {
      started = false;
      if (!closed) onLog({ type: "ffmpeg_exit", code, signal, detail: stderr.slice(-1_000) });
    });
    await startup;
    started = true;
  };

  const write = async (packet) => {
    if (!started || closed || !child?.stdin?.writable) throw new Error("webrtc_publisher_not_writable");
    const data = Buffer.from(packet?.data || packet || []);
    if (!data.byteLength) return;
    if (child.stdin.write(data)) return;
    await onceDrain(child.stdin);
  };

  const stop = async () => {
    if (closed) return;
    closed = true;
    const current = child;
    child = null;
    if (!current) return;
    try { current.stdin?.end(); } catch {}
    await waitForExit(current, stopTimeoutMs);
    if (current.exitCode === null && !current.killed) current.kill();
  };

  return {
    start,
    write,
    stop,
    get bufferedBytes() {
      return Math.max(0, Number(child?.stdin?.writableLength || 0));
    },
    get running() {
      return Boolean(started && !closed && child && child.exitCode === null);
    }
  };
}

function createDirectWebRtcScreenPublisher({
  publisherPath,
  signalUrl,
  agentToken,
  iceServers,
  profileLevelId,
  onLog = () => {},
  onKeyframeRequest = () => {},
  spawn = defaultSpawn,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS
} = {}) {
  let child = null;
  let started = false;
  let closed = false;
  let stderr = "";
  let stdout = "";

  const start = async () => {
    if (started) return;
    if (closed) throw new Error("webrtc_publisher_closed");
    const args = buildDirectWebRtcPublisherArgs(signalUrl, agentToken, { profileLevelId, iceServers });
    child = spawn(String(publisherPath || ""), args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-8_000);
      const detail = stderr.trim().split(/\r?\n/).at(-1);
      if (detail) onLog({ type: "direct_webrtc", detail });
    });
    child.stdout?.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines.filter(Boolean)) {
        const keyframeRequest = line.match(/^KEYFRAME_REQUEST:(pli|fir)$/i);
        if (keyframeRequest) {
          onKeyframeRequest(keyframeRequest[1].toLowerCase());
          continue;
        }
        onLog({ type: "direct_webrtc", detail: line });
      }
    });
    child.once("exit", (code, signal) => {
      started = false;
      if (!closed) onLog({ type: "direct_webrtc_exit", code, signal, detail: stderr.slice(-1_000) });
    });
    await waitForWhipStart(child, startTimeoutMs);
    started = true;
  };

  const write = async (packet) => {
    if (!started || closed || !child?.stdin?.writable) throw new Error("webrtc_publisher_not_writable");
    const framed = encodeWhipFrame(packet);
    if (!framed) return;
    if (child.stdin.write(framed)) return;
    await onceDrain(child.stdin);
  };

  const stop = async () => {
    if (closed) return;
    closed = true;
    const current = child;
    child = null;
    if (!current) return;
    try { current.stdin?.end(); } catch {}
    await waitForExit(current, stopTimeoutMs);
    if (current.exitCode === null && !current.killed) current.kill();
  };

  return {
    start,
    write,
    stop,
    get bufferedBytes() { return Math.max(0, Number(child?.stdin?.writableLength || 0)); },
    get running() { return Boolean(started && !closed && child && child.exitCode === null); }
  };
}

function createWhipScreenWebRtcPublisher({
  publisherPath,
  publishUrl,
  profileLevelId,
  pacingBitRate,
  queueLatencyMs,
  statsIntervalMs = 0,
  onLog = () => {},
  onKeyframeRequest = () => {},
  onResyncRequired = () => {},
  onMediaReady = () => {},
  spawn = defaultSpawn,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS
} = {}) {
  let child = null;
  let started = false;
  let closed = false;
  let stderr = "";
  let stdout = "";

  const start = async () => {
    if (started) return;
    if (closed) throw new Error("webrtc_publisher_closed");
    const args = buildWhipPublisherArgs(publishUrl, { profileLevelId, pacingBitRate, statsIntervalMs, queueLatencyMs });
    child = spawn(String(publisherPath || ""), args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-8_000);
      const detail = stderr.trim().split(/\r?\n/).at(-1);
      if (detail) onLog({ type: "whip", detail });
    });
    child.stdout?.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines.filter(Boolean)) {
        const keyframeRequest = line.match(/^KEYFRAME_REQUEST:(pli|fir)$/i);
        if (keyframeRequest) {
          onKeyframeRequest(keyframeRequest[1].toLowerCase());
          continue;
        }
        if (line === "RESYNC_REQUIRED") {
          onResyncRequired();
          continue;
        }
        if (line === "KEYFRAME_SENT") {
          onMediaReady();
          continue;
        }
        onLog({ type: "whip", detail: line });
      }
    });
    child.once("exit", (code, signal) => {
      started = false;
      if (!closed) onLog({ type: "whip_exit", code, signal, detail: stderr.slice(-1_000) });
    });
    await waitForWhipStart(child, startTimeoutMs);
    started = true;
  };

  const write = async (packet) => {
    if (!started || closed || !child?.stdin?.writable) throw new Error("webrtc_publisher_not_writable");
    const framed = encodeWhipFrame(packet);
    if (!framed) return;
    if (child.stdin.write(framed)) return;
    await onceDrain(child.stdin);
  };

  const stop = async () => {
    if (closed) return;
    closed = true;
    const current = child;
    child = null;
    if (!current) return;
    try { current.stdin?.end(); } catch {}
    await waitForExit(current, stopTimeoutMs);
    if (current.exitCode === null && !current.killed) current.kill();
  };

  return {
    start,
    write,
    stop,
    get bufferedBytes() { return Math.max(0, Number(child?.stdin?.writableLength || 0)); },
    get running() { return Boolean(started && !closed && child && child.exitCode === null); }
  };
}

function normalizeH264ProfileLevelId(value) {
  const profile = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{6}$/.test(profile) ? profile : "42e01f";
}

export function encodeWhipFrame(packet) {
  const data = Buffer.from(packet?.data || packet || []);
  if (!data.byteLength) return null;
  const header = Buffer.allocUnsafe(WHIP_FRAME_HEADER_BYTES);
  header[0] = packet?.type === "configuration" ? 0 : packet?.keyframe ? 2 : 1;
  const pts = typeof packet?.pts === "bigint" ? packet.pts : BigInt(Math.max(0, Math.round(Number(packet?.pts || 0))));
  header.writeBigInt64BE(pts, 1);
  header.writeUInt32BE(data.byteLength, 9);
  return Buffer.concat([header, data]);
}

function waitForStart(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("webrtc_publisher_start_timeout")), Math.max(1_000, Number(timeoutMs || DEFAULT_START_TIMEOUT_MS)));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("error", onError);
      child.off?.("spawn", onSpawn);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onSpawn = () => finish();
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

function waitForWhipStart(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const timer = setTimeout(() => finish(new Error("whip_publisher_start_timeout")), Math.max(1_000, Number(timeoutMs || DEFAULT_START_TIMEOUT_MS)));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("error", onError);
      child.off?.("exit", onExit);
      child.stdout?.off?.("data", onData);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = () => finish(new Error("whip_publisher_exited_before_ready"));
    const onData = (chunk) => {
      output = `${output}${Buffer.from(chunk).toString("utf8")}`.slice(-2_000);
      if (/^READY$/m.test(output)) finish();
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.on?.("data", onData);
  });
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    const onDrain = () => finish();
    const onError = (error) => finish(error);
    const finish = (error) => {
      stream.off?.("drain", onDrain);
      stream.off?.("error", onError);
      if (error) reject(error);
      else resolve();
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(100, Number(timeoutMs || DEFAULT_STOP_TIMEOUT_MS)));
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
