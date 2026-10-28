// Platform/PnP identity matching is case-insensitive. ADB transport selection
// is not: only an observed spelling may be sent to ADB, never a guessed case.
export function resolveOnlineAdbSerial(requestedSerial, devices) {
  const requested = String(requestedSerial || "").trim();
  if (!Array.isArray(devices)) {
    throw identityError("screen_adb_inventory_unavailable", "ADB 设备清单暂不可用，请稍后重试");
  }
  const matches = devices.filter(device => requested && serialKey(device?.adbSerial) === serialKey(requested));
  if (matches.length > 1) {
    throw identityError("screen_adb_serial_ambiguous", "ADB 序列号存在大小写冲突，已停止连接，请管理员核对");
  }
  if (!matches.length) {
    throw identityError("screen_adb_not_found", `当前 ADB 清单中找不到这台手机：${requested}`);
  }
  const device = matches[0];
  if (device.state === "unauthorized") {
    throw identityError("screen_adb_unauthorized", `手机尚未授权 ADB：${requested}`);
  }
  if (device.state !== "device") {
    throw identityError("screen_adb_offline", `手机 ADB 当前不在线：${requested}`);
  }
  return String(device.adbSerial).trim();
}

// Preserve the same per-device values when the transport spelling is corrected.
// Conflicting profile aliases must not silently select different media settings.
export function adbSerialProfile(profiles = {}, serial = "") {
  const keys = Object.keys(profiles || {}).filter(key => serialKey(key) === serialKey(serial));
  if (keys.length > 1) {
    throw identityError("screen_adb_profile_ambiguous", "手机专属投屏配置存在大小写冲突，已停止连接，请管理员核对");
  }
  return keys.length ? profiles[keys[0]] : undefined;
}

function serialKey(value) {
  return String(value || "").trim().toUpperCase();
}

function identityError(code, message) {
  return Object.assign(new Error(message), { code });
}
