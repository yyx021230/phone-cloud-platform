import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WECOM_DIAGNOSTIC_PREFIX, wecomProgress, wecomExecution, progressSummary } from "./wecom-diagnostics.mjs";
import { createPhysicalLifecycle, WECOM_READY_PREFIX } from "./wecom-cleanup-protocol.mjs";

// A one-shot child with stdin-only credentials and no command-line phone data.
// It neither imports the Agent entry point nor manages the shared ADB server.
export async function runWecomPreviewTask(task, { config, agentDir, signal, spawnChild = spawn, cleanupRequest, onPhysicalPending = () => {} } = {}) {
  const sending = task.payload?.mode === "send";
  if (task.type !== "wecom_customer_preview" || ![undefined, "preview", "send"].includes(task.payload?.mode) || task.payload?.previewOnly !== !sending) throw new Error("invalid_wecom_preview_task");
  if (signal?.aborted) throw signal.reason || new Error("automation_task_cancelled");
  const startedAt = performance.now();
  const physical = task.payload?.physicalCleanup === undefined ? null : createPhysicalLifecycle(task, { config,
    remainingMs: action => (action === 'host' ? 230_000 : 245_000) - (performance.now() - startedAt),
    ...(cleanupRequest ? { request: cleanupRequest } : {}) });
  const payload = { taskId: task.taskId, deviceId: task.deviceId, serial: task.adbSerial,
    deviceNumber: task.payload.deviceNumber, androidUser: task.payload.androidUser,
    ...(task.payload.appSlot === undefined ? {} : { appSlot: task.payload.appSlot }),
    ...(task.payload.remarkName === undefined ? {} : { remarkName: task.payload.remarkName }),
    ...(task.payload.description === undefined ? {} : { description: task.payload.description }),
    phoneNumber: task.payload.phoneNumber, previewOnly: !sending, mode: sending ? "send" : "preview",
    ...(sending ? { claimDirectory: path.join(agentDir, "data", "wecom-send-claims") } : {}),
    agentId: config.agentId, serverBaseUrl: config.serverBaseUrl, agentToken: config.agentToken,
    ...(physical ? { physicalCleanup: physical.binding } : {}) };
  return new Promise((resolve, reject) => {
    let stdout = "", settled = false, abortReason = null, killTimer = null;
    let stderrLine = "", discardLine = false;
    let nativeClosed = false, payloadReleased = false, readiness = null;
    const decoder = new StringDecoder("utf8"), progress = [];
    const diagnostic = value => {
      const execution = wecomExecution(value?.diagnostic?.wecomExecution) || progressSummary(progress);
      return execution ? { diagnostic: { wecomExecution: execution } } : {};
    };
    let child;
    try { child = spawnChild(config.pythonCommand, [path.join(agentDir, "scripts", "wecom_platform_preview.py"), ...(physical ? ["--physical-ready-v1"] : [])], {
      cwd: agentDir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    }); } catch { reject(new Error("wecom_preview_worker_start_failed")); return; }
    let childStarted = Number.isInteger(child.pid) && child.pid > 0;
    child.once("spawn", () => { childStarted = true; });
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (error) { Object.assign(error, diagnostic()); reject(error); } else resolve(value);
    };
    const stop = reason => {
      if (settled || abortReason) return;
      abortReason = reason;
      if (nativeClosed) return;
      try { child.stdin.end(physical && !payloadReleased ? "" : "cancel\n"); } catch {}
      // Keep the serial reserved while the child releases its own resources.
      if (!settled) killTimer = setTimeout(() => {
        // A kill attempt, including false/throw/error, is not OS exit proof.
        // Keep the task/serial owned until close; never replay uncertain work.
        try { child.kill(); } catch { /* close remains the only completion. */ }
      }, 15_000);
    };
    const abort = () => stop(signal?.reason || new Error("automation_task_cancelled"));
    const timer = setTimeout(() => stop(new Error("wecom_preview_worker_timeout_no_replay")), 230_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", bytes => {
      stdout += bytes.toString("utf8");
      if (stdout.length > 32_000) stop(new Error("wecom_preview_invalid_output"));
    });
    // Discard library output. Only exact, bounded fixed-vocabulary records are
    // retained; never include raw lines, UI, phone numbers or exception text.
    child.stderr.on("data", bytes => {
      for (const character of decoder.write(bytes)) {
        if (character === "\n") {
          if (!discardLine && physical && stderrLine.startsWith(WECOM_READY_PREFIX)) {
            if (!nativeClosed && !settled) {
              if (readiness) stop(new Error("wecom_cleanup_host_invalid"));
              else {
                try {
                  const frame = JSON.parse(stderrLine.slice(WECOM_READY_PREFIX.length));
                  readiness = physical.ready(frame, child.pid).then(() => {
                    if (nativeClosed || settled || abortReason || signal?.aborted) return;
                    payloadReleased = true; // Unknown write delivery is never replayed.
                    child.stdin.write(JSON.stringify(payload) + "\n");
                  }).catch(error => stop(new Error(/^wecom_cleanup_[a-z0-9_]{1,70}$/.test(error.message || "") ? error.message : "wecom_cleanup_host_registration_unconfirmed")));
                } catch { stop(new Error("wecom_cleanup_host_invalid")); }
              }
            }
          } else if (!discardLine && stderrLine.startsWith(WECOM_DIAGNOSTIC_PREFIX)) {
            try {
              const frame = wecomProgress(JSON.parse(stderrLine.slice(WECOM_DIAGNOSTIC_PREFIX.length)));
              const previous = progress.at(-1);
              if (frame && (!previous || (frame.step > previous.step && frame.elapsedMs >= previous.elapsedMs))) {
                progress.push(frame); if (progress.length > 24) progress.shift();
              }
            } catch { /* Untrusted dependency output is not diagnostic data. */ }
          }
          stderrLine = ""; discardLine = false;
        } else if (!discardLine) {
          stderrLine += character;
          if (stderrLine.length > (physical && stderrLine.startsWith(WECOM_READY_PREFIX) ? 4096 : 1024)) { stderrLine = ""; discardLine = true; }
        }
      }
    });
    child.stdin.on("error", () => stop(new Error("wecom_preview_input_delivery_unknown")));
    child.on("error", () => {
      if (!childStarted && !(Number.isInteger(child.pid) && child.pid > 0)) {
        finish(new Error("wecom_preview_worker_start_failed"));
      } else stop(new Error("wecom_preview_worker_outcome_unknown"));
    });
    child.on("close", async code => {
      if (settled) return;
      nativeClosed = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (physical) {
        try { await physical.closed(); }
        catch (error) { try { onPhysicalPending(/^wecom_cleanup_[a-z0-9_]{1,70}$/.test(error.message || "") ? error.message : "wecom_cleanup_host_close_unconfirmed"); } catch {} }
      }
      if (abortReason) { finish(abortReason); return; }
      if (physical && !payloadReleased) { finish(new Error("wecom_cleanup_input_not_released")); return; }
      try {
        if (code !== 0) throw new Error();
        const value = JSON.parse(stdout.trim());
        if (!(sending ? ["send_attempted", "blocked"] : ["ready_before_send", "blocked"]).includes(value.previewStatus)
          || (sending ? !((value.sendStatus === "unknown" && value.invitationSent === null) || (value.previewStatus === "blocked" && [undefined, "not_attempted"].includes(value.sendStatus) && value.invitationSent === false)) : value.invitationSent !== false)
          || !/^[a-z0-9_]{1,100}$/.test(value.previewCode || "")) throw new Error();
        finish(null, { previewStatus: value.previewStatus, previewCode: value.previewCode,
          invitationSent: sending && value.sendStatus === "unknown" ? null : false, sendStatus: sending && value.sendStatus === "unknown" ? "unknown" : "not_attempted", remarkSaveStatus: ["not_attempted", "unknown", "confirmed", "not_needed"].includes(value.remarkSaveStatus) ? value.remarkSaveStatus : "unknown",
          executionMode: sending ? "wecom_poco_single_invitation" : "wecom_poco_preview_only", ...diagnostic(value) });
      } catch { finish(new Error("wecom_preview_worker_outcome_unknown")); }
    });
    if (!physical) { payloadReleased = true; child.stdin.write(JSON.stringify(payload) + "\n"); }
    if (signal?.aborted) abort();
  });
}
