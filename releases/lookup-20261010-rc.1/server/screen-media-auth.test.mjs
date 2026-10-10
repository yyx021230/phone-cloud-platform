import assert from "node:assert/strict";
import test from "node:test";
import { createScreenMediaAuthorizer, extractMediaToken, mediaPathForSession } from "./screen-media-auth.mjs";

const sessionId = "c52898c3-8fbf-4eaa-9566-431acda455ee";

test("issues a short lived token scoped to one media action and session path", () => {
  let now = 1_000;
  const auth = createScreenMediaAuthorizer({ secret: "a-long-enough-test-media-secret", now: () => now, tokenTtlMs: 60_000 });
  const token = auth.issue({ sessionId, action: "publish" });
  assert.equal(auth.verify(token, { action: "publish", path: mediaPathForSession(sessionId) }).ok, true);
  assert.equal(auth.verify(token, { action: "read", path: mediaPathForSession(sessionId) }).reason, "invalid_action");
  assert.equal(auth.verify(token, { action: "publish", path: "pc/22222222-2222-2222-2222-222222222222" }).reason, "invalid_path");
  now += 60_001;
  assert.equal(auth.verify(token, { action: "publish", path: mediaPathForSession(sessionId) }).reason, "expired_token");
});

test("authorizes MediaMTX query and bearer token forms without accepting a mismatched path", () => {
  const auth = createScreenMediaAuthorizer({ secret: "a-long-enough-test-media-secret", now: () => 1_000 });
  const token = auth.issue({ sessionId, action: "read" });
  assert.equal(auth.authorizeMediaRequest({ action: "read", path: mediaPathForSession(sessionId), query: `token=${encodeURIComponent(token)}` }).ok, true);
  assert.equal(auth.authorizeMediaRequest({ action: "read", path: mediaPathForSession(sessionId), authorization: `Bearer ${token}` }).ok, true);
  assert.equal(auth.authorizeMediaRequest({ action: "read", path: "pc/22222222-2222-2222-2222-222222222222", token }).ok, false);
  assert.equal(extractMediaToken({ authorization: `Bearer ${token}` }), token);
});

test("authorizes a fixed media slot only when explicitly bound to the token", () => {
  const auth = createScreenMediaAuthorizer({ secret: "a-long-enough-test-media-secret", now: () => 1_000 });
  const token = auth.issue({ sessionId, action: "read", path: "pc/slot-7" });
  assert.equal(auth.verify(token, { action: "read", path: "pc/slot-7" }).ok, true);
  assert.equal(auth.verify(token, { action: "read", path: "pc/slot-8" }).reason, "invalid_path");
});
