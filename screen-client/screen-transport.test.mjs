import assert from "node:assert/strict";
import test from "node:test";

import { buildScreenTransportUrls, createScreenTransport } from "./screen-transport.js";

test("builds isolated browser video and control websocket URLs", () => {
  assert.deepEqual(
    buildScreenTransportUrls("https://phone.example.com/base", "session A", "token+/="),
    {
      controlUrl: "wss://phone.example.com/realtime/v1/sessions/session%20A/control",
      videoUrl: "wss://phone.example.com/realtime/v1/sessions/session%20A/video"
    }
  );
});

test("sends controls only through the control socket and video only reaches the video handler", () => {
  const sockets = [];
  const videos = [];
  const controls = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url, protocols = []) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; }
  }
  const transport = createScreenTransport({
    WebSocketCtor: FakeWebSocket,
    onVideo: (data) => videos.push(data),
    onControl: (data) => controls.push(data)
  });

  transport.connect({ baseUrl: "http://127.0.0.1:8787", sessionId: "s1", browserToken: "t1" });
  assert.equal(sockets.length, 2);
  const control = sockets.find((socket) => socket.url.endsWith("/control"));
  const video = sockets.find((socket) => socket.url.endsWith("/video"));
  control.readyState = FakeWebSocket.OPEN;
  video.readyState = FakeWebSocket.OPEN;
  transport.send({ type: "key", key: "home", sequenceId: 1 });
  control.onmessage({ data: "status" });
  video.onmessage({ data: new Uint8Array([1, 2, 3]) });

  assert.deepEqual(control.sent, [JSON.stringify({ type: "key", key: "home", sequenceId: 1 })]);
  assert.deepEqual(video.sent, []);
  assert.deepEqual(controls, ["status"]);
  assert.equal(videos.length, 1);
  assert.deepEqual(control.protocols, ["t1"]);
});
