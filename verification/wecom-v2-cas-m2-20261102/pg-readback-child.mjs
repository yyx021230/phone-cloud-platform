// Only invoked by the gated private-PG integration fixture, never by the app.
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { ownedConfiguration, verifyOwnedServer } from "./owned-pg.mjs";
import { createWecomV2PostgresRepository } from "../../server/wecom-cleanup-v2-postgres.mjs";
const f = fixture("restart"), config = await ownedConfiguration(); let attempts = 0;
f.auth.serverEpoch = "new-child-epoch";
const repo = createWecomV2PostgresRepository({ ...f.providers, getPool: async () => { attempts++; throw Error("must_not_connect_for_old_epoch"); } });
await assert.rejects(repo.reconcileOperation("host", f.body), /obsolete_epoch/); assert.equal(attempts, 0);
const pool = new config.Pool(config.options);
try {
  await verifyOwnedServer(pool, config);
  const answer = await pool.query("SELECT revision,server_epoch FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1", [f.binding.obligationId]);
  assert.equal(answer.rows[0]?.revision, 1); assert.equal(answer.rows[0]?.server_epoch, f.binding.serverEpoch);
  console.log(JSON.stringify({ childPid: process.pid, oldEpochRejectedBeforeCheckout: true, revision: 1, originalEpochPreserved: true }));
} finally { await pool.end(); }
