import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { acceptsInventoryGzip, createInventorySyncWriter } from "./inventory-sync-response.mjs";

const payload = { ok: true, devices: Array.from({ length: 140 }, (_, n) => ({
  deviceId: `fixture-${n}`, deviceName: `测试${n}`, occupancy: n % 3 ? null : { kind: "screen_control" },
  adb: { serial: `fixture-${n}`, state: "device" }, detail: "fixture inventory status ".repeat(30)
})) };
function response() {
  return { calls: 0, writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.calls++; this.body = body; this.writableEnded = true; } };
}
const request = encoding => ({ headers: { "accept-encoding": encoding } });

test("gzip negotiation respects opt-out and rejects malformed/ambiguous values", () => {
  for (const value of [undefined, "", "identity", "br", "*", "gzip;q=0", "gzip;q=0, *;q=1", "gzip;q=.5",
    "gzip;q=2", "gzip;q=1.001", "gzip;q=no", "gzip;q=1;extra=x", "gzip,gzip;q=0", "x".repeat(8193)]) assert.equal(acceptsInventoryGzip(value), false, value);
  for (const value of ["gzip", "GZip", "gzip, deflate, br", "br;q=1, gzip;q=0.5", "gzip;q=1.000"]) assert.equal(acceptsInventoryGzip(value), true, value);
});

test("compressed response preserves every UTF8 byte, fields, lock and identity state", async () => {
  const writer = createInventorySyncWriter(), res = response();
  await writer(request("gzip, deflate"), res, payload);
  assert.equal(res.status, 200); assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(res.headers["cache-control"], "no-store"); assert.equal(res.headers.vary, "Accept-Encoding");
  assert.equal(res.headers["content-length"], res.body.length);
  assert.deepEqual(gunzipSync(res.body), Buffer.from(JSON.stringify(payload)));
  assert.ok(res.body.length < Buffer.byteLength(JSON.stringify(payload)) / 5);
});

test("identity/disabled gzip and small or oversized payloads keep original JSON", async () => {
  let calls = 0;
  const writer = createInventorySyncWriter({ compress() { calls++; throw new Error("must not compress"); },
    limits: { minBytes: 100, maxBytes: 1000, maxConcurrent: 2, budgetMs: 150 } });
  for (const [encoding, body] of [["identity", { value: "x".repeat(200) }], ["gzip;q=0", payload], ["gzip", {}], ["gzip", payload]]) {
    const res = response(); await writer(request(encoding), res, body);
    assert.deepEqual(res.body, Buffer.from(JSON.stringify(body))); assert.equal(res.headers["content-encoding"], undefined);
  }
  assert.equal(calls, 0);
});

test("compression errors, sync throws and larger output fall back exactly once", async () => {
  for (const compress of [(_b, _o, cb) => cb(new Error("fixture failure")), () => { throw new Error("fixture failure"); },
    (b, _o, cb) => cb(null, Buffer.alloc(b.length + 1))]) {
    const res = response(); await createInventorySyncWriter({ compress })(request("gzip"), res, payload);
    assert.equal(res.calls, 1); assert.equal(res.status, 200); assert.equal(res.headers["content-encoding"], undefined);
    assert.deepEqual(res.body, Buffer.from(JSON.stringify(payload)));
  }
});

test("deadline does not release native capacity early; late callbacks cannot send twice", async () => {
  const callbacks = [];
  const writer = createInventorySyncWriter({ compress(_b, _o, cb) { callbacks.push(cb); },
    limits: { minBytes: 1, maxBytes: 1024 * 1024, maxConcurrent: 2, budgetMs: 15 } });
  const first = response(), second = response(), third = response();
  await Promise.all([writer(request("gzip"), first, payload), writer(request("gzip"), second, payload)]);
  await writer(request("gzip"), third, payload);
  assert.equal(callbacks.length, 2); // The timed out native operations still own both slots.
  callbacks[0](null, gzipSync(JSON.stringify(payload))); callbacks[0](new Error("duplicate callback"));
  callbacks[1](null, gzipSync(JSON.stringify(payload)));
  for (const res of [first, second, third]) { assert.equal(res.calls, 1); assert.equal(res.headers["content-encoding"], undefined); }
  const fourth = response(), promise = writer(request("gzip"), fourth, payload);
  assert.equal(callbacks.length, 3); callbacks[2](null, gzipSync(JSON.stringify(payload))); await promise;
  assert.equal(fourth.headers["content-encoding"], "gzip");
});

test("client disconnect during compression prevents any late response write", async () => {
  let callback;
  const res = response();
  const promise = createInventorySyncWriter({ compress(_b, _o, cb) { callback = cb; } })(request("gzip"), res, payload);
  res.destroyed = true; callback(null, gzipSync(JSON.stringify(payload)));
  assert.equal(await promise, false); assert.equal(res.calls, 0); assert.equal(res.headers, undefined);
});

test("limited link: identity misses client budget, gzip finishes and decodes without lost data", async t => {
  // Synthetic 100KB response, fixed 25KB/s link and 1.2s client budget. No production traffic.
  const body = { devices: Array.from({ length: 140 }, (_, n) => ({ serial: `test-${n}`,
    text: randomBytes(20).toString("hex") + " fixture ".repeat(70) })) };
  const writer = createInventorySyncWriter();
  const upstream = http.createServer(async (req, res) => {
    const captured = response(); await writer(req, captured, body);
    res.writeHead(captured.status, captured.headers);
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      res.write(captured.body.subarray(offset, offset + 1250)); offset += 1250;
      if (offset >= captured.body.length) { clearInterval(timer); res.end(); }
    }, 50);
    res.on("close", () => clearInterval(timer));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const get = encoding => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: upstream.address().port, headers: { "accept-encoding": encoding } }, res => {
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("error", reject);
      res.on("end", () => { clearTimeout(timer); resolve({ raw: Buffer.concat(chunks), headers: res.headers }); });
    });
    const timer = setTimeout(() => req.destroy(new Error("fixture transfer deadline")), 1200);
    req.on("error", e => { clearTimeout(timer); reject(e); });
  });
  await assert.rejects(get("identity"), /deadline|aborted/);
  const result = await get("gzip");
  assert.equal(result.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(result.raw), Buffer.from(JSON.stringify(body)));
});
