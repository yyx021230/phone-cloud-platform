import crypto from "node:crypto";
import { batchError } from "./engine.mjs";

export function signRequest(secret, method, target, timestamp, nonce, body = "") {
  return crypto.createHmac("sha256", secret).update([method, target, timestamp, nonce,
    crypto.createHash("sha256").update(body).digest("hex")].join("\n")).digest("hex");
}
export function createBatchHandler({ engine, store, clients, clock = Date.now }) {
  const map = new Map(clients.map(c => [c.clientId, c]));
  return async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    try {
      if (req.url === "/healthz" && req.method === "GET") {
        store.assertHealthy(); if (engine.fault) throw new Error("unhealthy");
        return send(200, { ok: true, version: "xhs-batch-v1" });
      }
      const client = map.get(req.headers["x-client-id"]);
      const timestamp = req.headers["x-timestamp"], nonce = req.headers["x-nonce"], signature = req.headers["x-signature"];
      const now = clock();
      if (!client || !/^\d{13}$/.test(timestamp || "") || Math.abs(now - Number(timestamp)) > 300_000
        || !/^[A-Za-z0-9_.:-]{16,120}$/.test(nonce || "") || !/^[a-f0-9]{64}$/.test(signature || "")) throw batchError("invalid_auth", 401);
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; if (size > 65536) throw batchError("body_too_large", 413); chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const expected = signRequest(client.secret, req.method, req.url, timestamp, nonce, body);
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw batchError("invalid_auth", 401);
      if (!await store.nonce(client.clientId, nonce, new Date(now + 600_000))) throw batchError("nonce_replayed", 401);
      let input = {};
      try { input = body ? JSON.parse(body) : {}; } catch { throw batchError("invalid_json"); }
      if (!input || typeof input !== "object" || Array.isArray(input)) throw batchError("invalid_json");
      const url = new URL(req.url, "http://localhost"), id = client.clientId;
      const root = "/api/v1/open/xhs-data";
      if (url.pathname === `${root}/schedule`) {
        if (req.method === "GET") return send(200, { schedule: await engine.schedule(id), targetCount: client.targets.length });
        if (req.method === "PUT") return send(200, { schedule: await engine.configure(id, input) });
      }
      if (url.pathname === `${root}/batches`) {
        if (req.method === "POST") {
          if (Object.keys(input).some(k => k !== "requestId") || String(input.requestId).startsWith("daily:")) throw batchError("invalid_batch_request");
          return send(200, { batch: await engine.create(id, input.requestId) });
        }
        if (req.method === "GET") {
          const offset = Number(url.searchParams.get("offset") || 0);
          if (!Number.isSafeInteger(offset) || offset < 0) throw batchError("invalid_pagination");
          const runs = await store.runs({ clientId: id, limit: 20, offset });
          return send(200, { batches: runs.map(r => engine.summary(r)), offset, nextOffset: runs.length === 20 ? offset + 20 : null });
        }
      }
      const match = url.pathname.match(/^\/api\/v1\/open\/xhs-data\/batches\/([a-f0-9]{64})(?:\/items\/([0-9]+)\/reconcile)?$/);
      const stop = url.pathname.match(/^\/api\/v1\/open\/xhs-data\/batches\/([a-f0-9]{64})\/stop$/);
      if (req.method === "POST" && stop) {
        if (Object.keys(input).length) throw batchError("stop_body_must_be_empty");
        return send(200, { batch: await engine.stop(id, stop[1]) });
      }
      if (match) {
        if (req.method === "GET" && !match[2]) return send(200, await engine.results(id, match[1], Number(url.searchParams.get("offset") || 0), Number(url.searchParams.get("limit") || 10)));
        if (req.method === "POST" && match[2] !== undefined) {
          if (Object.keys(input).some(k => k !== "jobId")) throw batchError("invalid_reconcile_request");
          return send(200, { batch: await engine.reconcile(id, match[1], match[2], input.jobId) });
        }
      }
      send(404, { error: "not_found" });
    } catch (error) { send(error.statusCode || 503, { error: error.statusCode ? error.message : "batch_service_unavailable" }); }
  };
}
