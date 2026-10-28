import {pocoForwardLocals} from "./worker-shutdown.mjs";
// Lookup recovery only. Screen/XML and unrelated task shutdown keep their policies.
export const isLookupReaderRecovery = reason => /^(?:lookup_(?:query_app_recovery|session_stopped|session_stop_best_effort|reader_(?:ready_timeout|idle_before_task|poco_probe_failed|task_timeout))|poco_(?:query_(?:resume_)?result_channel_timeout|start_[a-z_]+)|automatic_account_rotation)$/.test(reason);

export function readerExitDiagnostic(stderr = "", code = null, signal = null) {
  const text=String(stderr);
  const marker=text.match(/poco_worker_bootstrap_failed:(adb_probe|stale_reset|connect_device|instrumentation|transport_probe):([a-z_]+)/);
  const cause=marker?.[2] || (/device[^\n]*(?:offline|not found|unauthorized)/i.test(text) ? "device_unavailable"
    : /TimeoutExpired|ReadTimeout|timed out/i.test(text) ? "timeout"
    : /ConnectionRefused|ConnectionReset/i.test(text) ? "connection_failed" : "unknown");
  return {stage:marker?.[1]||"unknown",cause:["timeout","device_unavailable","command_failed","connection_failed","unknown"].includes(cause)?cause:"unknown",
    exitCode:Number.isInteger(code)?code:null,signal:["SIGTERM","SIGKILL","SIGABRT"].includes(signal)?signal:null};
}

// A failed pidof command is not proof that no service exists. Use one shell
// with explicit absence output and fail closed on malformed/read failures.
export async function verifyLookupReaderCleanup(serial, runAdb, now=Date.now) {
  const deadline=now()+8000;
  const call=async args=>{const remaining=deadline-now();if(remaining<=0)throw Error("lookup_reader_cleanup_deadline");return runAdb(["-s",serial,...args],{timeoutMs:Math.min(2000,remaining)});};
  for(const pkg of ["com.netease.open.pocoservice","com.netease.open.pocoservice.test"]){
    // A timed-out command can already have applied. Require fresh positive
    // absence evidence instead of assuming either success or failure from ACK.
    await call(["shell","am","force-stop",pkg]).catch(() => {});
    const value=String(await call(["shell",`pidof ${pkg} || echo LOOKUP_READER_ABSENT`])).trim();
    if(value!=="LOOKUP_READER_ABSENT")throw Error("lookup_reader_cleanup_unconfirmed");
  }
  const list=await call(["forward","--list"]);
  for(const local of pocoForwardLocals(list,serial))await call(["forward","--remove",local]);
  if(pocoForwardLocals(await call(["forward","--list"]),serial).length)throw Error("lookup_reader_forward_cleanup_unconfirmed");
  return true;
}

// Scope generic shared-worker reasons by the actual workflow, never by device.
export function lookupReaderStopReason(payload, reason) {
  return payload?.workflow === "alipay_name" && ["ready_timeout", "idle_before_task", "poco_probe_failed", "task_timeout"].includes(reason) ? `lookup_reader_${reason}` : reason;
}
