import { spawn } from "node:child_process";
import path from "node:path";

// A one-shot child with stdin-only credentials and no command-line phone data.
// It neither imports the Agent entry point nor manages the shared ADB server.
export async function runWecomPreviewTask(task, { config, agentDir, signal, spawnChild = spawn } = {}) {
  const sending = task.payload?.mode === "send";
  if (task.type !== "wecom_customer_preview" || ![undefined, "preview", "send"].includes(task.payload?.mode) || task.payload?.previewOnly !== !sending) throw new Error("invalid_wecom_preview_task");
  if (signal?.aborted) throw signal.reason || new Error("automation_task_cancelled");
  const payload = { taskId: task.taskId, deviceId: task.deviceId, serial: task.adbSerial,
    deviceNumber: task.payload.deviceNumber, androidUser: task.payload.androidUser,
    ...(task.payload.appSlot === undefined ? {} : { appSlot: task.payload.appSlot }),
    ...(task.payload.remarkName === undefined ? {} : { remarkName: task.payload.remarkName }),
    ...(task.payload.description === undefined ? {} : { description: task.payload.description }),
    phoneNumber: task.payload.phoneNumber, previewOnly: !sending, mode: sending ? "send" : "preview",
    ...(sending ? { claimDirectory: path.join(agentDir, "data", "wecom-send-claims") } : {}),
    agentId: config.agentId, serverBaseUrl: config.serverBaseUrl, agentToken: config.agentToken };
  return new Promise((resolve, reject) => {
    let stdout = "", settled = false, abortReason = null, killTimer = null;
    const child = spawnChild(config.pythonCommand, [path.join(agentDir, "scripts", "wecom_platform_preview.py")], {
      cwd: agentDir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const stop = reason => {
      if (settled || abortReason) return;
      abortReason = reason;
      try { child.stdin.end("cancel\n"); } catch {}
      // Keep the serial reserved while the child releases its own resources.
      if (!settled) killTimer = setTimeout(() => { child.kill(); finish(abortReason); }, 15_000);
    };
    const abort = () => stop(signal?.reason || new Error("automation_task_cancelled"));
    const timer = setTimeout(() => stop(new Error("wecom_preview_worker_timeout_no_replay")), 230_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", bytes => {
      stdout += bytes.toString("utf8");
      if (stdout.length > 32_000) stop(new Error("wecom_preview_invalid_output"));
    });
    // Never surface stderr: third-party libraries may include target UI data.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => stop(new Error("wecom_preview_input_delivery_unknown")));
    child.on("error", () => finish(new Error("wecom_preview_worker_start_failed")));
    child.on("close", code => {
      if (settled) return;
      if (abortReason) { finish(abortReason); return; }
      try {
        if (code !== 0) throw new Error();
        const value = JSON.parse(stdout.trim());
        if (!(sending ? ["send_attempted", "blocked"] : ["ready_before_send", "blocked"]).includes(value.previewStatus)
          || (sending ? !((value.sendStatus === "unknown" && value.invitationSent === null) || (value.previewStatus === "blocked" && [undefined, "not_attempted"].includes(value.sendStatus) && value.invitationSent === false)) : value.invitationSent !== false)
          || !/^[a-z0-9_]{1,100}$/.test(value.previewCode || "")) throw new Error();
        finish(null, { previewStatus: value.previewStatus, previewCode: value.previewCode,
          invitationSent: sending && value.sendStatus === "unknown" ? null : false, sendStatus: sending && value.sendStatus === "unknown" ? "unknown" : "not_attempted", remarkSaveStatus: ["not_attempted", "unknown", "confirmed", "not_needed"].includes(value.remarkSaveStatus) ? value.remarkSaveStatus : "unknown",
          executionMode: sending ? "wecom_poco_single_invitation" : "wecom_poco_preview_only" });
      } catch { finish(new Error("wecom_preview_worker_outcome_unknown")); }
    });
    child.stdin.write(JSON.stringify(payload) + "\n");
    if (signal?.aborted) abort();
  });
}
