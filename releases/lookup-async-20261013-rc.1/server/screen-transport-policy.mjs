const POLICY_FIELDS = Object.freeze({
  maxSize: { type: "number", min: 480, max: 2_160 },
  maxFps: { type: "number", min: 5, max: 60 },
  videoBitRate: { type: "number", min: 500_000, max: 12_000_000 },
  videoEncoder: { type: "string", minLength: 1, maxLength: 128, pattern: /^[A-Za-z0-9._-]+$/ },
  encoderBitrateMode: { type: "number", values: [1, 2] },
  iFrameIntervalSeconds: { type: "number", min: 1, max: 10 },
  realtimeQueueLatencyMs: { type: "number", min: 100, max: 1_500 },
  sourceRecoveryEnabled: { type: "boolean" },
  sourceRecoveryMaxAttempts: { type: "number", min: 1, max: 8 },
  sourceRecoveryWindowSeconds: { type: "number", min: 10, max: 300 },
  viewerKeyframeResetEnabled: { type: "boolean" },
  keyframeRecoveryCooldownMs: { type: "number", min: 500, max: 10_000 },
  transportPacingBitRate: { type: "number", min: 2_000_000, max: 48_000_000 },
  transportPacketsPerBurst: { type: "number", min: 1, max: 8 },
  transportAdaptivePacing: { type: "boolean" },
  transportReceiverFeedback: { type: "boolean" },
  transportReceiverStableHoldMs: { type: "number", min: 5_000, max: 60_000 }
});

export function defaultScreenTransportPolicy() {
  return {
    revision: 0,
    updatedAt: "",
    updatedBy: "",
    defaults: {},
    devices: {}
  };
}

export function normalizeScreenTransportPolicy(input = {}, metadata = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidPolicy("screen_transport_policy_must_be_an_object");
  }
  const devicesInput = input.devices == null ? {} : input.devices;
  if (!devicesInput || typeof devicesInput !== "object" || Array.isArray(devicesInput)) {
    throw invalidPolicy("screen_transport_policy_devices_must_be_an_object");
  }
  const deviceEntries = Object.entries(devicesInput);
  if (deviceEntries.length > 500) throw invalidPolicy("screen_transport_policy_too_many_devices");

  const devices = {};
  for (const [rawTarget, rawProfile] of deviceEntries) {
    const target = normalizeTarget(rawTarget);
    const profile = normalizeProfile(rawProfile, `devices.${target}`);
    if (Object.keys(profile).length) devices[target] = profile;
  }

  return {
    revision: Math.max(0, Math.round(Number(metadata.revision ?? input.revision) || 0)),
    updatedAt: String(metadata.updatedAt ?? input.updatedAt ?? ""),
    updatedBy: String(metadata.updatedBy ?? input.updatedBy ?? "").slice(0, 160),
    defaults: normalizeProfile(input.defaults || {}, "defaults"),
    devices
  };
}

export function resolveScreenTransportPolicy(policyInput, session = {}) {
  const policy = normalizeStoredPolicy(policyInput);
  const deviceId = String(session.deviceId || "").trim();
  const adbSerial = String(session.adbSerial || "").trim();
  const resolved = {
    ...policy.defaults,
    ...(deviceId ? policy.devices[deviceId] : null),
    ...(adbSerial ? policy.devices[adbSerial] : null)
  };
  if (!Object.keys(resolved).length) return {};
  return {
    ...resolved,
    screenHotConfigFields: Object.keys(resolved),
    transportPolicyRevision: policy.revision
  };
}

export function screenTransportPolicyFields() {
  return Object.fromEntries(Object.entries(POLICY_FIELDS).map(([key, definition]) => [key, {
    type: definition.type,
    ...(definition.min == null ? {} : { min: definition.min }),
    ...(definition.max == null ? {} : { max: definition.max }),
    ...(definition.minLength == null ? {} : { minLength: definition.minLength }),
    ...(definition.maxLength == null ? {} : { maxLength: definition.maxLength }),
    ...(definition.values == null ? {} : { values: [...definition.values] })
  }]));
}

export function publicScreenTransportPolicy(policyInput) {
  return normalizeStoredPolicy(policyInput);
}

function normalizeStoredPolicy(input) {
  try {
    return normalizeScreenTransportPolicy(input || {});
  } catch {
    return defaultScreenTransportPolicy();
  }
}

function normalizeProfile(input, path) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidPolicy(`screen_transport_policy_${path}_must_be_an_object`);
  }
  const profile = {};
  for (const [key, value] of Object.entries(input)) {
    const definition = POLICY_FIELDS[key];
    if (!definition) throw invalidPolicy(`screen_transport_policy_unknown_field:${path}.${key}`);
    if (definition.type === "boolean") {
      if (typeof value !== "boolean") throw invalidPolicy(`screen_transport_policy_invalid_boolean:${path}.${key}`);
      profile[key] = value;
      continue;
    }
    if (definition.type === "string") {
      const text = String(value || "").trim();
      if (
        text.length < definition.minLength
        || text.length > definition.maxLength
        || !definition.pattern.test(text)
      ) {
        throw invalidPolicy(`screen_transport_policy_invalid_string:${path}.${key}`);
      }
      profile[key] = text;
      continue;
    }
    const numeric = Number(value);
    if (
      !Number.isFinite(numeric)
      || (definition.values && !definition.values.includes(numeric))
      || (definition.min != null && numeric < definition.min)
      || (definition.max != null && numeric > definition.max)
    ) {
      throw invalidPolicy(`screen_transport_policy_out_of_range:${path}.${key}`);
    }
    profile[key] = Math.round(numeric);
  }
  return profile;
}

function normalizeTarget(input) {
  const target = String(input || "").trim();
  if (!target || target.length > 128 || /[\u0000-\u001f\u007f]/.test(target)) {
    throw invalidPolicy("screen_transport_policy_invalid_device_target");
  }
  return target;
}

function invalidPolicy(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
