import crypto from "node:crypto";
import { sanitizeXhsDataCollection } from "../xhs-data-collection.mjs";

const inflight = new Set(["submitting", "running", "unknown"]);
const terminals = new Set(["succeeded", "failed", "cancelled", "expired"]);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const iso = now => new Date(now).toISOString();
export const batchError = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
export const localDay = now => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
const itemKey = item => `${item.deviceId}/${item.appSlot}`;

export function validateClients(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw batchError("invalid_batch_clients");
  const ids = new Set(), users = new Set(), accounts = new Set(), slots = new Set();
  return input.map(client => {
    if (!client || typeof client.clientId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(client.clientId) || ids.has(client.clientId)
      || typeof client.secret !== "string" || client.secret.length < 32 || client.secret.startsWith("REPLACE_")
      || typeof client.username !== "string" || !client.username || typeof client.password !== "string" || !client.password
      || client.password === "SET_OUTSIDE_THE_REPOSITORY" || users.has(client.username)
      || !Array.isArray(client.targets) || !client.targets.length || client.targets.length > 500) throw batchError("invalid_batch_client");
    ids.add(client.clientId); users.add(client.username);
    const targets = client.targets.map(t => {
      if (!t || typeof t.deviceId !== "string" || !t.deviceId || t.deviceId.length > 160
        || !["app1", "app2"].includes(t.appSlot) || typeof t.xhsId !== "string" || !t.xhsId.trim()
        || t.xhsId.length > 64 || typeof t.accountName !== "string" || !t.accountName.trim() || t.accountName.length > 160
        || accounts.has(t.xhsId.toLowerCase()) || slots.has(itemKey(t))) throw batchError("invalid_or_duplicate_batch_target");
      accounts.add(t.xhsId.toLowerCase()); slots.add(itemKey(t));
      return { deviceId: t.deviceId, deviceName: String(t.deviceName || "").slice(0, 80), appSlot: t.appSlot,
        xhsId: t.xhsId, accountName: t.accountName, identitySource: "platform_binding_snapshot" };
    });
    return { ...client, targets };
  });
}

