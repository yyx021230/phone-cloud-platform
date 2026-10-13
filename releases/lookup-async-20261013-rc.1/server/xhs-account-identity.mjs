export function normalizeXhsId(value = "") {
  return String(value || "").replace(/\s+/g, "").trim().slice(0, 64);
}

export function validateXhsAccounts(accounts = []) {
  const seen = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const appSlot = String(account?.appSlot || "");
    const accountName = String(account?.accountName || "").trim();
    const xhsId = normalizeXhsId(account?.xhsId);
    if (accountName && !xhsId) return { error: "xhs_id_required", appSlot, accountName };
    if (xhsId && !accountName) return { error: "xhs_account_name_required", appSlot, xhsId };
    if (!xhsId) continue;
    const key = xhsId.toLowerCase();
    if (seen.has(key)) {
      return {
        error: "xhs_id_duplicate_on_device",
        xhsId,
        appSlot,
        conflictAppSlot: seen.get(key)
      };
    }
    seen.set(key, appSlot);
  }
  return null;
}

export function findXhsIdConflict(devices = [], currentDeviceId = "", accounts = []) {
  const requested = new Map(
    (Array.isArray(accounts) ? accounts : [])
      .map((account) => [normalizeXhsId(account?.xhsId).toLowerCase(), account])
      .filter(([xhsId]) => xhsId)
  );
  if (!requested.size) return null;

  for (const device of Array.isArray(devices) ? devices : []) {
    if (!device || String(device.deviceId || "") === String(currentDeviceId || "")) continue;
    for (const account of Array.isArray(device.xhsAccounts) ? device.xhsAccounts : []) {
      const key = normalizeXhsId(account?.xhsId).toLowerCase();
      if (!key || !requested.has(key)) continue;
      return {
        error: "xhs_id_already_bound",
        xhsId: normalizeXhsId(account.xhsId),
        requestedAppSlot: String(requested.get(key)?.appSlot || ""),
        conflictDeviceId: String(device.deviceId || ""),
        conflictDeviceName: String(device.deviceName || device.deviceId || ""),
        conflictAppSlot: String(account.appSlot || ""),
        conflictAccountName: String(account.accountName || "")
      };
    }
  }
  return null;
}
