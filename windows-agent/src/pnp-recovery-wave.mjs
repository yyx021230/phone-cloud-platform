function normalizedSerial(value) {
  return String(value || "").trim().toUpperCase();
}

function upstreamForSerial(upstreamBySerial, serial) {
  if (upstreamBySerial instanceof Map) {
    return String(upstreamBySerial.get(serial) || upstreamBySerial.get(normalizedSerial(serial)) || "").trim();
  }
  if (upstreamBySerial && typeof upstreamBySerial === "object") {
    return String(upstreamBySerial[serial] || upstreamBySerial[normalizedSerial(serial)] || "").trim();
  }
  return "";
}

export function selectIndependentPnpRecoveryTargets(serials, upstreamBySerial, limit = 1) {
  const maxTargets = Math.max(1, Number(limit) || 1);
  const selected = [];
  const seenSerials = new Set();
  const usedUpstreams = new Set();

  for (const value of Array.isArray(serials) ? serials : []) {
    const serial = String(value || "").trim();
    const key = normalizedSerial(serial);
    if (!key || seenSerials.has(key)) continue;
    seenSerials.add(key);

    // Unknown topology is deliberately one shared lane. This preserves the
    // old serial behavior when Windows cannot resolve the upstream hub.
    const upstream = upstreamForSerial(upstreamBySerial, serial);
    const upstreamKey = upstream ? upstream.toUpperCase() : "__UNKNOWN_UPSTREAM__";
    if (usedUpstreams.has(upstreamKey)) continue;

    selected.push(serial);
    usedUpstreams.add(upstreamKey);
    if (selected.length >= maxTargets) break;
  }

  return selected;
}

export function summarizePnpRecoveryBatchResults(results = [], selectedSerials = []) {
  const serials = Array.isArray(selectedSerials) ? selectedSerials : [];
  const outcomes = [];
  const internalFailures = [];

  for (const [index, result] of (Array.isArray(results) ? results : []).entries()) {
    const serial = String(serials[index] || "").trim();
    if (result?.status === "fulfilled") {
      if (result.value && typeof result.value === "object") outcomes.push(result.value);
      continue;
    }
    internalFailures.push({
      serial,
      error: String(result?.reason?.message || result?.reason || "unknown internal failure").slice(0, 300)
    });
  }

  const actionOutcomes = outcomes.filter((item) => item?.actionAttempted === true);
  return {
    outcomes,
    internalFailures,
    actionedSerials: actionOutcomes.map((item) => String(item.serial || "").trim()).filter(Boolean),
    attempted: actionOutcomes.length,
    failed: actionOutcomes.filter((item) => item.status === "action_failed").length,
    deferred: outcomes.filter((item) => ["blocked", "deferred"].includes(item.status)).length,
    skipped: outcomes.filter((item) => item.status === "skipped").length,
    quarantined: outcomes.filter((item) => item.status === "quarantined").length
  };
}

export function scopePnpRecoveryPlansForSafety(plannedTargets = [], safety = {}, normalLimit = 1) {
  const plans = Array.isArray(plannedTargets) ? plannedTargets : [];
  const rescueSerials = [...new Set((Array.isArray(safety.rescueSerials) ? safety.rescueSerials : [])
    .map(normalizedSerial)
    .filter(Boolean))];
  if (!safety.circuitOpen) {
    return {
      plans,
      maxTargets: Math.max(1, Number(normalLimit) || 1),
      rescue: false,
      rescueSerials: []
    };
  }
  const rescueKeys = new Set(rescueSerials);
  return {
    plans: plans.filter((item) => rescueKeys.has(normalizedSerial(item?.serial))),
    maxTargets: 1,
    rescue: true,
    rescueSerials
  };
}
