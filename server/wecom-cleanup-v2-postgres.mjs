// Unwired v2 ledger only. Explicit providers/pool; no DDL, env, routes, clock,
// physical locks or permission to execute/release. A stored candidate is no ACK.
import { isDeepStrictEqual } from "node:util";
import { createWecomV2HostState, createWecomV2HostPreparer,
  normalizeWecomV2HostRequest, validateWecomV2HostState } from "./wecom-cleanup-v2-host.mjs";

const COLUMNS = "obligation_id, server_epoch, revision, host_operation_id, close_operation_id, protocol_state";
const SELECT = `SELECT ${COLUMNS} FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1 FOR UPDATE`;
const INSERT = `INSERT INTO phone_cloud_wecom_cleanup_v2 (${COLUMNS})
  VALUES ($1,$2,0,NULL,NULL,$3::jsonb) ON CONFLICT (obligation_id) DO NOTHING`;
const UPDATE = `UPDATE phone_cloud_wecom_cleanup_v2
  SET revision=$4, host_operation_id=$5, close_operation_id=$6, protocol_state=$7::jsonb
  WHERE obligation_id=$1 AND server_epoch=$2 AND revision=$3 RETURNING ${COLUMNS}`;
const protocolErrors = new WeakSet();
function problem(code) { const e = new Error(`wecom_v2_${code}`); protocolErrors.add(e); return e; }
function frozen(value) {
  if (value && typeof value === "object") { for (const v of Object.values(value)) frozen(v); Object.freeze(value); }
  return value;
}
function result(storageStatus, { state = null, operation = null, commitKnown = false, reason = "" } = {}) {
  return frozen({ storageStatus, commitKnown, reason, protocolPermit: false, fence: "held",
    revision: state?.revision ?? null, storedOperation: operation ? structuredClone(operation) : null });
}
function rowState(row) {
  if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== COLUMNS.split(", ").sort().join(",")) throw problem("row_invalid");
  const value = validateWecomV2HostState(row.protocol_state);
  if (row.obligation_id !== value.binding.obligationId || row.server_epoch !== value.binding.serverEpoch
    || row.revision !== value.revision || row.host_operation_id !== value.hostOperationId
    || row.close_operation_id !== value.closeOperationId) throw problem("row_invalid");
  return value;
}
function operationIn(state, action, body) {
  const found = state.operations.find(op => op.request.operationId === body.operationId);
  if (found && (found.action !== action || !isDeepStrictEqual(found.request, body))) throw problem("operation_conflict");
  return found || null;
}

