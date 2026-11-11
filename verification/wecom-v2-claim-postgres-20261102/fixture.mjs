// In-memory SQL-shaped fake only. It does not emulate PG row/unique locks,
// SQL constraints, socket delivery or real transaction concurrency.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fixture } from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
import { createWecomV2ClaimPostgresRepository } from "../../server/wecom-cleanup-v2-claim-postgres.mjs";
const copy = value => structuredClone(value);
export const tables = ["phone_cloud_wecom_v2_physical_anchors", "phone_cloud_windows_tasks", "phone_cloud_automation_jobs", "phone_cloud_device_locks", "phone_cloud_wecom_cleanup_v2"];
export function taskRow(d) { return { task_id: d.taskId, agent_id: d.agentId, adb_serial: d.adbSerial, status: d.status, created_at: d.createdAt, updated_at: d.updatedAt, data: copy(d) }; }
export function jobRow(d) { return { job_id: d.jobId, device_id: d.deviceId, user_id: d.userId, kind: d.kind, status: d.status, created_at: d.createdAt, updated_at: d.updatedAt, data: copy(d) }; }
export function lockRow(d) { return { lock_id: d.lockId, device_id: d.deviceId, status: d.status, expires_at: d.expiresAt || null, data: copy(d) }; }
const result = (row, command = "SELECT") => ({ rowCount: row ? 1 : 0, rows: row ? [copy(row)] : [], command });
export function setup(options = {}) {
  const f = fixture(options), { binding: b } = f.context;
  const db = Object.fromEntries(tables.map(t => [t, new Map()]));
  const a = { physical_key: b.serial.toLowerCase(), device_id: b.deviceId, active_obligation_id: null, active_claim_operation_id: null,
    agent_id: b.agentId, mapping_revision: "1", mapping_fingerprint: createHash("sha256").update(JSON.stringify([b.deviceId, b.serial, b.agentId, f.context.target.deviceNumber])).digest("hex"), mapping_state: "ready" };
  db[tables[0]].set(a.physical_key, a); db[tables[1]].set(b.originalTaskId, taskRow(f.input.task));
  db[tables[2]].set(f.context.originalJobId, jobRow(f.input.job)); db[tables[3]].set(f.context.originalLockId, lockRow(f.input.businessLock));
  const pool = { db, clients: [], calls: [], releases: [], before: null, after: null, onCheckout: null,
    async connect() { const c = new Client(pool); pool.clients.push(c); if (pool.onCheckout) await pool.onCheckout(c); return c; } };
  const providers = { getPool: async () => pool, readClaimContext: () => f.context,
    readDeviceMapping: () => ({ device: f.input.device, mappingRevision: 1 }) };
  return { f, pool, providers, repo: createWecomV2ClaimPostgresRepository(providers),
    anchor: () => pool.db[tables[0]].get(a.physical_key),
    task: () => pool.db[tables[1]].get(b.originalTaskId), job: () => pool.db[tables[2]].get(f.context.originalJobId),
    hold: () => pool.db[tables[3]].get(b.obligationId), ledger: () => pool.db[tables[4]].get(b.obligationId) };
}
class Client extends EventEmitter {
  constructor(pool) { super(); this.pool = pool; this.tx = null; this.released = false; this.external = () => {}; this.on("error", this.external); }
  release(error) { if (this.released) throw Error("double_release"); this.released = true; this.tx = null; this.pool.releases.push({ client: this, error }); }
  async query(sql, args) {
    if (this.released) throw Error("released_client_used");
    const p = this.pool; p.calls.push({ client: this, sql, args: copy(args) });
    if (p.before) await p.before(this, sql, args);
    let answer;
    if (sql.startsWith("BEGIN")) { this.tx = copy(p.db); answer = { command: "BEGIN" }; }
    else if (sql.startsWith("SET LOCAL")) answer = { command: "SET" };
    else if (sql === "ROLLBACK") { this.tx = null; answer = { command: "ROLLBACK" }; }
    else if (sql === "COMMIT") { p.db = this.tx; this.tx = null; answer = { command: "COMMIT" }; }
    else if (sql.startsWith("SELECT")) {
      const table = / FROM (\w+) WHERE /.exec(sql)?.[1]; if (!table || !sql.endsWith("FOR UPDATE NOWAIT")) throw Error("bad_select");
      answer = result(this.tx[table].get(args[0]));
    } else if (sql.startsWith("UPDATE phone_cloud_windows_tasks")) {
      const current = this.tx[tables[1]].get(args[0]);
      const d = JSON.parse(args[7]);
      answer = result(current?.status === "queued" && isDeepStrictEqual(current.data, JSON.parse(args[5])) ? taskRow(d) : null, "UPDATE");
      if (answer.rowCount) this.tx[tables[1]].set(args[0], answer.rows[0]);
    } else if (sql.startsWith("UPDATE phone_cloud_automation_jobs")) {
      const current = this.tx[tables[2]].get(args[0]), d = JSON.parse(args[8]);
      answer = result(current?.status === "queued" && isDeepStrictEqual(current.data, JSON.parse(args[6])) ? jobRow(d) : null, "UPDATE");
      if (answer.rowCount) this.tx[tables[2]].set(args[0], answer.rows[0]);
    } else if (sql.startsWith("INSERT INTO phone_cloud_device_locks")) {
      if (this.tx[tables[3]].has(args[0])) throw Error("fake_duplicate_hold");
      answer = result(lockRow(JSON.parse(args[3])), "INSERT"); this.tx[tables[3]].set(args[0], answer.rows[0]);
    } else if (sql.startsWith("INSERT INTO phone_cloud_wecom_cleanup_v2")) {
      if (this.tx[tables[4]].has(args[0])) throw Error("fake_duplicate_ledger");
      answer = result({ obligation_id: args[0], server_epoch: args[1], revision: 0, host_operation_id: null, close_operation_id: null,
        protocol_state: JSON.parse(args[2]), claim_data: JSON.parse(args[3]) }, "INSERT"); this.tx[tables[4]].set(args[0], answer.rows[0]);
    } else if (sql.startsWith("UPDATE phone_cloud_wecom_v2_physical_anchors")) {
      const a = this.tx[tables[0]].get(args[0]);
      answer = result(a?.active_obligation_id === null && a?.active_claim_operation_id === null
        && String(a.mapping_revision) === args[3] && a.mapping_fingerprint === args[4] && a.mapping_state === "ready"
        ? { ...a, active_obligation_id: args[1], active_claim_operation_id: args[2] } : null, "UPDATE");
      if (answer.rowCount) this.tx[tables[0]].set(args[0], answer.rows[0]);
    } else throw Error("unexpected_sql");
    return p.after ? await p.after(this, sql, answer) : answer;
  }
}
export const isDml = sql => /^(INSERT|UPDATE|DELETE)/.test(sql);
