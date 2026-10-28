// One-off operator repair, not a server endpoint or an Agent success report.
// Input contains private evidence and must be supplied on stdin, never committed.
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

export function manualResults(state, entries, {actor, at} = {}) {
  if (!actor || !Number.isFinite(Date.parse(at)) || !Array.isArray(entries) || !entries.length || entries.length > 4) throw Error('invalid_manual_repair');
  const next = structuredClone(state), seen = new Set(), before = [];
  for (const e of entries) {
    if (seen.has(e.lookupId) || !e.lookupId || !e.expectedQueryId || !/^1\d{10}$/.test(e.expectedPhoneNumber || '') || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 128 || /[\x00-\x1f\x7f]/.test(e.name) || !/^[a-f0-9]{64}$/.test(e.evidenceSha256 || '')) throw Error('invalid_manual_entry');
    seen.add(e.lookupId);
    const r = next.requests.find(x => x.lookupId === e.lookupId), cs = next.channels.filter(x => x.requestId === e.lookupId), c = cs[0];
    const last = r?.attempts?.at(-1);
    const detached = r?.status === 'queued' && !cs.length && !r.queryId && e.expectedSessionId && e.expectedDeviceId && Number.isInteger(e.expectedAttemptCount) && e.expectedAttemptCount > 0 && r.attempts.length === e.expectedAttemptCount && last.sessionId === e.expectedSessionId && last.deviceId === e.expectedDeviceId;
    const attached = cs.length === 1 && ['needs_recovery', 'waiting_human'].includes(r?.status) && ['recovery', 'human'].includes(c.phase) && !c.roundStopPreparationId && c.offlineHandoffAt === undefined && c.queryId === e.expectedQueryId && r.queryId === e.expectedQueryId;
    if (!r || (!attached && !detached) || r.purpose === 'readiness_probe' || r.cancelRequested || r.archived || r.phoneNumber !== e.expectedPhoneNumber) throw Error('manual_repair_state_changed');
    before.push({request: structuredClone(r), channel: c ? structuredClone(c) : null});
    r.name = e.name;
    r.status = 'succeeded';
    r.code = '';
    r.completedAt = at;
    r.manualResolution = {source: 'operator_verified_screenshot', actor, at, evidenceSha256: e.evidenceSha256, queryId: e.expectedQueryId};
    // Existing coordinator uses this flag to safely stop the physical attempt.
    // The business result is already terminal; stop ACK must not cancel it.
    if (c) {
      r.cancelRequested = true;
      r.cancelReason = 'lookup_manual_result_cleanup';
      delete c.readinessProof;
      delete c.readinessPriorityAt;
    }
    next.audits.push({action: 'lookup_manual_result_recorded', actor, at, lookupId: r.lookupId, deviceId: c?.deviceId || last.deviceId, queryId: e.expectedQueryId, evidenceSha256: e.evidenceSha256});
  }
  next.audits = next.audits.slice(-1000);
  next.revision = (state.revision || 0) + 1;
  return {next, before};
}

async function main() {
  const apply = process.argv.includes('--apply'), backupIndex = process.argv.indexOf('--backup');
  const backupPath = backupIndex >= 0 ? process.argv[backupIndex + 1] : '';
  if (apply && (!backupPath || !backupPath.startsWith('/'))) throw Error('absolute_backup_path_required');
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  if (!process.env.DATABASE_URL) throw Error('database_not_configured');
  const pg = createRequire(pathToFileURL(process.cwd() + '/package.json'))('pg');
  const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, ssl: /^(true|1)$/i.test(process.env.POSTGRES_SSL || '') ? {rejectUnauthorized: false} : false, max: 1});
  const db = await pool.connect(), key = process.env.POSTGRES_STATE_KEY || 'default';
  try {
    await db.query('begin');
    await db.query("set local lock_timeout='3s'");
    await db.query("set local statement_timeout='5s'");
    const rows = await db.query('select data from phone_cloud_managed_lookup where state_key=$1 for update', [key]);
    if (rows.rows.length !== 1) throw Error('managed_state_missing');
    const state = rows.rows[0].data, at = new Date().toISOString();
    const {next, before} = manualResults(state, payload.entries, {actor: payload.actor, at});
    for (const e of payload.entries) {
      const archived = await db.query('select lookup_id from phone_cloud_managed_lookup_results where state_key=$1 and lookup_id=$2', [key, e.lookupId]);
      if (archived.rows.length) throw Error('manual_result_already_archived');
    }
    const preview = {at, apply, count: before.length, previousRevision: state.revision, nextRevision: next.revision, orders: before.map(x => ({lookupId: x.request.lookupId, deviceNumber: x.channel?.deviceNumber, previousStatus: x.request.status, status: 'succeeded', cleanup: x.channel ? 'wait_for_stop_ack' : 'already_detached'}))};
    if (apply) {
      const file = await fs.open(backupPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({at, stateKey: key, revision: state.revision, before})); await file.sync(); } finally { await file.close(); }
      // No state replacement outside the row lock; concurrent unrelated work is
      // retained. The normal coordinator reloads this row for every transaction.
      await db.query('update phone_cloud_managed_lookup set data=$2::jsonb, updated_at=now() where state_key=$1', [key, JSON.stringify(next)]);
      await db.query('commit');
    } else await db.query('rollback');
    process.stdout.write(JSON.stringify(preview) + '\n');
  } catch (error) { await db.query('rollback').catch(() => {}); throw error; }
  finally { db.release(); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('manual_result_repair_failed; transaction not confirmed; inspect state before retry'); process.exitCode = 1; });
