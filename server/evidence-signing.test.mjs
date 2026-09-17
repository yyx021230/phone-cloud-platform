import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceSignedUrl, verifyEvidenceSignedUrl } from "./evidence-signing.mjs";

const secret = "test-evidence-secret-with-sufficient-length";
const nowMs = Date.UTC(2026, 6, 14, 8, 0, 0);

test("creates a short-lived signed evidence URL", () => {
  const url = createEvidenceSignedUrl("evidence-1", { secret, nowMs, ttlSeconds: 300 });
  const parsed = new URL(url, "http://localhost");

  assert.equal(parsed.pathname, "/api/v1/evidence/evidence-1");
  assert.equal(parsed.searchParams.get("expires"), String(Math.floor(nowMs / 1000) + 300));
  assert.ok(parsed.searchParams.get("sig"));
  assert.equal(verifyEvidenceSignedUrl("evidence-1", {
    secret,
    expires: parsed.searchParams.get("expires"),
    signature: parsed.searchParams.get("sig"),
    nowMs: nowMs + 299_000
  }), true);
});

test("rejects expired or tampered evidence URLs", () => {
  const url = createEvidenceSignedUrl("evidence-1", { secret, nowMs, ttlSeconds: 60 });
  const parsed = new URL(url, "http://localhost");
  const params = {
    secret,
    expires: parsed.searchParams.get("expires"),
    signature: parsed.searchParams.get("sig")
  };

  assert.equal(verifyEvidenceSignedUrl("evidence-1", { ...params, nowMs: nowMs + 61_000 }), false);
  assert.equal(verifyEvidenceSignedUrl("evidence-2", { ...params, nowMs }), false);
  assert.equal(verifyEvidenceSignedUrl("evidence-1", { ...params, signature: `${params.signature}0`, nowMs }), false);
  assert.equal(verifyEvidenceSignedUrl("evidence-1", { ...params, secret: "another-secret", nowMs }), false);
  assert.equal(verifyEvidenceSignedUrl("evidence-1", { secret, signature: params.signature, nowMs }), false);
});
