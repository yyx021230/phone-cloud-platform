import { Client } from "pg";
import { normalizeAccountName } from "./build-xhs-id-migration.mjs";

function required(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`missing_${field}`);
  return text;
}

export function validateXhsMigrationReport(report = {}) {
  const summary = report?.summary || {};
  const migrated = Array.isArray(report?.migrated) ? report.migrated : [];
  if (Number(summary.platformBindings || 0) <= 0) throw new Error("xhs_migration_empty");
  if (Number(summary.migrated || 0) !== Number(summary.platformBindings || 0)) {
    throw new Error("xhs_migration_incomplete");
  }
  if (migrated.length !== Number(summary.migrated || 0)) throw new Error("xhs_migration_count_mismatch");
  if (Number(summary.unresolved || 0) || Number(summary.ambiguous || 0) || Number(summary.duplicateIds || 0)) {
    throw new Error("xhs_migration_report_has_conflicts");
  }

  const slots = new Set();
  const ids = new Set();
  for (const item of migrated) {
    const deviceId = required(item.deviceId, "device_id");
    const appSlot = required(item.appSlot, "app_slot");
    required(item.accountName, "account_name");
    const xhsId = required(item.xhsId, "xhs_id");
    const slotKey = `${deviceId}\u0000${appSlot}`;
    if (slots.has(slotKey)) throw new Error("xhs_migration_duplicate_slot");
    slots.add(slotKey);
    const idKey = xhsId.toLowerCase();
    if (ids.has(idKey)) throw new Error("xhs_migration_duplicate_id");
    ids.add(idKey);
  }
  return { platformBindings: migrated.length, migrated };
}

export function applyXhsMigrationToDeviceRows(deviceRows = [], report = {}) {
  const validated = validateXhsMigrationReport(report);
  const mapping = new Map(validated.migrated.map((item) => [
    `${String(item.deviceId).trim()}\u0000${String(item.appSlot).trim()}`,
    item
  ]));
  let matched = 0;
  let changedDevices = 0;
  const rows = (Array.isArray(deviceRows) ? deviceRows : []).map((row) => {
    const deviceId = required(row?.device_id, "database_device_id");
    const data = structuredClone(row?.data || {});
    const accounts = Array.isArray(data.xhsAccounts) ? data.xhsAccounts : [];
    let changed = false;
    data.xhsAccounts = accounts.map((account) => {
      const appSlot = String(account?.appSlot || "").trim();
      const migration = mapping.get(`${deviceId}\u0000${appSlot}`);
      if (!migration) return account;
      if (normalizeAccountName(account?.accountName) !== normalizeAccountName(migration.accountName)) {
        throw new Error(`xhs_migration_account_changed:${deviceId}:${appSlot}`);
      }
      const currentId = String(account?.xhsId || "").trim();
      if (currentId && currentId.toLowerCase() !== String(migration.xhsId).trim().toLowerCase()) {
        throw new Error(`xhs_migration_existing_id_conflict:${deviceId}:${appSlot}`);
      }
      matched += 1;
      if (currentId === String(migration.xhsId).trim()) return account;
      changed = true;
      return { ...account, xhsId: String(migration.xhsId).trim() };
    });
    if (changed) changedDevices += 1;
    return { device_id: deviceId, data, changed };
  });

  if (matched !== validated.platformBindings) {
    throw new Error(`xhs_migration_slot_match_mismatch:${matched}/${validated.platformBindings}`);
  }

  const ids = new Map();
  let configured = 0;
  for (const row of rows) {
    for (const account of Array.isArray(row.data?.xhsAccounts) ? row.data.xhsAccounts : []) {
      if (!String(account?.accountName || "").trim()) continue;
      configured += 1;
      const xhsId = required(account?.xhsId, "configured_xhs_id");
      const key = xhsId.toLowerCase();
      if (ids.has(key)) throw new Error(`xhs_migration_global_id_conflict:${row.device_id}`);
      ids.set(key, row.device_id);
    }
  }
  if (configured !== validated.platformBindings) {
    throw new Error(`xhs_migration_configured_count_mismatch:${configured}/${validated.platformBindings}`);
  }

  return {
    rows,
    summary: {
      configured,
      matched,
      changedDevices,
      uniqueIds: ids.size
    }
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL_required");
  const report = JSON.parse(await readStdin());
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('phone-cloud-xhs-id-v1'))");
    const result = await client.query("select device_id, data from phone_cloud_devices order by device_id for update");
    const migration = applyXhsMigrationToDeviceRows(result.rows, report);
    for (const row of migration.rows.filter((item) => item.changed)) {
      await client.query(
        "update phone_cloud_devices set data = $2::jsonb, updated_at = now() where device_id = $1",
        [row.device_id, JSON.stringify(row.data)]
      );
    }
    if (apply) await client.query("commit");
    else await client.query("rollback");
    console.log(JSON.stringify({ mode: apply ? "applied" : "dry_run", ...migration.summary }));
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