export class BatchEngine {
  constructor({ store, clients, platforms, clock = Date.now }) {
    this.store = store; this.clients = new Map(clients.map(c => [c.clientId, c]));
    this.platforms = platforms; this.clock = clock; this.chain = Promise.resolve(); this.fault = "";
  }
  serial(operation) {
    const call = this.chain.then(() => { if (this.fault) throw batchError(this.fault, 503); this.store.assertHealthy(); return operation(); });
    this.chain = call.catch(() => {}); return call;
  }
  async save(key, value) {
    try { await this.store.set(key, value); }
    catch (error) { this.fault = "batch_storage_unavailable_restart_required"; throw error; }
  }
  client(id) { const c = this.clients.get(id); if (!c) throw batchError("batch_client_not_found", 404); return c; }
  async schedule(id) {
    this.client(id);
    return await this.store.get(`schedule/${id}`) || { enabled: false, time: "02:00", timezone: "Asia/Shanghai", windowMinutes: 240, concurrency: 5 };
  }
  configure(id, input) { return this.serial(async () => {
    this.client(id);
    if (typeof input.enabled !== "boolean" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)
      || !Number.isInteger(input.windowMinutes) || input.windowMinutes < 30 || input.windowMinutes > 720
      || !Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 5
      || Object.keys(input).some(k => !["enabled", "time", "windowMinutes", "concurrency"].includes(k))) throw batchError("invalid_batch_schedule");
    const config = { ...input, timezone: "Asia/Shanghai" };
    await this.save(`schedule/${id}`, config); return config;
  }); }
  create(id, requestId) { return this.serial(() => this.createRun(id, requestId)); }
  async createRun(id, requestId, scheduledAt = null) {
    const client = this.client(id);
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_.:-]{8,120}$/.test(requestId)) throw batchError("invalid_request_id");
    const runId = digest(`${id}\n${requestId}`);
    const existing = await this.store.get(`run/${runId}`);
    if (existing) return this.summary(existing);
    if ((await this.store.runs({ clientId: id, active: true, limit: 1 })).length) throw batchError("batch_already_active", 409);
    const config = await this.schedule(id), now = this.clock();
    const run = { runId, clientId: id, requestId, status: "running", createdAt: iso(now),
      scheduledAt: scheduledAt === null ? null : iso(scheduledAt), deadline: iso((scheduledAt ?? now) + config.windowMinutes * 60_000),
      concurrency: config.concurrency, items: client.targets.map((target, index) => ({ ...target, itemId: String(index), status: "queued", jobId: null, reason: "" })) };
    await this.save(`run/${runId}`, run); return this.summary(run);
  }
  summary(run) {
    const { items, clientId, ...meta } = run;
    return { ...meta, counts: items.reduce((out, item) => { out[item.status] = (out[item.status] || 0) + 1; return out; }, { total: items.length }),
      complete: run.status === "completed" && items.every(item => item.status === "succeeded") };
  }
  async owned(id, runId) {
    if (!/^[a-f0-9]{64}$/.test(runId)) throw batchError("batch_not_found", 404);
    const run = await this.store.get(`run/${runId}`);
    if (!run || run.clientId !== id) throw batchError("batch_not_found", 404);
    return run;
  }
  stop(id, runId) { return this.serial(async () => {
    const run = await this.owned(id, runId);
    for (const item of run.items) if (item.status === "queued") { item.status = "skipped"; item.reason = "batch_stopped"; }
    run.stoppedAt = iso(this.clock());
    if (!run.items.some(i => inflight.has(i.status))) { run.status = "completed"; run.completedAt = run.stoppedAt; }
    await this.save(`run/${runId}`, run); return this.summary(run);
  }); }
  async results(id, runId, offset = 0, limit = 10) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw batchError("invalid_pagination");
    const run = await this.owned(id, runId), items = [];
    for (const item of run.items.slice(offset, offset + limit)) {
      const result = item.hasResult ? await this.store.get(`result/${runId}/${item.itemId}`) : null;
      items.push({ ...item, data: result?.data ?? null });
    }
    return { ...this.summary(run), items, offset, nextOffset: offset + limit < run.items.length ? offset + limit : null };
  }
  reconcile(id, runId, itemId, jobId) { return this.serial(async () => {
    const run = await this.owned(id, runId), item = run.items.find(x => x.itemId === itemId);
    if (!item || !["unknown", "submitting"].includes(item.status) || typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(jobId)) throw batchError("item_not_reconcilable", 409);
    const job = await this.platforms.get(id).job(jobId);
    if (!this.matches(item, job) || job.jobId !== jobId || !Number.isFinite(Date.parse(job.createdAt))
      || Date.parse(job.createdAt) < Date.parse(item.submittedAt) - 60_000 || Date.parse(job.createdAt) > Date.parse(item.submittedAt) + 60_000
      || run.items.some(x => x !== item && x.jobId === jobId)) throw batchError("job_identity_mismatch", 409);
    item.jobId = jobId; item.status = "running"; item.reason = "reconciled_existing_job";
    await this.save(`run/${runId}`, run); return this.summary(run);
  }); }
  matches(item, job) {
    return job?.kind === "xhs_data_collect" && job.deviceId === item.deviceId && job.xhsAppSlot === item.appSlot
      && job.xhsAccountId === item.xhsId && job.accountIdentitySource === "platform_binding_snapshot";
  }
  tick() { return this.serial(async () => {
    const now = this.clock();
    for (const id of this.clients.keys()) {
      const config = await this.schedule(id);
      const start = Date.parse(`${localDay(now)}T${config.time}:00+08:00`);
      if (config.enabled && now >= start && now < start + config.windowMinutes * 60_000) {
        try { await this.createRun(id, `daily:${localDay(now)}`, start); }
        catch (error) { if (error.message !== "batch_already_active") throw error; }
      }
    }
    const runs = await this.store.runs({ active: true, limit: 1000 });
    // Reconcile known jobs before filling capacity; unknown submissions reserve their phone.
    for (const run of runs) {
      const platform = this.platforms.get(run.clientId);
      for (const item of run.items) {
        if (item.status === "submitting") { item.status = "unknown"; item.reason = "submission_interrupted_no_replay"; }
        if (item.status !== "running" || !platform) continue;
        item.needsAttention = now - Date.parse(item.submittedAt) > 30 * 60_000;
        let job;
        try { job = await platform.job(item.jobId); }
        catch { item.reason = "task_status_unavailable"; continue; }
        if (!terminals.has(job?.status)) continue;
        if (!this.matches(item, job) || job.jobId !== item.jobId) {
          item.status = "unknown"; item.reason = "job_identity_mismatch"; continue;
        }
        item.accountName = String(job.xhsAccountName || item.accountName);
        item.status = "failed"; item.reason = job.status;
        if (/^[a-zA-Z0-9_.:-]{1,160}$/.test(job.result?.errorCode || "")) item.errorCode = job.result.errorCode;
        if (job.result?.collection) {
          try {
            const data = sanitizeXhsDataCollection(job.result.collection);
            if (data.app_slot !== item.appSlot || data.window_end_date !== localDay(Date.parse(job.pickedAt || item.submittedAt))) throw new Error("collection_scope_mismatch");
            await this.save(`result/${run.runId}/${item.itemId}`, { data });
            item.hasResult = true;
            if (job.status === "succeeded" && data.complete) { item.status = "succeeded"; item.reason = ""; }
            else item.reason = "collection_incomplete";
          } catch (error) {
            if (this.fault) throw error;
            item.reason = "invalid_collection_result";
          }
        }
        item.completedAt = iso(now);
      }
      await this.save(`run/${run.runId}`, run);
    }
    const occupied = new Set(runs.flatMap(r => r.items.filter(i => inflight.has(i.status)).map(i => i.deviceId)));
    for (const run of runs.reverse()) {
      const client = this.clients.get(run.clientId), platform = this.platforms.get(run.clientId);
      let devices;
      try { devices = platform ? await platform.devices() : null; } catch { devices = null; }
      for (const item of run.items) {
        if (item.status !== "queued") continue;
        if (!client || !client.targets.some(t => itemKey(t) === itemKey(item) && t.xhsId === item.xhsId)) {
          item.status = "skipped"; item.reason = "target_removed_from_allowlist"; continue;
        }
        if (this.clock() >= Date.parse(run.deadline)) { item.status = "skipped"; item.reason = item.reason || "dispatch_window_expired"; continue; }
        if (occupied.has(item.deviceId) || occupied.size >= 5 || run.items.filter(i => inflight.has(i.status)).length >= run.concurrency) continue;
        if (!Array.isArray(devices)) { item.reason = "inventory_unavailable"; continue; }
        const device = devices.find(d => d.deviceId === item.deviceId);
        const account = device?.xhsAccounts?.find(a => a.appSlot === item.appSlot && a.enabled !== false);
        if (!account || account.xhsId !== item.xhsId) { item.status = "skipped"; item.reason = "binding_changed_or_missing"; continue; }
        item.accountName = String(account.accountName || item.accountName);
        if (!device.adbOnline || device.automationStatus?.windowsAgentOnline === false) { item.status = "skipped"; item.reason = "device_offline"; continue; }
        if (device.xhsDataCollectionReady !== true) { item.status = "skipped"; item.reason = "agent_update_required"; continue; }
        if (device.busy || device.occupancy || device.screenControlBusy) { item.reason = "device_busy_waiting"; continue; }
        item.status = "submitting"; item.submittedAt = iso(this.clock()); item.reason = "";
        await this.save(`run/${run.runId}`, run); // Durable intent before the only POST.
        this.store.assertHealthy();
        try {
          const job = await platform.submit(item);
          if (!job?.jobId || typeof job.jobId !== "string") throw new Error("missing_job_id");
          item.jobId = job.jobId; item.status = "running";
        } catch (error) {
          if (error.status === 409 && error.message === "device_busy") { item.status = "queued"; item.reason = "device_busy_waiting"; }
          else if ([400, 401, 403, 404, 409].includes(error.status)) { item.status = "failed"; item.reason = error.message; }
          else { item.status = "unknown"; item.reason = "submission_outcome_unknown_no_replay"; }
        }
        if (inflight.has(item.status)) occupied.add(item.deviceId);
        await this.save(`run/${run.runId}`, run);
      }
      run.status = run.items.some(i => ["unknown", "submitting"].includes(i.status) || i.status === "running" && i.needsAttention) ? "needs_attention"
        : run.items.some(i => i.status === "running" || i.status === "queued") ? "running" : "completed";
      if (run.status === "completed") run.completedAt = iso(this.clock());
      await this.save(`run/${run.runId}`, run);
    }
  }); }
}
