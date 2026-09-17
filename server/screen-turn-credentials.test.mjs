import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createScreenTurnIceServers, parseScreenTurnUrls } from "./screen-turn-credentials.mjs";

test("issues bounded coturn REST credentials without exposing the shared secret", () => {
  const secret = "test-only-shared-secret";
  const [turn, fallback] = createScreenTurnIceServers({
    staticIceServers: [{ urls: "stun:stun.example.test:3478" }],
    turnUrls: ["turn:relay.example.test:3478?transport=udp", "turns:relay.example.test:5349?transport=tcp"],
    sharedSecret: secret,
    sessionId: "session/35",
    ttlSeconds: 600,
    nowMs: 1_788_140_000_000
  });
  assert.deepEqual(turn.urls, ["turn:relay.example.test:3478?transport=udp", "turns:relay.example.test:5349?transport=tcp"]);
  assert.equal(turn.username, "1788140600:session_35");
  assert.equal(turn.credential, crypto.createHmac("sha1", secret).update(turn.username).digest("base64"));
  assert.equal(JSON.stringify([turn, fallback]).includes(secret), false);
  assert.deepEqual(fallback, { urls: "stun:stun.example.test:3478" });
});

test("falls back to sanitized static ICE servers when TURN is not configured", () => {
  assert.deepEqual(createScreenTurnIceServers({
    staticIceServers: [{ urls: ["stun:one.example:3478", "https://invalid.example"] }]
  }), [{ urls: "stun:one.example:3478" }]);
  assert.deepEqual(parseScreenTurnUrls(" turn:one.example:3478,invalid,turn:one.example:3478 "), ["turn:one.example:3478"]);
});
