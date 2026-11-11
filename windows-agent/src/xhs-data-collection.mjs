import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// Cache-only preflight. Wait for the server's reservation to reach this Agent
// before any phone command; never manufacture ownership from a stale snapshot.
export async function waitForXhsDataReservation(task, { deviceCachePath, signal,
  timeoutMs = 30_000, clock = () => performance.now(), wait = ms => sleep(ms, undefined, { signal }) }) {
  const jobId = task.payload?.automationJobId, appSlot = task.payload?.xhsAppSlot;
  const failure = (code, reason) => ({ action: "小红书数据采集", errorCode: code,
    message: code === "xhs_data_reservation_pending" ? "等待手机空闲及本次占用同步，尚未操作手机" : "采集前库存检查未通过，尚未操作手机",
    diagnostic: { code, version: 1, phase: "before_device_actions", collectionStarted: false,
      jobId, appSlot, reason } });
  if (!jobId || !task.adbSerial || !task.payload?.deviceName || !["app1", "app2"].includes(appSlot)) {
    return failure("invalid_xhs_data_collection_task", "invalid_task");
  }
  const deadline = clock() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason || new Error("automation_task_cancelled");
    let handle, devices;
    try {
      // stat the opened file: an atomic replacement must not renew old content.
      handle = await fs.open(deviceCachePath, "r");
      const stat = await handle.stat();
      const age = Date.now() - stat.mtimeMs;
      if (age > 90_000 || age < -5000) return failure("xhs_data_inventory_unavailable", "cache_not_fresh");
      const payload = JSON.parse((await handle.readFile("utf8")).replace(/^\uFEFF/, ""));
      if (Date.now() - stat.mtimeMs > 90_000) return failure("xhs_data_inventory_unavailable", "cache_not_fresh");
      devices = Array.isArray(payload) ? payload : payload?.devices;
    } catch { return failure("xhs_data_inventory_unavailable", "cache_unreadable"); }
    finally { await handle?.close(); }
    if (signal?.aborted) throw signal.reason || new Error("automation_task_cancelled");
    const matches = Array.isArray(devices) ? devices.filter(d => String(d?.adb?.serial || "").toLowerCase() === String(task.adbSerial).toLowerCase()) : [];
    if (matches.length !== 1 || String(matches[0].deviceName) !== String(task.payload.deviceName)) {
      return failure("xhs_data_inventory_mismatch", "target_not_unique_or_name_mismatch");
    }
    const device = matches[0], occupancy = device.occupancy;
    if (device.adb?.state !== "device") return failure("xhs_data_device_offline", "adb_not_online");
    if (occupancy?.kind === "xhs_data_collect" && occupancy.taskId === jobId && occupancy.appSlot === appSlot) return null;
    const remaining = deadline - clock();
    if (remaining <= 0) return failure("xhs_data_reservation_pending", occupancy ? "other_occupancy" : "reservation_not_visible");
    try { await wait(Math.min(500, remaining)); }
    catch (error) {
      if (signal?.aborted) throw signal.reason || new Error("automation_task_cancelled");
      throw error;
    }
  }
}

