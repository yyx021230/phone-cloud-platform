// In-memory test adapter only; production entry always requires PostgreSQL.
export function memoryStore() {
  const records = new Map(), nonces = new Set();
  return {
    records, assertHealthy() {},
    async get(key) { return structuredClone(records.get(key) ?? null); },
    async set(key, value) { records.set(key, structuredClone(value)); },
    async list(prefix) { return [...records].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v)); },
    async runs({ clientId = null, active = false, limit = 50, offset = 0 } = {}) {
      return (await this.list("run/")).filter(r => (!clientId || r.clientId === clientId) && (!active || ["running", "needs_attention"].includes(r.status))).slice(offset, offset + limit);
    },
    async nonce(id, nonce) { const key = `${id}/${nonce}`; if (nonces.has(key)) return false; nonces.add(key); return true; }
  };
}
