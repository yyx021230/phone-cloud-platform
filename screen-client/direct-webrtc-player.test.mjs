import assert from "node:assert/strict";
import test from "node:test";
import { DirectWebRtcScreenPlayer } from "./direct-webrtc-player.js";

const ANSWER_SDP = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 102 103",
  "a=rtpmap:102 H264/90000",
  "a=rtcp-fb:102 nack",
  "a=rtcp-fb:102 nack pli",
  "a=rtpmap:103 rtx/90000",
  "a=fmtp:103 apt=102",
  ""
].join("\r\n");

test("direct WebRTC reports negotiated RTX/NACK and the selected TURN path", async () => {
  class FakeSocket {
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name) { this.listeners.delete(name); }
    send() {
      queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ type: "answer", sdp: ANSWER_SDP }) }));
    }
    close() {}
  }
  class FakePeerConnection {
    constructor(options) {
      this.options = options;
      this.connectionState = "connected";
      this.iceConnectionState = "connected";
      this.iceGatheringState = "complete";
      this.localDescription = { sdp: "offer" };
    }
    addTransceiver() {}
    async createOffer() { return { sdp: "offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async getStats() {
      return new Map([
        ["codec", { id: "codec", type: "codec", mimeType: "video/H264" }],
        ["inbound", {
          id: "inbound", type: "inbound-rtp", kind: "video", codecId: "codec", transportId: "transport",
          bytesReceived: 10_000, packetsReceived: 100, packetsLost: 1, framesDecoded: 10,
          nackCount: 1, retransmittedPacketsReceived: 1
        }],
        ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
        ["pair", { id: "pair", type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.02 }],
        ["local", { id: "local", type: "local-candidate", candidateType: "relay", protocol: "udp" }],
        ["remote", { id: "remote", type: "remote-candidate", candidateType: "relay", protocol: "udp" }]
      ]);
    }
    close() {}
  }
  const stats = [];
  const video = {
    addEventListener() {},
    removeEventListener() {},
    getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; }
  };
  const player = new DirectWebRtcScreenPlayer({
    video,
    RTCPeerConnectionCtor: FakePeerConnection,
    WebSocketCtor: FakeSocket,
    onStats: (value) => stats.push(value),
    setRepeatingTimer: () => 1,
    clearRepeatingTimer() {}
  });

  await player.start({
    signalUrl: "wss://example.test/direct-webrtc",
    token: "browser-token",
    iceServers: [{ urls: "turn:relay.example.test:3478", username: "user", credential: "credential" }]
  });
  await player.monitorPlayback();
  const metrics = stats.find((value) => value.decoderBackend === "direct_webrtc");
  assert.equal(metrics.rtcNegotiatedNack, true);
  assert.equal(metrics.rtcNegotiatedRtx, true);
  assert.equal(metrics.rtcIceLocalType, "relay");
  assert.equal(metrics.rtcIceRemoteType, "relay");
  assert.equal(metrics.rtcIceCurrentRttMs, 20);
  assert.deepEqual(player.pc.options.iceServers, [{ urls: "turn:relay.example.test:3478", username: "user", credential: "credential" }]);
  player.stop();
});
