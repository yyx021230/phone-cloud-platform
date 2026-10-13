import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// The optional path lets the same counterexamples run against the immutable base.
const { OpenNameLookupApiError, OpenNameLookupClient } = await import(
  process.env.LOOKUP_SDK_UNDER_TEST || "./node_client.mjs"
);

async function serverFixture(t, handler) {
  const calls = [];
  const timers = new Set();
  const later = (ms, fn) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  };
  const server = http.createServer((req, res) => {
    calls.push({ key: req.headers["idempotency-key"], nonce: req.headers["x-nonce"], url: req.url });
    req.resume();
    handler(req, res, calls.length, later);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const client = new OpenNameLookupClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    clientId: "synthetic-transport-review",
    secret: "synthetic-transport-review-secret"
  });
  return { client, calls };
}

function assertStableRetry(calls) {
  assert.equal(calls.length, 2, "one initial request plus at most one retry");
  assert.equal(calls[0].key, calls[1].key);
  assert.ok(calls[0].key);
  assert.notEqual(calls[0].nonce, calls[1].nonce);
}

test("GET timeout includes a stalled response body and does not resubmit", async t => {
  const { client, calls } = await serverFixture(t, (_req, res, _n, later) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":');
    later(300, () => res.end('true}'));
  });
  await assert.rejects(client.getLookupResult("synthetic-id", { requestTimeoutMs: 50 }), error => {
    assert.ok(error instanceof OpenNameLookupApiError);
    assert.equal(error.code, "network_error");
    assert.equal(error.status, 0);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("one timeout budget spans both waiting for headers and reading the body", async t => {
  const { client } = await serverFixture(t, (_req, res, _n, later) => {
    later(70, () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":');
      later(100, () => res.end('true}'));
    });
  });
  await assert.rejects(client.getLookupResult("synthetic-id", { requestTimeoutMs: 130 }), { code: "network_error" });
});

for (const method of ["submitLookup", "lookupName"]) {
  test(`${method} retries a truncated accepted response with one stable business key`, async t => {
    const accepted = new Map();
    const { client, calls } = await serverFixture(t, (req, res, n, later) => {
      const key = req.headers["idempotency-key"];
      if (!accepted.has(key)) accepted.set(key, "synthetic-original-id");
      res.writeHead(202, { "content-type": "application/json" });
      if (n === 1) {
        res.write('{"ok":');
        later(10, () => res.destroy());
      } else res.end(JSON.stringify({ ok: true, lookupId: accepted.get(key), name: "测*", reused: true }));
    });
    const result = await client[method]("13800000001", { idempotencyKey: "synthetic-saved-key", requestTimeoutMs: 1000 });
    assertStableRetry(calls);
    assert.equal(accepted.size, 1, "the simulated acceptance ledger still has one business request");
    assert.equal(result.lookupId, "synthetic-original-id");
  });
}

test("repeated body disconnects stop after one network retry", async t => {
  const { client, calls } = await serverFixture(t, (_req, res, _n, later) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.write('{"ok":');
    later(10, () => res.destroy());
  });
  await assert.rejects(client.submitLookup("13800000001", { requestTimeoutMs: 1000 }), { code: "network_error" });
  assertStableRetry(calls);
});

test("repeated body timeouts are bounded and keep the automatically generated key", async t => {
  const { client, calls } = await serverFixture(t, (_req, res, _n, later) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.write('{"ok":');
    later(300, () => res.end('true}'));
  });
  await assert.rejects(client.submitLookup("13800000001", { requestTimeoutMs: 50 }), { code: "network_error" });
  assertStableRetry(calls);
});

test("a known HTTP failure with a stalled body stays an HTTP error without a retry", async t => {
  const { client, calls } = await serverFixture(t, (_req, res, _n, later) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.write('{"code":');
    later(300, () => res.end('"lookup_pool_disabled"}'));
  });
  await assert.rejects(client.submitLookup("13800000001", { requestTimeoutMs: 50 }), { status: 503, code: "http_503" });
  assert.equal(calls.length, 1);
});

test("a known HTTP failure with a broken body does not become a network retry", async t => {
  const { client, calls } = await serverFixture(t, (_req, res, _n, later) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.write('{"code":');
    later(10, () => res.destroy());
  });
  await assert.rejects(client.submitLookup("13800000001", { requestTimeoutMs: 1000 }), { status: 409, code: "http_409" });
  assert.equal(calls.length, 1);
});

test("complete HTTP error bodies preserve status, business code and payload without retry", async t => {
  for (const status of [401, 403, 409, 429, 503]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const payload = { ok: false, code: `synthetic_business_${status}` };
      const client = new OpenNameLookupClient({
        baseUrl: "http://fixture.invalid", clientId: "fixture", secret: "synthetic-secret",
        fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload), { status }); }
      });
      await assert.rejects(client.submitLookup("13800000001"), error => {
        assert.equal(error.status, status);
        assert.equal(error.code, payload.code);
        assert.deepEqual(error.payload, payload);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test("success clears the deadline instead of aborting a completed request later", async () => {
  let signal;
  const client = new OpenNameLookupClient({
    baseUrl: "http://fixture.invalid", clientId: "fixture", secret: "synthetic-secret",
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Response('{"ok":true,"name":"测*"}');
    }
  });
  assert.equal((await client.getLookupResult("synthetic-id", { requestTimeoutMs: 20 })).name, "测*");
  await delay(40);
  assert.equal(signal.aborted, false);
});
