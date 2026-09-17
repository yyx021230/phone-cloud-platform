export async function assertSerialAdbHealthy({ serial, adb }) {
  try {
    const output = await adb(serial, ["shell", "echo", "phone_cloud_adb_ready"], {
      timeoutMs: 3_000,
      allowScreenControl: true
    });
    if (String(output || "").trim() === "phone_cloud_adb_ready") return;
  } catch (cause) {
    const error = unhealthyError(serial);
    error.cause = cause;
    throw error;
  }
  throw unhealthyError(serial);
}

function unhealthyError(serial) {
  const error = new Error(`手机 ADB shell 通道无响应：${serial}`);
  error.code = "screen_adb_unhealthy";
  return error;
}
