export async function assertSerialAdbHealthy({ serial, adb }) {
  try {
    const output = await adb(serial, ["shell", "echo", "phone_cloud_adb_ready"], {
      timeoutMs: 3_000,
      allowScreenControl: true
    });
    if (String(output || "").trim() === "phone_cloud_adb_ready") return;
  } catch (cause) {
    const error = shellFailure(serial, cause);
    error.cause = cause;
    throw error;
  }
  throw unhealthyError(serial);
}

function shellFailure(serial, cause) {
  const detail = `${cause?.message || ""}\n${cause?.stderr || ""}`;
  if (/unauthorized/i.test(detail)) {
    return Object.assign(new Error(`手机尚未授权 ADB：${serial}`), { code: "screen_adb_unauthorized" });
  }
  if (/device\s+(?:['"][^'"\r\n]+['"]\s+)?not found|no devices\/emulators found/i.test(detail)) {
    return Object.assign(new Error(`当前 ADB 连接中找不到这台手机：${serial}`), { code: "screen_adb_not_found" });
  }
  if (/device\s+offline/i.test(detail)) {
    return Object.assign(new Error(`手机 ADB 当前不在线：${serial}`), { code: "screen_adb_offline" });
  }
  if (cause?.code === "ETIMEDOUT" || cause?.killed === true || /timed?\s*out|timeout/i.test(detail)) {
    return Object.assign(new Error(`手机 ADB shell 响应超时：${serial}`), { code: "screen_adb_shell_timeout" });
  }
  return Object.assign(new Error(`手机 ADB shell 检查失败：${serial}`), { code: "screen_adb_shell_failed" });
}

function unhealthyError(serial) {
  const error = new Error(`手机 ADB shell 通道无响应：${serial}`);
  error.code = "screen_adb_unhealthy";
  return error;
}
