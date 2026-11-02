// Synthetic protocol adapter for pre-existing business HTTP tests only.
// These process identities/resources are fixtures, never native evidence.
import assert from "node:assert/strict";
import { WECOM_PACKAGES } from "./wecom-physical-cleanup.mjs";
const pause = ms => new Promise(r => setTimeout(r, ms));
export function syntheticHostTime(ms = Date.now()) {
  const bytes = new DataView(new ArrayBuffer(8)); bytes.setFloat64(0, ms / 1000);
  const bits = bytes.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n) - 1023;
  const fraction = (bits & ((1n << 52n) - 1n)).toString(16).padStart(13, "0");
  return { createdAt: new Date(ms).toISOString(), creationToken: `0x1.${fraction}p+${exponent}` };
}
export function createSimulatedWecomCleanup({ request, agentId, token, nextRoute }) {
  const records = new Map(); let pid = 100;
  async function observe(method, route, body, result) {
    const task = method === "GET" && route.includes("/tasks/next") ? result.task : null;
    if (task?.type === "wecom_customer_preview" && task.payload?.physicalCleanup) {
      const binding = task.payload.physicalCleanup;
      const hosts = [{ role: "reader", pid: ++pid, ...syntheticHostTime(), machineId: "a".repeat(64) }];
      const prefix = `/api/v1/windows-agents/${agentId}/wecom-cleanup/${binding.obligationId}/`;
      await request("POST", prefix + "host", token, { binding, hosts });
      records.set(task.taskId, { binding, hosts, prefix });
    }
    const match = route.match(/^\/api\/v1\/windows-agent-tasks\/([^/]+)\/status$/);
    if (method !== "POST" || !match || !["succeeded", "failed", "cancelled"].includes(body?.status)) return;
    const record = records.get(match[1]); if (!record) return;
    const { binding, hosts, prefix } = record;
    await request("POST", prefix + "host-closed", token, { binding, hosts, observedAt: new Date().toISOString(), exited: true, observerMachineId: hosts[0].machineId });
    const created = await request("POST", prefix + "verify", token, { binding });
    const verification = (await request("GET", nextRoute, token)).task;
    assert.equal(verification?.taskId, created.taskId);
    const snapshots = [];
    for (let i = 0; i < 2; i++) { await pause(2); snapshots.push({ observedAt: new Date().toISOString(), packagesAbsent: true, packageNames: [...WECOM_PACKAGES], serialForwardCount: 0 }); }
    await request("POST", prefix + "proof", token, { binding, verificationId: verification.payload.verificationId,
      verificationNonce: verification.payload.verificationNonce, verificationTaskId: verification.taskId, snapshots });
    records.delete(match[1]);
  }
  return { observe };
}
