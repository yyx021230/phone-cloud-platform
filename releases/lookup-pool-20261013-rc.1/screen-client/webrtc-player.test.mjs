import assert from "node:assert/strict";
import test from "node:test";
import { WhepScreenPlayer, buildWhepRequestHeaders, extractInboundVideoMetrics, readPlaybackVisibility, requestWhepAnswer, resolveWhepResourceUrl, summarizeWhepNegotiation, waitForIceGathering } from "./webrtc-player.js";

test("builds a bearer authenticated WHEP request", () => {
  assert.deepEqual(buildWhepRequestHeaders("token-1"), {
    "content-type": "application/sdp",
    authorization: "Bearer token-1"
  });
});

test("resolves a WHEP resource location against the original endpoint", () => {
  assert.equal(resolveWhepResourceUrl("http://example.test/pc/a/whep", "/session/123"), "http://example.test/session/123");
  assert.equal(resolveWhepResourceUrl("http://example.test/pc/a/whep", ""), "");
});

test("keeps a reverse proxy WHEP prefix when resolving the MediaMTX resource", () => {
  assert.equal(
    resolveWhepResourceUrl("https://cloud.example.test/webrtc/pc/slot-1/whep", "/pc/slot-1/whep/session-1"),
    "https://cloud.example.test/webrtc/pc/slot-1/whep/session-1"
  );
});

test("marks playback visible only when the page is focused and the video intersects the viewport", () => {
  const video = {
    hidden: false,
    getBoundingClientRect() { return { left: 10, top: 20, right: 210, bottom: 420, width: 200, height: 400 }; }
  };
  assert.deepEqual(readPlaybackVisibility(video, {
    documentRef: { visibilityState: "visible", hasFocus: () => true },
    viewportWidth: 800,
    viewportHeight: 600
  }), {
    pageVisibilityState: "visible",
    pageFocused: true,
    videoInViewport: true,
    playbackVisible: true
  });
  assert.equal(readPlaybackVisibility(video, {
    documentRef: { visibilityState: "hidden", hasFocus: () => false },
    viewportWidth: 800,
    viewportHeight: 600
  }).playbackVisible, false);
});

test("reports decoded-but-not-presented stalls only for visible playback", () => {
  let currentTime = 1_000;
  const diagnostics = [];
  const player = new WhepScreenPlayer({
    video: {},
    RTCPeerConnectionCtor: class {},
    fetchFn: async () => new Response(),
    now: () => currentTime,
    getPlaybackVisibility: () => ({ pageVisibilityState: "visible", pageFocused: true, videoInViewport: true, playbackVisible: true }),
    onStats: (stats) => { if (stats.diagnostic) diagnostics.push(stats.diagnostic); }
  });
  player.started = true;
  player.hasFirstFrame = true;
  player.presentedFrames = 10;
  const visible = player.playbackVisibility();
  player.observePresentationProgress({ at: currentTime, rtcFramesDecoded: 100, rtcFramesDecodedDelta: 10, rtcBytesReceivedDelta: 10_000 }, visible);
  currentTime = 2_500;
  player.observePresentationProgress({ at: currentTime, rtcFramesDecoded: 110, rtcFramesDecodedDelta: 10, rtcBytesReceivedDelta: 10_000 }, visible);
  currentTime = 4_000;
  player.observePresentationProgress({ at: currentTime, rtcFramesDecoded: 120, rtcFramesDecodedDelta: 10, rtcBytesReceivedDelta: 10_000 }, visible);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].event, "visible_presentation_stall");

  currentTime = 5_000;
  const hidden = { ...visible, pageVisibilityState: "hidden", playbackVisible: false };
  player.observePresentationProgress({ at: currentTime, rtcFramesDecoded: 120, rtcFramesDecodedDelta: 10, rtcBytesReceivedDelta: 10_000 }, hidden);
  assert.equal(player.presentationWatchdog.stalledSince, 0);
});