// Only this task's subprocess is added. Existing scan, screen and ADB scheduling
// continue to own device exclusion and task cancellation.
export async function runXhsDataCollection(task, { config, run, adb, signal, cacheDir, deviceCachePath }) {
  const jobId = String(task.payload?.automationJobId || "");
  const slot = task.payload?.xhsAppSlot;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(task.taskId || "") || !jobId
      || !["app1", "app2"].includes(slot) || !task.payload?.deviceName) {
    throw new Error("invalid_xhs_data_collection_task");
  }
  const folder = path.join(cacheDir, "xhs-data-collection");
  await fs.mkdir(folder, { recursive: true });
  const serialKey = createHash("sha256").update(String(task.adbSerial).toLowerCase()).digest("hex").slice(0, 16);
  if ((await fs.readdir(folder)).some((name) => name.startsWith(`${serialKey}-`) && name.endsWith(".settings.json"))) {
    throw new Error("xhs_data_settings_recovery_pending");
  }
  const outputPath = path.join(folder, `${task.taskId}.json`);
  const cancelPath = path.join(folder, `${task.taskId}.cancel`);
  const recoveryPath = path.join(folder, `${serialKey}-${task.taskId}.settings.json`);
  let recoveryWritten = false;
  const processController = new AbortController();
  let forceStopTimer;
  let cancellationWrite = Promise.resolve();
  const onCancel = () => {
    cancellationWrite = fs.writeFile(cancelPath, "cancelled").catch(() => processController.abort(signal?.reason));
    // Give an in-flight bounded ADB call time to return and Python's finally
    // time to restore settings; kill only this subprocess if it fails to exit.
    forceStopTimer = setTimeout(() => processController.abort(signal?.reason), 25_000);
    forceStopTimer.unref();
  };
  const settings = [
    ["system", "screen_off_timeout"], ["global", "enable_screen_on_proximity_sensor"]
  ];
  const original = [];
  const startedAt = Date.now();
  let executionError = null;
  await fs.unlink(outputPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await fs.unlink(cancelPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  signal?.addEventListener("abort", onCancel, { once: true });
  try {
    if (signal?.aborted) throw signal.reason || new Error("automation_task_cancelled");
    for (const [scope, key] of settings) {
      original.push(String(await adb(task.adbSerial, ["shell", "settings", "get", scope, key], { timeoutMs: 8_000 })).trim());
    }
    const recovery = { schemaVersion: 1, taskId: task.taskId, serial: task.adbSerial,
      deviceName: task.payload.deviceName, capturedAt: new Date().toISOString(),
      settings: settings.map(([scope, key], index) => ({ scope, key, original: original[index] })) };
    await fs.writeFile(`${recoveryPath}.tmp`, JSON.stringify(recovery));
    await fs.rename(`${recoveryPath}.tmp`, recoveryPath);
    recoveryWritten = true;
    let exitCode = 0;
    try {
      await run(config.pythonCommand, [config.xhsDataCollectionRunnerPath,
        "--serial", task.adbSerial, "--adb", config.adbPath,
        "--device-name", task.payload.deviceName, "--device-cache", deviceCachePath,
        "--app-slot", slot, "--task-id", jobId, "--cancel-file", cancelPath, "--days", "30", "--output", outputPath], {
        timeoutMs: 20 * 60_000, maxBuffer: 1024 * 1024, signal: processController.signal
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (error.code !== 2) throw error;
      exitCode = 2; // Bounded scan completed without proof of the date boundary.
    }
    if (signal?.aborted) throw signal.reason || new Error("automation_task_cancelled");
    const snapshot = JSON.parse(await fs.readFile(outputPath, "utf8"));
    if (snapshot.schema_version !== 3 || snapshot.serial !== task.adbSerial
        || String(snapshot.device_name) !== String(task.payload.deviceName)
        || snapshot.app_slot !== slot || snapshot.window_days !== 30
        || (slot === "app2" && !snapshot.recovery_events?.includes("clone_slot_selected:app2"))
        || !Array.isArray(snapshot.notes) || snapshot.notes.length > 1000
        || (exitCode === 0) !== (snapshot.complete === true)) {
      throw new Error("xhs_data_collection_output_mismatch");
    }
    return {
      action: "小红书数据采集", message: snapshot.complete
        ? `已采集 ${snapshot.notes.length} 篇，时间范围完整`
        : `已采集 ${snapshot.notes.length} 篇，尚未确认时间边界`,
      errorCode: snapshot.complete ? "" : "recent_window_not_proven",
      executionMode: snapshot.warnings?.includes("list_read_with_local_image_recognition")
        ? "windows_xml_with_native_image_reader" : "windows_xml_uiautomator", durationMs: Date.now() - startedAt,
      collection: snapshot
    };
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onCancel);
    clearTimeout(forceStopTimer);
    await cancellationWrite;
    // A killed Python process cannot execute its own finally. Restore only the
    // selected phone's saved settings even on cancellation, using existing ADB.
    const restorationErrors = [];
    for (let index = 0; index < original.length; index++) {
      const value = original[index];
      if (value === "null" || !/^\d+$/.test(value)) continue;
      const [scope, key] = settings[index];
      try {
        const current = String(await adb(task.adbSerial, ["shell", "settings", "get", scope, key], { timeoutMs: 8_000 })).trim();
        if (current !== value) {
          await adb(task.adbSerial, ["shell", "settings", "put", scope, key, value], { timeoutMs: 8_000 });
          const restored = String(await adb(task.adbSerial, ["shell", "settings", "get", scope, key], { timeoutMs: 8_000 })).trim();
          if (restored !== value) throw new Error(`xhs_data_setting_restore_unconfirmed:${scope}:${key}`);
        }
      } catch (error) { restorationErrors.push(error.message); }
    }
    await fs.unlink(outputPath).catch(() => {});
    await fs.unlink(cancelPath).catch(() => {});
    if (!restorationErrors.length && recoveryWritten) await fs.unlink(recoveryPath).catch(() => {});
    if (restorationErrors.length && !executionError) {
      throw Object.assign(new Error("xhs_data_settings_restore_failed"), { restorationErrors, settingsRecoveryPath: recoveryPath });
    }
    if (restorationErrors.length && executionError) {
      executionError.restorationErrors = restorationErrors;
      executionError.settingsRecoveryPath = recoveryPath;
    }
  }
}
