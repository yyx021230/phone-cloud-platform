import assert from "node:assert/strict";
import test from "node:test";

import { buildScreenVideoPublishUrl, openScreenVideoChannel } from "./screen-video-channel.mjs";

test("builds a dedicated Agent video publish URL for one session", () => {
  assert.equal(
    buildScreenVideoPublishUrl("https://phone.example.com/", "session A", "agent/1"),
    "wss://phone.example.com/realtime/v1/sessions/session%20A/video-publish?agentId=agent%2F1"
  );
});

test("publishes binary video on a session-specific socket", async () => {
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.sent = [];
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
        this.listeners?.open?.();
      });
      this.listeners = {};
    }
    once(name, handler) { this.listeners[name] = handler; }
    send(data, options) { this.sent.push({ data, options }); }
    close() { this.readyState = 3; }
  }

  const channel = await openScreenVideoChannel({
    WebSocketCtor: FakeWebSocket,
    serverBaseUrl: "http://127.0.0.1:8787",
    sessionId: "s1",
    agentId: "a1",
    agentToken: "secret"
  });
  channel.send(Buffer.from([1, 2, 3]));

  assert.equal(channel.socket.options.headers.authorization, "Bearer secret");
  assert.deepEqual(channel.socket.sent[0].data, Buffer.from([1, 2, 3]));
  assert.deepEqual(channel.socket.sent[0].options, { binary: true });
});
