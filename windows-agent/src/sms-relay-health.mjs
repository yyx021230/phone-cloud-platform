const SMS_RELAY_PACKAGE = "com.ztqc.smsrelay";
const SMS_RELAY_HEALTH_URI = `content://${SMS_RELAY_PACKAGE}.health/status`;

export function buildSmsRelayHealthArgs() {
  return ["shell", "content", "query", "--uri", SMS_RELAY_HEALTH_URI];
}

export function buildSmsRelayRecoverArgs() {
  return [
    "shell", "am", "start",
    "--user", "0",
    "-n", `${SMS_RELAY_PACKAGE}/.RecoveryActivity`,
    "--activity-no-animation",
    "--activity-no-history"
  ];
}

export function parseSmsRelayHealth(output, checkedAt = new Date().toISOString()) {
  const text = String(output || "");
  const marker = "status_json=";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) throw new Error("sms_relay_health_payload_missing");
  const jsonText = text.slice(markerIndex + marker.length).trim().split(/\r?\n/, 1)[0];
  const value = JSON.parse(jsonText);
  return {
    installed: true,
    collectionMode: "health_only",
    checkedAt,
    defaultSmsApp: value.defaultSmsApp === true,
    defaultSmsPackage: String(value.defaultSmsPackage || "").slice(0, 200),
    serviceAlive: value.serviceAlive === true,
    receiveSmsGranted: value.receiveSmsGranted === true,
    readSmsGranted: value.readSmsGranted === true,
    batteryOptimizationIgnored: value.batteryOptimizationIgnored === true,
    pendingUploadCount: boundedNumber(value.pendingUploadCount),
    localMessageCount: boundedNumber(value.localMessageCount),
    providerWriteFailureCount: boundedNumber(value.providerWriteFailureCount),
    oldestPendingUploadAgeMillis: boundedNumber(value.oldestPendingUploadAgeMillis),
    nextUploadRetryInMillis: boundedNumber(value.nextUploadRetryInMillis),
    lastReceiveAt: boundedNumber(value.lastReceiveAt),
    lastServiceAliveAt: boundedNumber(value.lastServiceAliveAt),
    lastSyncAt: boundedNumber(value.lastSyncAt),
    lastSyncStatus: String(value.lastSyncStatus || "").slice(0, 80)
  };
}

export function missingSmsRelayHealth(checkedAt = new Date().toISOString()) {
  return {
    installed: false,
    collectionMode: "legacy_windows",
    checkedAt,
    defaultSmsApp: false,
    defaultSmsPackage: "",
    serviceAlive: false,
    receiveSmsGranted: false,
    readSmsGranted: false,
    batteryOptimizationIgnored: false,
    pendingUploadCount: 0,
    localMessageCount: 0,
    providerWriteFailureCount: 0,
    oldestPendingUploadAgeMillis: 0,
    nextUploadRetryInMillis: 0,
    lastReceiveAt: 0,
    lastServiceAliveAt: 0,
    lastSyncAt: 0,
    lastSyncStatus: "not_installed"
  };
}

export function shouldRecoverSmsRelay(health) {
  return Boolean(
    health?.installed
    && health?.defaultSmsApp
    && health?.receiveSmsGranted
    && !health?.serviceAlive
  );
}

/**
 * Once the APK is installed, Windows is health/watchdog only.  It must not
 * read content://sms or notification snapshots, even while the user still
 * needs to finish the Android default-SMS-role setup.
 */
export function usesSmsRelayManagedSmsPath(health) {
  return health?.installed === true;
}

function boundedNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(number)));
}
