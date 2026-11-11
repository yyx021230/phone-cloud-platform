// Unwired WeCom v2 preparation only. No storage, OS, clock, payload or release
// authority. Providers are privileged future server integration dependencies,
// not request fields: validating their shape cannot attest their provenance.
import { isDeepStrictEqual } from "node:util";

const BINDING = ["version", "obligationId", "originalTaskId", "executionId", "deviceId", "serial", "agentId", "appSlot", "androidUser", "nonce", "serverEpoch", "agentInstanceId", "handshakeNonce"];
const HOST = ["role", "pid", "createdAt", "creationToken", "machineId"];
const STATE = ["version", "binding", "phase", "revision", "fence", "parentHost", "readerHost", "hostOperationId", "closeOperationId", "closeEventId", "operations"];
const BASE_REQUEST = ["binding", "operationId", "expectedRevision", "parentHost", "readerHost", "readyNonce"];
const PHASES = ["awaiting_host", "awaiting_host_close", "awaiting_verification"];
const error = code => { throw new Error(`wecom_v2_${code}`); };
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function freeze(value) {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function binding(value) {
  if (!exact(value, BINDING) || value.version !== 2
    || !["obligationId", "originalTaskId", "executionId", "agentId", "nonce", "serverEpoch", "agentInstanceId", "handshakeNonce"].every(key => id(value[key]))
    || typeof value.serial !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.serial)
    || value.deviceId !== `adb:${value.serial}` || !["main", "clone"].includes(value.appSlot)
    || value.androidUser !== (value.appSlot === "main" ? 0 : 999)) error("binding_invalid");
  return Object.fromEntries(BINDING.map(key => [key, value[key]]));
}
function host(value, role) {
  if (!exact(value, HOST) || value.role !== role || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 0xffffffff
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
    || typeof value.creationToken !== "string" || !/^0x1\.[0-9a-f]{13}p[+-]\d{1,4}$/.test(value.creationToken)
    || typeof value.machineId !== "string" || !/^[a-f0-9]{64}$/.test(value.machineId)) error("host_invalid");
  const match = /^0x1\.([0-9a-f]{13})p([+-]\d{1,4})$/.exec(value.creationToken);
  const born = (1 + Number.parseInt(match[1], 16) / 2 ** 52) * 2 ** Number(match[2]);
  // This is SAME-host audit consistency, matching the existing Agent's 1.001ms
  // tolerance. Never order either value against cloud wall or another host.
  if (!Number.isFinite(born) || born <= 0 || Math.abs(born * 1000 - Date.parse(value.createdAt)) > 1.001) error("host_invalid");
  return Object.fromEntries(HOST.map(key => [key, value[key]]));
}
function request(action, value) {
  if (!["host", "host-closed"].includes(action)) error("action_invalid");
  if (!exact(value, action === "host" ? BASE_REQUEST : [...BASE_REQUEST, "closeEventId"])
    || !id(value.operationId) || !id(value.readyNonce) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
    || (action === "host-closed" && !id(value.closeEventId))) error("request_invalid");
  const parentHost = host(value.parentHost, "agent"), readerHost = host(value.readerHost, "reader");
  if (parentHost.pid === readerHost.pid || parentHost.machineId !== readerHost.machineId) error("host_invalid");
  return { binding: binding(value.binding), operationId: value.operationId, expectedRevision: value.expectedRevision,
    parentHost, readerHost, readyNonce: value.readyNonce, ...(action === "host-closed" ? { closeEventId: value.closeEventId } : {}) };
}
function reply(operationId, revision) {
  return { operationId, preparedRevision: revision, phase: PHASES[revision], durable: false, requiresPersistence: true };
}
function initial(value) {
  return { version: 2, binding: binding(value), phase: PHASES[0], revision: 0, fence: "held",
    parentHost: null, readerHost: null, hostOperationId: null, closeOperationId: null, closeEventId: null, operations: [] };
}
function advance(current, action, body) {
  if (!isDeepStrictEqual(current.binding, body.binding) || body.readyNonce !== current.binding.handshakeNonce) error("binding_mismatch");
  const found = current.operations.find(op => op.request.operationId === body.operationId);
  if (found) {
    if (found.action !== action || !isDeepStrictEqual(found.request, body)) error("operation_conflict");
    return { nextState: structuredClone(current), replyCandidate: structuredClone(found.replyCandidate), reused: true };
  }
  if (body.expectedRevision !== current.revision) error("revision_conflict");
  if (action === "host" && current.revision !== 0) error("phase_conflict");
  if (action === "host-closed" && current.revision !== 1) error("phase_conflict");
  if (current.revision === 1 && (!isDeepStrictEqual(current.parentHost, body.parentHost)
    || !isDeepStrictEqual(current.readerHost, body.readerHost))) error("host_mismatch");
  const nextState = structuredClone(current), revision = current.revision + 1;
  nextState.revision = revision; nextState.phase = PHASES[revision];
  if (action === "host") {
    nextState.parentHost = body.parentHost; nextState.readerHost = body.readerHost; nextState.hostOperationId = body.operationId;
  } else { nextState.closeOperationId = body.operationId; nextState.closeEventId = body.closeEventId; }
  const replyCandidate = reply(body.operationId, revision);
  nextState.operations.push({ action, request: structuredClone(body), replyCandidate: structuredClone(replyCandidate) });
  return { nextState, replyCandidate, reused: false };
}
function state(value) {
  if (!exact(value, STATE) || value.version !== 2 || value.fence !== "held" || !Array.isArray(value.operations)
    || value.operations.length > 2 || value.revision !== value.operations.length) error("state_invalid");
  // Structural rehydration only, not proof that a database committed this row.
  let reconstructed = initial(value.binding);
  for (const op of value.operations) {
    if (!exact(op, ["action", "request", "replyCandidate"])) error("state_invalid");
    const body = request(op.action, op.request), prepared = advance(reconstructed, op.action, body);
    if (prepared.reused || !isDeepStrictEqual(op.replyCandidate, prepared.replyCandidate)) error("state_invalid");
    reconstructed = prepared.nextState;
  }
  if (!isDeepStrictEqual(reconstructed, value)) error("state_invalid");
  return reconstructed;
}

