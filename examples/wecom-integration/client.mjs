// Example server-to-server client. No environment loading or automatic POST retries.
export class WecomApiError extends Error {
  constructor(status, code, taskId) {
    super(code); this.status = status; this.code = code;
    if (taskId) this.taskId = taskId;
  }
}
export class WecomClient {
  #base; #token; #fetch;
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error("invalid_base_url"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_base_url");
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) throw new Error("missing_or_invalid_token");
    this.#base = url.origin; this.#token = token; this.#fetch = fetchImpl;
  }
  async #request(method, route, body, { timeoutMs = 15000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("invalid_timeout");
    let response;
    try {
      response = await this.#fetch(this.#base + route, { method, redirect: "error",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new WecomApiError(0, "transport_outcome_unknown"); }
    let data;
    try { data = await response.json(); } catch { throw new WecomApiError(response.status, "response_outcome_unknown"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new WecomApiError(response.status, "response_outcome_unknown");
    if (!response.ok) {
      const code = /^[a-zA-Z0-9_]{1,100}$/.test(data.error || "") ? data.error : "request_failed";
      throw new WecomApiError(response.status, code, /^[A-Za-z0-9_-]{1,100}$/.test(data.taskId || "") ? data.taskId : undefined);
    }
    return data;
  }
  async devices({ onlineOnly = false, ...options } = {}) {
    if (typeof onlineOnly !== "boolean") throw new Error("invalid_online_filter");
    const data = await this.#request("GET", "/api/v1/wecom/devices" + (onlineOnly ? "?onlineOnly=true" : ""), undefined, options);
    if (!Array.isArray(data.devices) || typeof data.capacity?.remaining !== "number") throw new WecomApiError(200, "response_outcome_unknown");
    return data;
  }
  async submit(input, options) {
    const data = await this.#request("POST", "/api/v1/wecom/customer-invitations", input, options);
    return this.#task(data);
  }
  async result(taskId, options) {
    if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) throw new Error("invalid_task_id");
    return this.#task(await this.#request("GET", "/api/v1/wecom/customer-invitations/" + encodeURIComponent(taskId), undefined, options));
  }
  #task(data) {
    if (typeof data.taskId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(data.taskId)
        || !["queued", "running", "needs_attention", "unknown", "failed"].includes(data.status)) throw new WecomApiError(200, "response_outcome_unknown");
    return data;
  }

}
