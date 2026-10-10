export function userSmsRefreshAction({ deviceSyncRequested = false } = {}) {
  return deviceSyncRequested ? "database_refresh" : "device_sync";
}
