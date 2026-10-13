import crypto from "node:crypto";

const TERMINAL_QUERY_STATUSES = new Set([
  "succeeded",
  "not_found",
  "limit_reached",
  "failed",
  "cancelled"
]);

export class OpenNameLookupApiError extends Error {
  constructor(message, { status = 0, code = "open_name_lookup_request_failed", payload = null } = {}) {
    super(message);
    this.name = "OpenNameLookupApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export class OpenNameLookupClient {
  constructor({ baseUrl, clientId, secret, fetchImpl = globalThis.fetch, requestTimeoutMs = 30_000 } = {}) {
    if (!baseUrl) throw new TypeError("baseUrl is required");
    if (!clientId) throw new TypeError("clientId is required");
    if (!secret) throw new TypeError("secret is required");
    if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.clientId = String(clientId);
    this.secret = String(secret);
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || 30_000);
  }

  async lookupName(phoneNumber, { idempotencyKey = crypto.randomUUID(), requestTimeoutMs = 190_000 } = {}) {
    // One key for this logical call, including its network retry. Separate
    // invocations are independent business requests unless caller reuses it.
    for (let attempt = 0; ; attempt++) {
      try { return await this.#request("POST", "/api/v1/open/name-lookups/query", {body:{phoneNumber},idempotencyKey,requestTimeoutMs}); }
      catch (e) { if (e.code !== "network_error" || attempt >= 1) throw e; }
    }
  }

  async submitLookup(phoneNumber, { idempotencyKey = crypto.randomUUID(), requestTimeoutMs = 30_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.#request("POST", "/api/v1/open/name-lookups/tasks", {body:{phoneNumber},idempotencyKey,requestTimeoutMs}); }
      catch (e) { if (e.code !== "network_error" || attempt >= 1) throw e; }
    }
  }

  async getLookupResult(lookupId, { requestTimeoutMs = 30_000 } = {}) {
    if (!lookupId) throw new TypeError("lookupId is required");
    return this.#request("GET", `/api/v1/open/name-lookups/tasks/${encodeURIComponent(lookupId)}`, {requestTimeoutMs});
  }

  async listDevices() {
    return this.#request("GET", "/api/v1/open/name-lookups/devices");
  }

  async createSession(deviceId, { idempotencyKey = crypto.randomUUID() } = {}) {
    return this.#request("POST", "/api/v1/open/name-lookups/sessions", {
      body: { deviceId }, idempotencyKey
    });
  }

  async getSession(sessionId) {
    return this.#request("GET", `/api/v1/open/name-lookups/sessions/${encodeURIComponent(sessionId)}`);
  }

  async enqueueQuery(sessionId, query, { idempotencyKey = crypto.randomUUID() } = {}) {
    return this.#request("POST", `/api/v1/open/name-lookups/sessions/${encodeURIComponent(sessionId)}/queries`, {
      body: query, idempotencyKey
    });
  }

  async enqueueMany(sessionId, queries) {
    const accepted = [];
    // Deliberately sequential: server queue order is request-arrival order.
    for (const query of queries || []) {
      const { idempotencyKey = crypto.randomUUID(), ...body } = query || {};
      accepted.push(await this.enqueueQuery(sessionId, body, { idempotencyKey }));
    }
    return accepted;
  }

  async getQuery(sessionId, queryId) {
    return this.#request("GET", `/api/v1/open/name-lookups/sessions/${encodeURIComponent(sessionId)}/queries/${encodeURIComponent(queryId)}`);
  }

  async resume(sessionId, queryId, { idempotencyKey = crypto.randomUUID() } = {}) {
    return this.#request("POST", `/api/v1/open/name-lookups/sessions/${encodeURIComponent(sessionId)}/resume`, {
      body: { queryId }, idempotencyKey
    });
  }

  async endSession(sessionId) {
    return this.#request("POST", `/api/v1/open/name-lookups/sessions/${encodeURIComponent(sessionId)}/end`, {
      body: {}
    });
  }

  async waitForQueries(sessionId, queryIds, {
    pollIntervalMs = 3_000,
    timeoutMs = 0,
    signal,
    onUpdate
  } = {}) {
    const expected = [...new Set((queryIds || []).map(String).filter(Boolean))];
    if (!expected.length) throw new TypeError("queryIds must not be empty");
    const startedAt = Date.now();
    while (true) {
      if (signal?.aborted) throw signal.reason || new Error("Aborted");
      const { session } = await this.getSession(sessionId);
      if (typeof onUpdate === "function") await onUpdate(session);
      if (session?.humanAction?.required) {
        return { state: "human_action_required", session, queries: selectQueries(session, expected) };
      }
      if (session?.queueState?.status === "paused") {
        return { state: "queue_paused", session, queries: selectQueries(session, expected) };
      }
      const selected = await this.#completeQuerySelection(sessionId, session, expected);
      if (selected.length === expected.length && selected.every((query) => TERMINAL_QUERY_STATUSES.has(query.status))) {
        return { state: "completed", session, queries: selected };
      }
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        return { state: "timeout", session, queries: selected };
      }
      await delay(Math.max(250, Number(pollIntervalMs) || 3_000), signal);
    }
  }

  async #completeQuerySelection(sessionId, session, queryIds) {
    const selected = selectQueries(session, queryIds);
    const found = new Set(selected.map((query) => String(query.queryId)));
    const missing = queryIds.filter((queryId) => !found.has(queryId));
    if (!missing.length) return selected;
    const details = await Promise.all(missing.map(async (queryId) => (await this.getQuery(sessionId, queryId)).query));
    const byId = new Map([...selected, ...details].map((query) => [String(query.queryId), query]));
    return queryIds.map((queryId) => byId.get(queryId)).filter(Boolean);
  }

  async #request(method, pathname, { body, idempotencyKey, requestTimeoutMs } = {}) {
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
    const canonical = [method, pathname, timestamp, nonce, bodyHash].join("\n");
    const signature = crypto.createHmac("sha256", this.secret).update(canonical).digest("hex");
    const headers = {
      "X-Client-Id": this.clientId,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Signature": signature
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Open name lookup request timed out")), requestTimeoutMs || this.requestTimeoutMs);
    let response;
    let text;
    try {
      response = await this.fetchImpl(this.baseUrl + pathname, {
        method, headers, body: body === undefined ? undefined : rawBody, signal: controller.signal
      });
      // fetch resolves at headers; retain the same deadline through the body.
      text = await response.text();
    } catch (error) {
      // Once an HTTP failure is known, a broken body must not turn it into a
      // retryable submission. The business code is unavailable without its JSON.
      if (response && !response.ok) {
        const code = `http_${response.status}`;
        throw new OpenNameLookupApiError(code, { status: response.status, code });
      }
      throw new OpenNameLookupApiError(error?.message || "Network request failed", { code: "network_error" });
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) {
      const code = String(payload?.code || payload?.error || `http_${response.status}`);
      throw new OpenNameLookupApiError(code, { status: response.status, code, payload });
    }
    return payload;
  }
}

function selectQueries(session, queryIds) {
  const byId = new Map((session?.results || []).map((query) => [String(query.queryId), query]));
  return queryIds.map((queryId) => byId.get(queryId)).filter(Boolean);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Aborted"));
    };
    const timer = setTimeout(finish, ms);
    if (!signal) return;
    signal.addEventListener("abort", abort, { once: true });
  });
}
