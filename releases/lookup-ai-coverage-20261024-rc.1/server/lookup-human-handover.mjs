import crypto from "node:crypto";
import { resumableLookupHumanVerificationResult } from "./automation-center.mjs";

export function lookupHumanChallenge(session) {
  const result = resumableLookupHumanVerificationResult(session);
  if (!result?.resultId) return "";
  return crypto.createHash("sha256").update(JSON.stringify([
    session.sessionId, result.resultId, result.updatedAt || result.createdAt || ""
  ])).digest("hex");
}

// Leases use the server clock. A late dump, duplicate POST or a different
// screen session cannot supply either of the two required clear observations.
export function createLookupHumanHandover({ targets, resume, observeManaged, now = Date.now }) {
  const leases = new Map();
  const observations = new Map();
  const claimed = new Map();
  function list(agentId) {
    const time = now();
    for (const [id, lease] of leases) if (time - lease.issuedAt > 30_000) leases.delete(id);
    const current = targets(agentId);
    const keys = new Set(current.map((target) => target.challengeId));
    for (const [key, ownerAgentId] of claimed) if (ownerAgentId === agentId && !keys.has(key)) claimed.delete(key);
    for (const [key, observation] of observations) {
      if (observation.agentId === agentId && !keys.has(key)) observations.delete(key);
    }
    return current.filter((target) => !claimed.has(target.challengeId)).map((target) => {
      const probeId = crypto.randomUUID();
      leases.set(probeId, { ...target, agentId, issuedAt: time });
      while (leases.size > 500) leases.delete(leases.keys().next().value);
      return { ...target, probeId };
    });
  }
  async function report(agentId, input = {}) {
    const lease = leases.get(String(input.probeId || ""));
    if (!lease || lease.agentId !== agentId) return { accepted: false, reason: "probe_stale" };
    leases.delete(input.probeId);
    const target = targets(agentId).find((item) => item.challengeId === lease.challengeId);
    if (claimed.has(lease.challengeId) || now() - lease.issuedAt > 30_000 || !target
      || target.screenSessionId !== lease.screenSessionId
      || target.adbSerial !== lease.adbSerial || target.deviceId !== lease.deviceId) {
      return { accepted: false, reason: "probe_stale" };
    }
    const previous = observations.get(lease.challengeId);
    if (previous && lease.issuedAt <= previous.issuedAt) return { accepted: false, reason: "probe_out_of_order" };
    const actionable = ['search_ready','account_limited','login_required','recoverable_page'];
    const clear = input.state === 'search_ready' || target.managedLookup && actionable.includes(input.state);
    const consecutive = clear && previous?.clear && input.state === previous.state
      && previous.screenSessionId === lease.screenSessionId
      && lease.issuedAt - previous.issuedAt >= 2_000
      && lease.issuedAt - previous.issuedAt <= 30_000;
    observations.set(lease.challengeId, {
      clear, state:input.state, issuedAt: lease.issuedAt, agentId, screenSessionId: lease.screenSessionId
    });
    if (target.managedLookup && observeManaged) {
      const state = ['search_ready','present','screen_off','account_limited','login_required','recoverable_page','loading','network_busy'].includes(input.state) ? input.state : 'unknown';
      const reasons = new Set(['verification_present', 'search_ready', 'screen_off', 'device_busy', 'power_unavailable', 'read_failed', 'page_unknown','account_limited','login_required','recoverable_page','loading','network_busy']);
      const fallback = state === 'present' ? 'verification_present' : state === 'search_ready' ? 'search_ready' : state === 'screen_off' ? 'screen_off' : 'page_unknown';
      await observeManaged(target, {state, confirmed: Boolean(consecutive),
        reason: reasons.has(input.reason) ? input.reason : fallback,
        readDurationMs: Number.isFinite(input.readDurationMs) ? Math.min(30000, Math.max(0, Math.round(input.readDurationMs))) : 0});
      return { accepted: true, resumed: false };
    }
    if (!consecutive) return { accepted: true, resumed: false };
    // Claim before entering asynchronous persistence: concurrent reports can
    // never launch two retries of the same original result.
    observations.delete(lease.challengeId);
    claimed.set(lease.challengeId, agentId);
    for (const [id, item] of leases) if (item.challengeId === lease.challengeId) leases.delete(id);
    let resumed;
    try { resumed = await resume(target); }
    catch (e) { if(target.managedLookup) claimed.delete(lease.challengeId);throw e; }
    if(target.managedLookup && resumed!==true) claimed.delete(lease.challengeId);
    return { accepted: true, resumed: resumed === true };
  }
  return { list, report };
}

// Recover the managed request association from the exact original query when
// the session result projection omitted it. Never borrow another phone/client.
export function lookupHumanResumeReferences(session,result,jobs=[]) {
  if(session.source!=='managed-api'||result.phase==='start')return {};
  const matching=jobs.filter(j=>j.sessionId===session.sessionId&&j.deviceId===session.deviceId
    &&j.source===session.source&&j.clientId===session.clientId&&j.kind==='alipay_name_query'
    &&(j.resultId||j.jobId)===result.resultId&&j.phoneNumber===result.phoneNumber&&j.clientReference);
  const refs=[...new Set(matching.map(j=>j.clientReference))];
  if(refs.length!==1||result.clientReference&&result.clientReference!==refs[0])return {};
  const source=matching.find(j=>j.clientReference===refs[0]);
  return {clientReference:refs[0],consentReference:result.consentReference||source.consentReference||''};
}
