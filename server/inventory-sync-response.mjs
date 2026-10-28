import { gzip } from "node:zlib";

// Only the authenticated inventory-sync success route uses this writer.
// No queue: overload, slow compression and errors retain the existing JSON reply.
export const INVENTORY_COMPRESSION_LIMITS = Object.freeze({
  minBytes: 1024, maxBytes: 4 * 1024 * 1024, maxConcurrent: 2, budgetMs: 150
});

export function acceptsInventoryGzip(header) {
  if (typeof header !== "string" || header.length > 8192) return false;
  const matches = header.split(",").map(s => s.trim()).filter(s => /^gzip(?:\s*;|$)/i.test(s));
  if (!matches.length) return false;
  // Ambiguous/invalid duplicate declarations fail closed to the old identity path.
  return matches.every(s => {
    const match = s.match(/^gzip\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i);
    return match && (match[1] === undefined || Number(match[1]) > 0);
  });
}

export function createInventorySyncWriter({ compress = gzip, limits = INVENTORY_COMPRESSION_LIMITS } = {}) {
  let active = 0;
  return async function sendInventorySyncResponse(req, res, payload) {
    const raw = Buffer.from(JSON.stringify(payload));
    let body = raw, encoded = false;
    if (acceptsInventoryGzip(req.headers["accept-encoding"])
        && raw.length >= limits.minBytes && raw.length <= limits.maxBytes
        && active < limits.maxConcurrent && !res.destroyed) {
      active++;
      const result = await new Promise(resolve => {
        let settled = false, finished = false;
        const settle = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => settle(null), limits.budgetMs);
        const done = (error, compressed) => {
          if (finished) return;
          finished = true;
          // Keep the slot occupied after a deadline until native work actually ends.
          active--;
          settle(!error && Buffer.isBuffer(compressed) && compressed.length < raw.length ? compressed : null);
        };
        try { compress(raw, { level: 1 }, done); } catch (error) { done(error); }
      });
      if (result) { body = result; encoded = true; }
    }
    if (res.destroyed || res.writableEnded) return false;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      vary: "Accept-Encoding", "content-length": body.length,
      ...(encoded ? { "content-encoding": "gzip" } : {})
    });
    res.end(body);
    return true;
  };
}

export const sendInventorySyncResponse = createInventorySyncWriter();
