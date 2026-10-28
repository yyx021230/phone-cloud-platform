import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import pg from "pg";
import crypto from "node:crypto";
import { createBatchStore } from "./store.mjs";

// Opt-in only: point at a disposable local database created for this test.
test("PostgreSQL migration, exclusive lease, restart, nonce and result persistence", { skip: !process.env.XHS_BATCH_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.XHS_BATCH_TEST_DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.ok(url.pathname.startsWith("/xhs_batch_test_"));
  const pool = new pg.Pool({ connectionString: url.href, max: 4 });
  await pool.query(await fs.readFile(new URL("../../deploy/xhs-batch/schema.sql", import.meta.url), "utf8"));
  let store = await createBatchStore(pool);
  t.after(async () => { if (store) await store.close(); await pool.end(); });
  await assert.rejects(createBatchStore(pool), /already_running/);
  const id = crypto.randomUUID(), run = { runId: id, clientId: "fixture", status: "running", createdAt: new Date().toISOString(), items: [] };
  await store.set(`run/${id}`, run); await store.set(`result/${id}/0`, { data: { notes: [], complete: true } });
  assert.equal(await store.nonce("fixture", id, new Date(Date.now() + 600_000)), true);
  assert.equal(await store.nonce("fixture", id, new Date(Date.now() + 600_000)), false);
  assert.ok((await store.runs({ clientId: "fixture", active: true })).some(r => r.runId === id));
  await store.close(); store = null;
  store = await createBatchStore(pool);
  assert.deepEqual(await store.get(`run/${id}`), run);
  assert.equal(await store.nonce("fixture", id, new Date(Date.now() + 600_000)), false);
  assert.deepEqual((await store.get(`result/${id}/0`)).data.notes, []);
  assert.equal((await store.runs({ clientId: "different" })).length, 0);
  await store.set(`run/${id}`, { ...run, status: "completed" });
  assert.ok(!(await store.runs({ clientId: "fixture", active: true })).some(r => r.runId === id));
  // Only the lease in this disposable database is terminated, never a platform connection.
  await pool.query(`select pg_terminate_backend(pid) from pg_locks where locktype='advisory'
    and classid=1801417521 and objid=20261026 and granted
    and database=(select oid from pg_database where datname=current_database())`);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.throws(() => store.assertHealthy(), /lease_lost/);
  await assert.rejects(store.get(`run/${id}`), /lease_lost/);
});
