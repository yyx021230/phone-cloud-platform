const route = "/api/v1/user/automation/xhs-data-tasks";
export class PlatformError extends Error {
  constructor(code, status = 0) { super(code); this.status = status; }
}

// POST is never replayed. Lost replies are reconciled by clientRequestId instead.
export function createPlatformClient({ baseUrl, username, password, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/"
      || !["http:", "https:"].includes(base.protocol) || !base.hostname) {
    throw new Error("invalid_platform_url");
  }
  let token = "";
  async function raw(method, path, body, auth = "") {
    let response;
    try {
      response = await fetchImpl(new URL(path, base), { method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new PlatformError("platform_transport_unknown"); }
    let value;
    try { value = await response.json(); } catch { throw new PlatformError("platform_response_unknown"); }
    if (!response.ok) throw new PlatformError(typeof value.error === "string" ? value.error.slice(0, 160) : "platform_error", response.status);
    return value;
  }
  async function login() {
    const result = await raw("POST", "/api/v1/auth/login", { username, password });
    if (!result.session?.token) throw new PlatformError("platform_login_failed", 401);
    if (result.user?.role !== "user" || result.user.enabled === false) throw new PlatformError("dedicated_ordinary_user_required", 403);
    token = result.session.token;
  }
  async function request(method, path, body) {
    if (!token) await login();
    try { return await raw(method, path, body, token); }
    catch (error) {
      if (error.status === 401) {
        token = "";
        if (method === "GET") { await login(); return raw(method, path, body, token); }
      }
      throw error;
    }
  }
  return {
    devices: async () => {
      const { batchContract: c } = await request("GET", route);
      if (c?.version !== 1 || c.expectedXhsId !== true || c.identitySnapshot !== true || c.submissionLookup !== true) throw new PlatformError("platform_batch_contract_required", 409);
      return (await request("GET", "/api/v1/user/devices")).devices;
    },
    submission: async reference => {
      const { tasks } = await request("GET", `${route}?clientRequestId=${encodeURIComponent(reference)}`);
      if (!Array.isArray(tasks) || tasks.length > 1) throw new PlatformError("submission_lookup_ambiguous");
      return tasks[0] || null;
    },
    submit: async target => (await request("POST", route, { deviceId: target.deviceId, xhsAppSlot: target.appSlot, expectedXhsId: target.xhsId, clientRequestId: target.clientRequestId })).task,
    job: async id => (await request("GET", `${route}/${encodeURIComponent(id)}`)).task
  };
}