test("waits for the publisher when MediaMTX reports no stream yet", async () => {
  let calls = 0;
  const response = await requestWhepAnswer({
    fetchFn: async () => {
      calls += 1;
      return new Response(calls === 1 ? "not ready" : "answer", { status: calls === 1 ? 404 : 201 });
    },
    whepUrl: "http://example.test/webrtc/pc/a/whep",
    token: "token-1",
    sdp: "offer",
    availabilityTimeoutMs: 1_000,
    retryDelayMs: 0,
    sleepFn: async () => {},
    now: () => 0
  });
  assert.equal(calls, 2);
  assert.equal(response.status, 201);
});

test("bounds WHEP availability retries instead of creating a session storm", async () => {
  let calls = 0;
  let currentTime = 0;
  const waits = [];
  const response = await requestWhepAnswer({
    fetchFn: async () => {
      calls += 1;
      return new Response("not ready", { status: 404 });
    },
    whepUrl: "http://example.test/webrtc/pc/a/whep",
    token: "token-1",
    sdp: "offer",
    availabilityTimeoutMs: 1_000,
    retryDelayMs: 100,
    maxRetryDelayMs: 250,
    retryBackoffMultiplier: 2,
    maxAttempts: 3,
    sleepFn: async (delay) => { waits.push(delay); currentTime += delay; },
    now: () => currentTime
  });
  assert.equal(response.status, 404);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
});

test("uses a short bounded WHEP availability retry during cold start", async () => {
  const source = WhepScreenPlayer.prototype.start.toString();
  assert.match(source, /retryDelayMs:\s*150/);
  assert.match(source, /maxRetryDelayMs:\s*250/);
  assert.match(source, /retryBackoffMultiplier:\s*1\.35/);
  assert.match(source, /maxAttempts:\s*3/);
});

