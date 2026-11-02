// Explicit private-cluster entry, outside normal test globs. Do not run until
// the runner/proxy source manifest has been reviewed. All identities synthetic.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test, { before, after } from "node:test";
import { fixture } from "./fixture.mjs";
import { ownedConfiguration, verifyOwnedServer } from "./owned-pg.mjs";
import { startCommitReplyProxy } from "./pg-commit-proxy.mjs";
import { createWecomV2PostgresRepository } from "../../server/wecom-cleanup-v2-postgres.mjs";

const config = await ownedConfiguration(), db = new config.Pool(config.options);
const here = path.dirname(fileURLToPath(import.meta.url)), project = path.resolve(here, "../..");
const evidence = { kind: "private-postgres-fixture-only", cases: [], server: null };
const repo = (f, pool = db) => createWecomV2PostgresRepository({ ...f.providers, getPool: async () => pool });
const stored = async f => (await db.query("SELECT protocol_state FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1", [f.binding.obligationId])).rows[0]?.protocol_state;
const note = (name, facts) => evidence.cases.push({ name, ...facts });
function selectBarrierPool() {
  let arrivals = 0, release, timer;
  const backendPids = [], gate = new Promise((resolve, reject) => {
    release = resolve; timer = setTimeout(() => reject(Error("fixture_barrier_timeout")), 5000);
  });
  return { backendPids, async connect() {
    const client = await db.connect(); backendPids.push(client.processID);
    return { release: error => client.release(error), async query(sql, values) {
      if (sql.startsWith("SELECT") && sql.includes("FROM phone_cloud_wecom_cleanup_v2") && sql.endsWith("FOR UPDATE")) {
        arrivals++; if (arrivals === 2) { clearTimeout(timer); release(); } await gate;
      }
      return client.query(sql, values);
    } };
  } };
}
before(async () => {
  evidence.server = await verifyOwnedServer(db, config);
  await db.query(await fs.readFile(path.join(project, "deploy/sql/wecom-cleanup-v2.sql"), "utf8"));
});
after(async () => {
  await db.end();
  await fs.writeFile(path.join(config.root, "PG_EVIDENCE.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
});

test("actual PG: initialization/dedup/close/late host replay retains exact original operation", async () => {
  const f = fixture("basic"), r = repo(f);
  await r.createPending(f.binding); const first = await r.commitHostOperation("host", f.body);
  const reverse = o => Object.fromEntries(Object.entries(o).reverse());
  const duplicate = await r.commitHostOperation("host", reverse({ ...f.body, binding: reverse(f.body.binding) }));
  assert.deepEqual(duplicate, first);
  await assert.rejects(r.commitHostOperation("host", { ...f.body, expectedRevision: 1 }), /operation_conflict/);
  f.facts.closeEventId = f.closeBody().closeEventId;
  const closed = await r.commitHostOperation("host-closed", f.closeBody());
  const late = await r.reconcileOperation("host", f.body), s = await stored(f);
  assert.equal(closed.revision, 2); assert.equal(s.revision, 2); assert.equal(s.operations.length, 2);
  assert.deepEqual(late.storedOperation, first.storedOperation); assert.equal(late.storedOperation.replyCandidate.preparedRevision, 1);
  assert.equal(late.protocolPermit, false); assert.equal(s.fence, "held");
  note("basic", { revision: s.revision, operations: s.operations.length, lateHostPreparedRevision: 1 });
});
test("actual PG: independent concurrent same-ID transactions increment revision once", async () => {
  const f = fixture("same"), r = repo(f); await r.createPending(f.binding);
  const barrier = selectBarrierPool();
  const answers = await Promise.all([repo(f, barrier).commitHostOperation("host", f.body), repo(f, barrier).commitHostOperation("host", f.body)]);
  const s = await stored(f); assert.equal(s.revision, 1); assert.equal(s.operations.length, 1);
  assert.ok(answers.every(a => a.commitKnown && !a.protocolPermit)); assert.deepEqual(answers[0], answers[1]);
  assert.equal(new Set(barrier.backendPids).size, 2);
  note("same-id-concurrency", { revision: 1, operations: 1, confirmedResponses: answers.length, backendPids: barrier.backendPids });
});
test("actual PG: concurrent different IDs at same revision have one winner", async () => {
  const f = fixture("different"), r = repo(f); await r.createPending(f.binding);
  const barrier = selectBarrierPool();
  const answers = await Promise.allSettled([repo(f, barrier).commitHostOperation("host", f.body), repo(f, barrier).commitHostOperation("host", { ...f.body, operationId: "competing-host" })]);
  assert.equal(answers.filter(a => a.status === "fulfilled").length, 1);
  assert.match(answers.find(a => a.status === "rejected").reason.message, /revision_conflict|phase_conflict/);
  const s = await stored(f); assert.equal(s.revision, 1); assert.equal(s.operations.length, 1);
  assert.equal(new Set(barrier.backendPids).size, 2);
  note("different-id-concurrency", { revision: 1, operations: 1, rejected: 1, backendPids: barrier.backendPids });
});
test("actual PG: fixture UPDATE trigger failure preserves original revision", async () => {
  const f = fixture("trigger"), r = repo(f); await r.createPending(f.binding);
  await db.query(`CREATE FUNCTION wecom_v2_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_reject'; END; $$;
    CREATE TRIGGER wecom_v2_fixture_reject BEFORE UPDATE ON phone_cloud_wecom_cleanup_v2
    FOR EACH ROW WHEN (NEW.obligation_id = 'duty-trigger') EXECUTE FUNCTION wecom_v2_fixture_reject()`);
  try {
    const a = await r.commitHostOperation("host", f.body); assert.equal(a.storageStatus, "unknown");
    assert.equal(a.commitKnown, false); assert.equal((await stored(f)).revision, 0);
    note("trigger-rollback", { revision: 0, storageStatus: a.storageStatus });
  } finally { await db.query("DROP TRIGGER wecom_v2_fixture_reject ON phone_cloud_wecom_cleanup_v2; DROP FUNCTION wecom_v2_fixture_reject()"); }
});
test("actual PG: missing JSON field and duplicate operation slots fail SQL constraints", async () => {
  const f = fixture("constraints"), r = repo(f); await r.createPending(f.binding);
  await assert.rejects(db.query("UPDATE phone_cloud_wecom_cleanup_v2 SET protocol_state=protocol_state-'fence' WHERE obligation_id=$1", [f.binding.obligationId]), e => e.code === "23514");
  const host = f.prepare(f.initial, "host", f.body).nextState; f.facts.closeEventId = f.closeBody().closeEventId;
  const bad = structuredClone(f.prepare(host, "host-closed", f.closeBody()).nextState); bad.closeOperationId = bad.hostOperationId;
  await assert.rejects(db.query(`UPDATE phone_cloud_wecom_cleanup_v2 SET revision=2,host_operation_id=$2,close_operation_id=$2,protocol_state=$3::jsonb WHERE obligation_id=$1`, [f.binding.obligationId, bad.hostOperationId, JSON.stringify(bad)]), e => e.code === "23514");
  assert.equal((await stored(f)).revision, 0); note("sql-constraints", { rejectedMissingField: true, rejectedDuplicateSlots: true, revision: 0 });
});
test("actual PG: one row lock times out while another obligation commits", async () => {
  const a = fixture("locked"), b = fixture("unlocked"); await repo(a).createPending(a.binding); await repo(b).createPending(b.binding);
  const holder = await db.connect();
  try {
    await holder.query("BEGIN"); await holder.query("SELECT obligation_id FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1 FOR UPDATE", [a.binding.obligationId]);
    const waiting = repo(a).commitHostOperation("host", a.body);
    const other = await repo(b).commitHostOperation("host", b.body);
    assert.equal(other.storageStatus, "committed");
    const blocked = await waiting; assert.equal(blocked.storageStatus, "unknown"); assert.equal(blocked.commitKnown, false);
    assert.equal((await stored(a)).revision, 0); assert.equal((await stored(b)).revision, 1);
    note("row-lock-isolation", { lockedRevision: 0, otherRevision: 1, otherCommittedBeforeHolderRelease: true });
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});

async function proxyCase({ name, mode, initialize = false, mutation = null }) {
  const f = fixture(name); if (!initialize) await repo(f).createPending(f.binding);
  const proxy = await startCommitReplyProxy({ backendPort: config.port, mode,
    onBackendCompletion: mutation ? e => { assert.ok(e.commitConfirmedFromBackend); if (mutation === "epoch") f.auth.serverEpoch = "changed-after-backend-commit"; else f.auth.version = 1; } : undefined });
  const pool = new config.Pool({ ...config.options, port: proxy.port, max: 1 }), backendPids = [];
  pool.on("connect", client => backendPids.push(client.processID));
  try {
    const r = repo(f, pool), answer = initialize ? await r.createPending(f.binding) : await r.commitHostOperation("host", f.body);
    const s = await stored(f), wire = proxy.snapshot();
    const writes = wire.events.filter(e => e.event === "query" && e.command === (initialize ? "INSERT" : "UPDATE"));
    assert.equal(writes.length, 1); assert.equal(answer.protocolPermit, false); assert.equal(answer.fence, "held");
    if (mode === "after_commit") {
      const proof = wire.events.find(e => e.event === "backend_commit_completion");
      assert.ok(proof?.commitConfirmedFromBackend); assert.equal(proof.commandTag, "COMMIT"); assert.equal(proof.readyForQuery, "I"); assert.equal(proof.errorResponseCount, 0);
      assert.equal(s.revision, initialize ? 0 : 1);
      if (mutation) {
        assert.equal(answer.storageStatus, mutation === "epoch" ? "obsolete_epoch" : "unknown"); assert.equal(answer.commitKnown, false);
        assert.equal(backendPids.length, 1);
      } else {
        assert.equal(answer.storageStatus, "committed_reconciled"); assert.equal(answer.commitKnown, true);
        assert.equal(new Set(backendPids).size, 2);
        if (!initialize) assert.deepEqual(s.operations[0].request, f.body);
      }
    } else {
      assert.equal(answer.storageStatus, "unknown"); assert.equal(answer.commitKnown, false); assert.equal(s.revision, 0);
      assert.ok(wire.events.some(e => e.event === "dropped_before_commit")); assert.ok(!wire.events.some(e => e.commitConfirmedFromBackend));
    }
    note(name, { wire, backendPids, independentRowRevision: s.revision, storageStatus: answer.storageStatus, commitKnown: answer.commitKnown, originalWriteCount: writes.length });
  } finally { await pool.end(); await proxy.close(); }
}
test("actual PG: COMMIT success bytes dropped then independent max1 read reconciles", () => proxyCase({ name: "commit-after", mode: "after_commit" }));
test("actual PG: COMMIT dropped before backend is unknown, no write replay", () => proxyCase({ name: "commit-before", mode: "before_commit" }));
test("actual PG: initialization COMMIT response lost preserves original row", () => proxyCase({ name: "init-after", mode: "after_commit", initialize: true }));
for (const initialize of [false, true]) for (const mutation of ["epoch", "malformed"]) {
  test(`actual PG: unknown COMMIT with ${initialize ? "init" : "operation"} ${mutation} retains structured uncertainty`,
    () => proxyCase({ name: `${initialize ? "init" : "op"}-${mutation}`, mode: "after_commit", initialize, mutation }));
}
test("actual PG: fresh Node child sees persisted row but cannot reuse old epoch", async () => {
  const f = fixture("restart"); await repo(f).createPending(f.binding); await repo(f).commitHostOperation("host", f.body);
  const env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "WECOM_V2_FIXTURE_ROOT", "WECOM_V2_FIXTURE_PORT"].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(here, "pg-readback-child.mjs")], { env, timeout: 10000, maxBuffer: 16384 });
  const record = JSON.parse(stdout); assert.notEqual(record.childPid, process.pid); assert.equal(record.oldEpochRejectedBeforeCheckout, true);
  assert.equal((await stored(f)).revision, 1); note("restart", record);
});
