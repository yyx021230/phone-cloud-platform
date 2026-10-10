import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { buildDirectWebRtcPublisherArgs, buildFfmpegWebRtcPublishArgs, buildWhipPublisherArgs, createScreenWebRtcPublisher, encodeWhipFrame, h264ProfileLevelId } from "./screen-webrtc-publisher.mjs";

test("builds a direct WebRTC signaling command without a MediaMTX URL", () => {
  assert.deepEqual(
    buildDirectWebRtcPublisherArgs("wss://cloud.example/realtime/v1/sessions/s-1/direct-webrtc?role=agent&agentId=a-1", "agent-token", {
      profileLevelId: "640029",
      iceServers: [{ urls: "stun:stun.example" }]
    }),
    [
      "--signal-url", "wss://cloud.example/realtime/v1/sessions/s-1/direct-webrtc?role=agent&agentId=a-1",
      "--signal-token", "agent-token",
      "--profile-level-id", "640029",
      "--ice-servers", JSON.stringify([{ urls: "stun:stun.example" }])
    ]
  );
});

test("builds a no-reencode FFmpeg RTSP publisher command", () => {
  const args = buildFfmpegWebRtcPublishArgs("rtsp://example.test:8554/pc/a?token=x", { frameRate: 24 });
  assert.equal(args.includes("copy"), true);
  assert.equal(args.includes("low_delay"), true);
  assert.equal(args.at(args.indexOf("-r") + 1), "24");
  assert.equal(args.at(-1), "rtsp://example.test:8554/pc/a?token=x");
  assert.throws(() => buildFfmpegWebRtcPublishArgs("http://example.test"), /invalid_webrtc_publish_url/);
});

test("frames scrcpy H264 packets with their original PTS for WHIP", () => {
  assert.deepEqual(buildWhipPublisherArgs("http://example.test/webrtc/pc/slot-1/whip?token=x", { profileLevelId: "640029" }), ["--whip-url", "http://example.test/webrtc/pc/slot-1/whip?token=x", "--profile-level-id", "640029", "--pacing-bitrate", "12000000", "--max-packets-per-burst", "2", "--queue-latency", "400ms"]);
  const frame = encodeWhipFrame({ type: "data", pts: 1_234_567n, data: new Uint8Array([1, 2, 3]) });
  assert.equal(frame[0], 1);
  assert.equal(frame.readBigInt64BE(1), 1_234_567n);
  assert.equal(frame.readUInt32BE(9), 3);
  assert.deepEqual([...frame.subarray(13)], [1, 2, 3]);
  const keyframe = encodeWhipFrame({ type: "data", keyframe: true, pts: 1_234_568n, data: new Uint8Array([4]) });
  assert.equal(keyframe[0], 2);
  assert.throws(() => buildWhipPublisherArgs("rtsp://example.test/live"), /invalid_whip_publish_url/);
});

test("forwards PLI and FIR feedback from the WHIP publisher", async () => {
  const requests = [];
  let mediaReady = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.writableLength = 0;
  child.stdin.write = () => true;
  child.stdin.end = () => { child.exitCode = 0; child.emit("exit", 0, null); };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const publisher = createScreenWebRtcPublisher({
    mode: "whip",
    whipPublisherPath: "publisher.exe",
    publishUrl: "http://example.test/webrtc/pc/slot-1/whip?token=x",
    spawn: () => {
      queueMicrotask(() => child.stdout.emit("data", Buffer.from("READY\nKEYFRAME_REQUEST:pli\nKEYFRAME_REQUEST:fir\nKEYFRAME_SENT\n")));
      return child;
    },
    onKeyframeRequest: (reason) => requests.push(reason),
    onMediaReady: () => { mediaReady += 1; }
  });
  await publisher.start();
  assert.deepEqual(requests, ["pli", "fir"]);
  assert.equal(mediaReady, 1);
  await publisher.stop();
});

test("starts the direct WebRTC publisher through the Pion signaling process", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.writableLength = 0;
  child.stdin.write = () => true;
  child.stdin.end = () => { child.exitCode = 0; child.emit("exit", 0, null); };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const calls = [];
  const publisher = createScreenWebRtcPublisher({
    mode: "direct_webrtc",
    whipPublisherPath: "publisher.exe",
    publishUrl: "wss://example.test/realtime/v1/sessions/s-1/direct-webrtc?role=agent&agentId=a-1",
    agentToken: "agent-token",
    iceServers: [{ urls: "stun:stun.example" }],
    spawn: (_path, args) => {
      calls.push(args);
      queueMicrotask(() => child.stdout.emit("data", Buffer.from("READY\n")));
      return child;
    }
  });
  await publisher.start();
  assert.deepEqual(calls[0].slice(0, 4), ["--signal-url", "wss://example.test/realtime/v1/sessions/s-1/direct-webrtc?role=agent&agentId=a-1", "--signal-token", "agent-token"]);
  await publisher.stop();
});

test("derives WHIP H264 profile-level-id from the source SPS", () => {
  const configuration = Buffer.from("0000000167640029ac2ca501e0089f97011", "hex");
  assert.equal(h264ProfileLevelId({ type: "configuration", data: configuration }), "640029");
  assert.equal(h264ProfileLevelId(Buffer.from([0, 0, 0, 1, 0x68, 0, 0])), "");
});

test("writes encoded H264 data to the FFmpeg stdin and closes it cleanly", async () => {
  const calls = [];
  const publisher = createScreenWebRtcPublisher({
    ffmpegPath: "ffmpeg.exe",
    publishUrl: "rtsp://example.test:8554/pc/a?token=x",
    spawn: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.stdin = new EventEmitter();
      child.stdin.writable = true;
      child.stdin.writableLength = 0;
      child.stdin.write = (value) => { calls.push(Buffer.from(value)); return true; };
      child.stdin.end = () => { child.exitCode = 0; child.emit("exit", 0, null); };
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  });
  await publisher.start();
  await publisher.write({ data: new Uint8Array([1, 2, 3]) });
  assert.deepEqual([...calls[0]], [1, 2, 3]);
  await publisher.stop();
  assert.equal(publisher.running, false);
});
