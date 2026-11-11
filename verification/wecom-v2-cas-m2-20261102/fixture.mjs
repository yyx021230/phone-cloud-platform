// Synthetic identities only. No OS/clock/storage attestation or connections.
import { createWecomV2HostState, createWecomV2HostPreparer } from "../../server/wecom-cleanup-v2-host.mjs";

function birth(ms) {
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, ms / 1000);
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n) - 1023;
  return { createdAt: new Date(ms).toISOString(), creationToken: `0x1.${(bits & ((1n << 52n) - 1n)).toString(16).padStart(13, "0")}p+${exponent}` };
}
export function fixture(suffix = "one") {
  const binding = { version: 2, obligationId: `duty-${suffix}`, originalTaskId: `task-${suffix}`, executionId: `exec-${suffix}`,
    deviceId: `adb:fixture-${suffix}`, serial: `fixture-${suffix}`, agentId: "fixture-agent", appSlot: "main", androidUser: 0,
    nonce: `binding-nonce-${suffix}`, serverEpoch: "fixture-server-epoch", agentInstanceId: "fixture-parent-instance", handshakeNonce: `spawn-${suffix}` };
  const parentHost = { role: "agent", pid: 100, ...birth(Date.parse("2026-11-02T00:00:00.000Z")), machineId: "a".repeat(64) };
  const readerHost = { ...parentHost, role: "reader", pid: 104, ...birth(Date.parse("2026-11-02T00:00:00.001Z")) };
  const auth = structuredClone(binding), facts = { agentInstanceId: binding.agentInstanceId, parentHost, readerHost, spawnNonce: binding.handshakeNonce, closeEventId: null };
  const providers = { readAuthenticatedBinding: () => auth, readParentInstanceFacts: () => facts };
  const body = { binding: structuredClone(binding), operationId: `host-${suffix}`, expectedRevision: 0, parentHost: structuredClone(parentHost), readerHost: structuredClone(readerHost), readyNonce: binding.handshakeNonce };
  const initial = createWecomV2HostState(binding);
  const prepare = createWecomV2HostPreparer(providers);
  return { binding, auth, facts, providers, body, initial, prepare,
    closeBody: () => ({ ...structuredClone(body), operationId: `close-${suffix}`, expectedRevision: 1, closeEventId: `close-event-${suffix}` }) };
}
export function row(state) {
  return { obligation_id: state.binding.obligationId, server_epoch: state.binding.serverEpoch, revision: state.revision,
    host_operation_id: state.hostOperationId, close_operation_id: state.closeOperationId, protocol_state: structuredClone(state) };
}