export function createWecomV2HostState(value) { return freeze(initial(value)); }
// Structural helpers only; neither accepts nor manufactures OS authority.
export function normalizeWecomV2HostRequest(action, value) { return freeze(request(action, value)); }
export function validateWecomV2HostState(value) { return freeze(state(value)); }

export function createWecomV2HostPreparer({ readAuthenticatedBinding, readParentInstanceFacts } = {}) {
  if (typeof readAuthenticatedBinding !== "function" || typeof readParentInstanceFacts !== "function") error("trusted_providers_required");
  // No default provider. Future server authentication and real parent/spawn/
  // close observations must supply these closures; this leaf creates none.
  return (current, action, input) => {
    const currentState = state(current), body = request(action, input);
    const authenticated = binding(readAuthenticatedBinding());
    if (!isDeepStrictEqual(authenticated, currentState.binding) || !isDeepStrictEqual(authenticated, body.binding)) error("context_mismatch");
    const facts = readParentInstanceFacts();
    if (!exact(facts, ["agentInstanceId", "parentHost", "readerHost", "spawnNonce", "closeEventId"])
      || facts.agentInstanceId !== authenticated.agentInstanceId || facts.spawnNonce !== authenticated.handshakeNonce
      || (facts.closeEventId !== null && !id(facts.closeEventId))) error("instance_unconfirmed");
    if (!isDeepStrictEqual(host(facts.parentHost, "agent"), body.parentHost)
      || !isDeepStrictEqual(host(facts.readerHost, "reader"), body.readerHost)) error("host_mismatch");
    if (action === "host-closed" && (facts.closeEventId === null || facts.closeEventId !== body.closeEventId)) error("close_unconfirmed");
    return freeze(advance(currentState, action, body));
  };
}
