// Read-only QA planning. A device-wide installed flag does not prove either
// account slot exists. Each eligible row still needs a package/profile probe.
export const XHS_RETEST_EXCLUDED_PHONES = ["74", "81", "152", "188"];

export function boundXhsAccount(device, slot) {
  if (!["app1", "app2"].includes(slot)) return null;
  const matches = (device?.xhsAccounts || []).filter((a) => a.appSlot === slot);
  if (matches.length !== 1 || matches[0].enabled === false
      || !String(matches[0].xhsId || "").trim()) return null;
  return matches[0];
}

export function planXhsSlotRetest(devices, { phoneNames, activeDeviceIds = [] }) {
  const busy = new Set(activeDeviceIds);
  const rows = [];
  for (const name of [...new Set(phoneNames.map(String))].sort((a, b) => Number(a) - Number(b))) {
    const matches = devices.filter((d) => String(d.deviceName) === name);
    for (const slot of ["app1", "app2"]) {
      const row = { name, slot, eligible: false };
      if (matches.length !== 1) { rows.push({ ...row, reason: "device_identity_unproven" }); continue; }
      const d = matches[0];
      const account = boundXhsAccount(d, slot);
      let reason = "";
      if (XHS_RETEST_EXCLUDED_PHONES.includes(name)) reason = "explicit_user_skip";
      else if (!account) reason = "no_enabled_bound_xhs_in_this_slot";
      else if (d.listed === false || d.listingStatus !== "listed") reason = "not_listed";
      else if (d.conflictStatus || !d.deviceId || !d.adb?.serial) reason = "device_identity_unproven";
      else if (d.adb.state !== "device") reason = `device_unavailable:${d.adb.state || "unknown"}`;
      else if (d.occupancy || busy.has(d.deviceId)) reason = "foreign_occupancy";
      if (reason) { rows.push({ ...row, reason }); continue; }
      rows.push({ ...row, eligible: true, reason: "bound_slot_requires_package_proof",
        deviceId: d.deviceId, serial: d.adb.serial, manufacturer: d.manufacturer,
        model: d.model, expectedXhsId: String(account.xhsId).trim() });
    }
  }
  return rows;
}