export function createWecomV2PostgresRepository({ getPool, readAuthenticatedBinding, readParentInstanceFacts } = {}) {
  if (![getPool, readAuthenticatedBinding, readParentInstanceFacts].every(v => typeof v === "function")) throw problem("trusted_providers_required");
  const prepare = createWecomV2HostPreparer({ readAuthenticatedBinding, readParentInstanceFacts });
  function authenticated() {
    try { return createWecomV2HostState(readAuthenticatedBinding()).binding; }
    catch { throw problem("context_unconfirmed"); }
  }
  function requireContext(expected) {
    const actual = authenticated();
    if (!isDeepStrictEqual(actual, expected)) throw problem(actual.serverEpoch !== expected.serverEpoch ? "obsolete_epoch" : "context_mismatch");
  }
  function precheck(action, input) {
    const body = normalizeWecomV2HostRequest(action, input);
    requireContext(body.binding); // Invalid input/auth never connects to PG.
    if (body.readyNonce !== body.binding.handshakeNonce) throw problem("binding_mismatch");
    return body;
  }
  function afterCommit(expected, value) {
    try { requireContext(expected); return value; }
    catch (error) {
      return frozen({ ...value, storageStatus: error.message === "wecom_v2_obsolete_epoch" ? "obsolete_epoch" : "obsolete_context",
        reason: "authentication_changed_after_storage", protocolPermit: false });
    }
  }
  async function selected(client, expected) {
    const answer = await client.query(SELECT, [expected.obligationId]);
    if (answer.rowCount === 0 && answer.rows?.length === 0) return null;
    if (answer.rowCount !== 1 || answer.rows?.length !== 1) throw problem("row_invalid");
    const value = rowState(answer.rows[0]);
    if (!isDeepStrictEqual(value.binding, expected)) throw problem(value.binding.serverEpoch !== expected.serverEpoch ? "obsolete_epoch" : "binding_mismatch");
    return value;
  }
  async function transaction(expected, work) {
    let client = null, began = false, commitAttempted = false;
    let firstFailure = null, listening = false;
    const remember = error => { firstFailure ||= error instanceof Error ? error : new Error("wecom_v2_client_error_unconfirmed"); };
    // pg emits checked-out client errors before its query Promise rejects.
    // This observer records loss of trust; every following boundary enforces it.
    const onClientError = error => { remember(error); };
    const query = async (text, values, committing = false) => {
      if (firstFailure) throw firstFailure;
      const current = client;
      if (committing) commitAttempted = true; // Only when COMMIT is actually invoked.
      let answer;
      try { answer = await current.query(text, values); }
      catch (error) { remember(error); throw firstFailure; }
      if (firstFailure) throw firstFailure;
      return answer;
    };
    const owned = { query: (text, values) => query(text, values) };
    const retire = destroy => {
      if (!client) return;
      const old = client; client = null;
      if (listening) { old.removeListener("error", onClientError); listening = false; }
      // Passing an Error destroys the pg-pool client instead of returning it.
      old.release(destroy ? firstFailure || new Error("wecom_v2_connection_retired") : undefined);
    };
    try {
      const pool = await getPool();
      requireContext(expected); // getPool may yield; recheck before checkout.
      client = await pool.connect();
      if (typeof client.on !== "function" || typeof client.removeListener !== "function") throw new Error("client_events_unconfirmed");
      client.on("error", onClientError); listening = true;
      requireContext(expected);
      await query("BEGIN ISOLATION LEVEL READ COMMITTED"); began = true;
      await query("SET LOCAL lock_timeout = '2000ms'");
      await query("SET LOCAL statement_timeout = '3000ms'");
      await query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
      const value = await work(owned);
      requireContext(expected);
      const committed = await query("COMMIT", undefined, true);
      // An aborted PG transaction can answer COMMIT with the ROLLBACK tag.
      if (firstFailure) throw firstFailure;
      if (committed?.command !== "COMMIT") throw new Error("commit_not_confirmed");
      retire(false);
      return { confirmed: true, value: afterCommit(expected, value) };
    } catch (error) {
      if (commitAttempted) {
        // No ROLLBACK inference. Release/destroy BEFORE independent checkout,
        // including max:1 pools; never reuse this connection to reconcile.
        retire(true);
        return { confirmed: false, commitUnknown: true };
      }
      if (firstFailure) retire(true); // No further SQL on an untrusted client.
      else if (client && began) {
        try { const answer = await query("ROLLBACK"); retire(answer?.command !== "ROLLBACK"); }
        catch { retire(true); }
      } else retire(true);
      if (protocolErrors.has(error)) throw error;
      return { confirmed: false, commitUnknown: false };
    } finally { retire(true); }
  }
  async function reconcile(expected, action = null, body = null) {
    // Does not replay INSERT/UPDATE, replace nonce, restamp epoch or loop.
    try {
      requireContext(expected);
      const attempt = await transaction(expected, async client => {
        const state = await selected(client, expected);
        if (!state) return result("unknown", { reason: "row_not_visible" });
        const operation = action === null ? null : operationIn(state, action, body);
        if (action !== null && !operation) return result("unknown", { state, reason: "operation_not_visible" });
        return result("committed_reconciled", { state, operation, commitKnown: true });
      });
      return attempt.confirmed ? attempt.value : result("unknown", { reason: "reconciliation_unconfirmed" });
    } catch (error) {
      if (protocolErrors.has(error)) {
        const reason = error.message.replace("wecom_v2_", "");
        const status = reason === "obsolete_epoch" ? "obsolete_epoch"
          : ["operation_conflict", "binding_mismatch"].includes(reason) ? "conflict" : "unknown";
        return result(status, { reason });
      }
      return result("unknown", { reason: "reconciliation_unconfirmed" });
    }
  }
  return Object.freeze({
    async createPending(input) {
      const initial = createWecomV2HostState(input), expected = initial.binding;
      requireContext(expected);
      const attempt = await transaction(expected, async client => {
        await client.query(INSERT, [expected.obligationId, expected.serverEpoch, JSON.stringify(initial)]);
        const state = await selected(client, expected);
        if (!state) throw problem("row_invalid");
        return result("committed", { state, commitKnown: true });
      });
      if (attempt.confirmed) return attempt.value;
      if (attempt.commitUnknown) return reconcile(expected);
      return result("unknown", { reason: "storage_unavailable" });
    },
    async commitHostOperation(action, input) {
      const body = precheck(action, input), expected = body.binding;
      const attempt = await transaction(expected, async client => {
        const state = await selected(client, expected);
        if (!state) return result("unknown", { reason: "row_not_visible" });
        const existing = operationIn(state, action, body);
        if (existing) return result("committed", { state, operation: existing, commitKnown: true });
        let prepared;
        try { prepared = prepare(state, action, body); }
        catch (error) {
          const match = /^wecom_v2_(binding_invalid|host_invalid|request_invalid|binding_mismatch|operation_conflict|revision_conflict|phase_conflict|state_invalid|context_mismatch|instance_unconfirmed|host_mismatch|close_unconfirmed)$/.exec(error?.message || "");
          throw problem(match ? match[1] : "host_unconfirmed");
        }
        requireContext(expected);
        const next = prepared.nextState;
        const changed = await client.query(UPDATE, [expected.obligationId, expected.serverEpoch, state.revision,
          next.revision, next.hostOperationId, next.closeOperationId, JSON.stringify(next)]);
        if (changed.rowCount !== 1 || changed.rows?.length !== 1) throw problem("revision_conflict");
        const returned = rowState(changed.rows[0]);
        if (!isDeepStrictEqual(returned, next)) throw problem("row_invalid");
        return result("committed", { state: next, operation: operationIn(next, action, body), commitKnown: true });
      });
      if (attempt.confirmed) return attempt.value;
      if (attempt.commitUnknown) return reconcile(expected, action, body);
      return result("unknown", { reason: "storage_unavailable" });
    },
    async reconcileOperation(action, input) {
      const body = precheck(action, input);
      return reconcile(body.binding, action, body);
    }
  });
}