test("does not fail playback immediately when ICE briefly reports disconnected", async () => {
  const delayed = [];
  const cleared = [];
  const errors = [];
  let readersReady = 0;
  class FakePeerConnection {
    constructor() {
      this.connectionState = "new";
      this.iceConnectionState = "new";
      this.signalingState = "stable";
      this.iceGatheringState = "complete";
    }
    addTransceiver() {}
    async createOffer() { return { sdp: "offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }
  const video = {
    addEventListener() {},
    removeEventListener() {},
    getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; }
  };
  const player = new WhepScreenPlayer({
    video,
    RTCPeerConnectionCtor: FakePeerConnection,
    fetchFn: async () => new Response("answer", { status: 201, headers: { location: "/session/1" } }),
    onReaderReady: () => { readersReady += 1; },
    onError: (error) => errors.push(error.message),
    setRepeatingTimer: () => 1,
    clearRepeatingTimer() {},
    setDelayTimer: (callback, delay) => { delayed.push({ callback, delay }); return 7; },
    clearDelayTimer: (id) => cleared.push(id)
  });

  await player.start({ whepUrl: "http://example.test/webrtc/pc/a/whep", token: "token" });
  assert.equal(readersReady, 0);
  player.pc.iceConnectionState = "connected";
  player.pc.oniceconnectionstatechange();
  assert.equal(readersReady, 1);
  player.pc.connectionState = "disconnected";
  player.pc.onconnectionstatechange();
  assert.deepEqual(errors, []);
  assert.equal(delayed.length, 1);
  assert.equal(delayed[0].delay, 8_000);

  player.pc.connectionState = "connected";
  player.pc.onconnectionstatechange();
  assert.equal(readersReady, 1);
  assert.deepEqual(cleared, [7]);
  delayed[0].callback();
  assert.deepEqual(errors, []);
});

test("recreates the WHEP reader up to three times after a sustained disconnect", async () => {
  const delayed = [];
  const errors = [];
  class FakePeerConnection {
    constructor() {
      this.connectionState = "new";
      this.iceConnectionState = "new";
      this.signalingState = "stable";
      this.iceGatheringState = "complete";
    }
    addTransceiver() {}
    async createOffer() { return { sdp: "offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }
  const video = {
    addEventListener() {},
    removeEventListener() {},
    getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; }
  };
  const player = new WhepScreenPlayer({
    video,
    RTCPeerConnectionCtor: FakePeerConnection,
    fetchFn: async () => new Response("answer", { status: 201, headers: { location: "/session/1" } }),
    onError: (error) => errors.push(error.message),
    setRepeatingTimer: () => 1,
    clearRepeatingTimer() {},
    setDelayTimer: (callback, delay) => { delayed.push({ callback, delay }); return delayed.length; },
    clearDelayTimer() {}
  });

  await player.start({ whepUrl: "http://example.test/webrtc/pc/a/whep", token: "token" });
  for (const expectedDelay of [300, 800, 1_500]) {
    player.retryDisconnectedPeerConnection();
    assert.equal(delayed.at(-1).delay, expectedDelay);
    delayed.at(-1).callback();
    await Promise.resolve();
  }
  player.retryDisconnectedPeerConnection();
  assert.deepEqual(errors, ["WebRTC 连接持续中断（已自动重连 3 次）"]);
});

test("handles a synchronous ICE completion event without a temporal dead zone error", async () => {
  let removed = false;
  const pc = {
    iceGatheringState: "gathering",
    addEventListener(_name, listener) {
      this.iceGatheringState = "complete";
      listener();
    },
    removeEventListener() {
      removed = true;
    }
  };
  await waitForIceGathering(pc, 25);
  assert.equal(removed, true);
});

test("extracts inbound WebRTC video metrics without depending on browser-specific fields", () => {
  const reports = new Map([["codec-primary", { type: "codec", mimeType: "video/H264" }], ["inbound", {
    type: "inbound-rtp",
    kind: "video",
    bytesReceived: 125_000,
    framesDecoded: 60,
    framesDropped: 2,
    framesPerSecond: 30,
    packetsLost: 4,
    packetsReceived: 1_000,
    jitter: 0.012,
    totalDecodeTime: 0.3,
    freezeCount: 1,
    totalFreezesDuration: 0.2,
    nackCount: 8,
    pliCount: 2,
    firCount: 1,
    retransmittedPacketsReceived: 6,
    retransmittedBytesReceived: 7_200,
    packetsDiscarded: 3,
    jitterBufferDelay: 1.2,
    jitterBufferTargetDelay: 0.9,
    jitterBufferEmittedCount: 60,
    codecId: "codec-primary"
  }]]);
  const metrics = extractInboundVideoMetrics(reports, { at: 2_000, previous: { at: 1_000, rtcInboundReportId: "inbound", rtcBytesReceived: 25_000, rtcPacketsLost: 1, rtcPacketsReceived: 800, rtcFramesDecoded: 35, rtcFreezeCount: 0, rtcTotalFreezeMs: 0, rtcNackCount: 3, rtcPliCount: 1, rtcFirCount: 0, rtcRetransmittedPacketsReceived: 2, rtcRetransmittedBytesReceived: 2_400, rtcPacketsDiscarded: 1 } });
  assert.deepEqual(metrics, {
    at: 2_000,
    rtcInboundReportId: "inbound",
    rtcStatsWindowMs: 1000,
    rtcFramesDecoded: 60,
    rtcFramesDecodedDelta: 25,
    rtcFramesDropped: 2,
    rtcFramesPerSecond: 30,
    rtcPacketsLost: 4,
    rtcPacketsLostDelta: 3,
    rtcPacketsReceived: 1_000,
    rtcPacketsReceivedDelta: 200,
    rtcJitterMs: 12,
    rtcBytesReceived: 125_000,
    rtcBytesReceivedDelta: 100_000,
    rtcReceiveMbps: 0.8,
    rtcDecodeMsPerFrame: 5,
    rtcFreezeCount: 1,
    rtcFreezeCountDelta: 1,
    rtcTotalFreezeMs: 200,
    rtcTotalFreezeMsDelta: 200,
    rtcNackCount: 8,
    rtcNackCountDelta: 5,
    rtcPliCount: 2,
    rtcPliCountDelta: 1,
    rtcFirCount: 1,
    rtcFirCountDelta: 1,
    rtcRetransmittedPacketsReceived: 6,
    rtcRetransmittedPacketsReceivedDelta: 4,
    rtcRetransmittedBytesReceived: 7_200,
    rtcRetransmittedBytesReceivedDelta: 4_800,
    rtcPacketsDiscarded: 3,
    rtcPacketsDiscardedDelta: 2,
    rtcJitterBufferDelayMsPerFrame: 20,
    rtcJitterBufferTargetDelayMsPerFrame: 15,
    rtcJitterBufferDelaySeconds: 1.2,
    rtcJitterBufferTargetDelaySeconds: 0.9,
    rtcJitterBufferEmittedCount: 60
  });
});

test("sticks to the primary inbound stream instead of switching to the RTX report", () => {
  const reports = new Map([
    ["codec-rtx", { type: "codec", mimeType: "video/rtx" }],
    ["codec-primary", { type: "codec", mimeType: "video/H264" }],
    ["rtx", { type: "inbound-rtp", kind: "video", bytesReceived: 900, packetsLost: 90, codecId: "codec-rtx" }],
    ["primary", { type: "inbound-rtp", kind: "video", bytesReceived: 300, packetsLost: 3, codecId: "codec-primary" }]
  ]);
  const metrics = extractInboundVideoMetrics(reports, { at: 2_000, previous: { at: 1_000, rtcInboundReportId: "primary", rtcBytesReceived: 100, rtcPacketsLost: 2 } });
  assert.equal(metrics.rtcInboundReportId, "primary");
  assert.equal(metrics.rtcPacketsLostDelta, 1);
  assert.equal(metrics.rtcBytesReceivedDelta, 200);
});

test("reports the selected ICE path without exposing endpoint addresses", () => {
  const reports = new Map([
    ["codec", { type: "codec", mimeType: "video/H264" }],
    ["inbound", { type: "inbound-rtp", kind: "video", bytesReceived: 100, codecId: "codec", transportId: "transport" }],
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.243, availableIncomingBitrate: 4_500_000 }],
    ["local", { type: "local-candidate", protocol: "udp", candidateType: "host", address: "192.168.1.10" }],
    ["remote", { type: "remote-candidate", candidateType: "srflx", address: "203.0.113.1" }]
  ]);
  const metrics = extractInboundVideoMetrics(reports, { at: 1_000 });
  assert.equal(metrics.rtcIceProtocol, "udp");
  assert.equal(metrics.rtcIceLocalType, "host");
  assert.equal(metrics.rtcIceRemoteType, "srflx");
  assert.equal(metrics.rtcIcePairState, "succeeded");
  assert.equal(metrics.rtcIceCurrentRttMs, 243);
  assert.equal(metrics.rtcIceAvailableIncomingBitrate, 4_500_000);
  assert.equal("address" in metrics, false);
});

test("summarizes WHEP H264 repair negotiation from the answer SDP", () => {
  const summary = summarizeWhepNegotiation([
    "m=video 9 UDP/TLS/RTP/SAVPF 102 103",
    "a=rtpmap:102 H264/90000",
    "a=rtcp-fb:102 nack",
    "a=rtcp-fb:102 nack pli",
    "a=rtcp-fb:102 ccm fir",
    "a=rtpmap:103 rtx/90000",
    "a=fmtp:103 apt=102"
  ].join("\r\n"));
  assert.deepEqual(summary, {
    rtcNegotiatedNack: true,
    rtcNegotiatedPli: true,
    rtcNegotiatedFir: true,
    rtcNegotiatedRtx: true
  });
});
