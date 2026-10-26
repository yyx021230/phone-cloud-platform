// A dedicated connection owns the scheduler lease. Losing it stops all dispatch.
export async function createBatchStore(pool) {
  const db = await pool.connect();
  let healthy = true;
  db.on("error", () => { healthy = false; });
  const assertHealthy = () => { if (!healthy) throw new Error("batch_store_lease_lost"); };
  try {
    const lock = await db.query("select pg_try_advisory_lock(1801417521, 20261026) as acquired");
    if (!lock.rows[0].acquired) throw new Error("batch_scheduler_already_running");
    await db.query("select record_key from phone_cloud_xhs_batch_records limit 0");
    await db.query("select nonce from phone_cloud_xhs_batch_nonces limit 0");
  } catch (error) { db.release(true); throw error; }
  const query = async (sql, args) => {
    assertHealthy();
    try { return await db.query(sql, args); }
    catch (error) { healthy = false; throw error; }
  };
  return {
    assertHealthy,
    async get(key) {
      return (await query("select data from phone_cloud_xhs_batch_records where record_key=$1", [key])).rows[0]?.data ?? null;
    },
    async set(key, data) {
      await query(`insert into phone_cloud_xhs_batch_records(record_key,data) values($1,$2::jsonb)
        on conflict(record_key) do update set data=excluded.data,updated_at=now()`, [key, JSON.stringify(data)]);
    },
    async list(prefix) {
      return (await query("select data from phone_cloud_xhs_batch_records where starts_with(record_key,$1) order by record_key", [prefix])).rows.map(r => r.data);
    },
    async runs({ clientId = null, active = false, limit = 50, offset = 0 } = {}) {
      return (await query(`select data from phone_cloud_xhs_batch_records
        where starts_with(record_key,'run/') and ($1::text is null or data->>'clientId'=$1)
        and (not $2::boolean or data->>'status' in ('running','needs_attention'))
        order by data->>'createdAt' desc,record_key limit $3 offset $4`, [clientId, active, limit, offset])).rows.map(r => r.data);
    },
    async nonce(clientId, nonce, expiresAt) {
      const result = await query(`insert into phone_cloud_xhs_batch_nonces values($1,$2,$3)
        on conflict do nothing returning nonce`, [clientId, nonce, expiresAt]);
      return result.rowCount === 1;
    },
    async pruneNonces(now) { await query("delete from phone_cloud_xhs_batch_nonces where expires_at < $1", [new Date(now)]); },
    async close() { healthy = false; db.release(true); }
  };
}
