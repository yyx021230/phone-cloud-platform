// Mirrored in server/wecom-diagnostics.mjs; deployment-shape test requires byte equality.
export const WECOM_PHASES = Object.freeze([
  "configuration", "adb_identity", "device_preflight", "screen_prepare",
  "poco_launch", "poco_health", "wecom_launch", "rpc_setup",
  "startup_guards", "foreground_wait", "selector_observe", "selector_click", "home_navigation",
  "recipient_search", "remark_edit", "remark_save", "send_claim",
  "invitation_send", "cleanup", "complete"
]);
export const WECOM_DIAGNOSTIC_PREFIX = "WECOM_DIAGNOSTIC ";
const phases = new Set(WECOM_PHASES);
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const transportReasons=new Set(['connect_timeout','read_timeout','timeout','connection_closed','transport_disconnected','peer_verification_failed','connection_error','unknown']);
const transportTypes=new Set(['TimeoutError','ReadTimeout','ReadTimeoutError','ConnectTimeout','ConnectTimeoutError','RpcTimeoutException','ConnectionError','ConnectionResetError','ConnectionAbortedError','BrokenPipeError','TransportDisconnected','PeerDenied','PeerUnavailable','PermissionError','OSError','URLError','HTTPError','OtherError']);

export function wecomTransportFailure(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['reason','errorType','elapsedMs','errno','winerror'].includes(k))
    ||!transportReasons.has(value.reason)||!transportTypes.has(value.errorType)||!integer(value.elapsedMs,900000))return null;
  for(const k of ['errno','winerror'])if(value[k]!==undefined&&(!Number.isSafeInteger(value[k])||Math.abs(value[k])>200000))return null;
  return {reason:value.reason,errorType:value.errorType,elapsedMs:value.elapsedMs,
    ...(value.errno===undefined?{}:{errno:value.errno}),...(value.winerror===undefined?{}:{winerror:value.winerror})};
}

export function wecomProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(k => !["version", "step", "phase", "state", "elapsedMs", "cleanupConfirmed"].includes(k))
    || value.version !== 1 || !phases.has(value.phase) || !["begin", "end", "error"].includes(value.state)
    || !integer(value.step, 10000) || !integer(value.elapsedMs, 900000)
    || (value.cleanupConfirmed !== undefined && !(value.phase === "cleanup" && value.state === "end" && typeof value.cleanupConfirmed === "boolean"))) return null;
  return { version: 1, step: value.step, phase: value.phase, state: value.state, elapsedMs: value.elapsedMs,
    ...(value.cleanupConfirmed === undefined ? {} : { cleanupConfirmed: value.cleanupConfirmed }) };
}

export function wecomExecution(value) {
  if (!value || value.version !== 1 || !phases.has(value.phase)
    || !(value.failurePhase === "" || phases.has(value.failurePhase)) || !integer(value.elapsedMs, 900000)
    || ![true, false, null].includes(value.cleanupConfirmed) || !Array.isArray(value.events) || value.events.length > 24) return null;
  const events = value.events.map(wecomProgress);
  if (events.some(e => !e) || events.some((e, i) => i > 0 && (e.step <= events[i-1].step || e.elapsedMs < events[i-1].elapsedMs))) return null;
  const transportFailure=wecomTransportFailure(value.transportFailure);
  return { version: 1, phase: value.phase, failurePhase: value.failurePhase, elapsedMs: value.elapsedMs,
    cleanupConfirmed: value.cleanupConfirmed, events,...(transportFailure?{transportFailure}:{}) };
}

export function progressSummary(events) {
  if (!events.length) return null;
  const last = events.at(-1), failed = events.find(e => e.state === "error" && e.phase !== "cleanup");
  const cleanup = events.findLast(e => typeof e.cleanupConfirmed === "boolean");
  return { version: 1, phase: last.phase, failurePhase: failed?.phase || "", elapsedMs: last.elapsedMs,
    cleanupConfirmed: cleanup?.cleanupConfirmed ?? null, events: events.slice(-24) };
}
