// Synthetic causal-v1 adapter derived from the preserved legacy fixture; never native evidence.
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
export function createSimulatedWecomCleanup({ request, agentId, token, nextRoute, runtimeHostRegistration = false }) {
  const records = new Map(); let pid = 100;
  async function observe(method, route, body, result) {
    const task = method === "GET" && route.includes("/tasks/next") ? result.task : null;
    if (task?.type === "wecom_customer_preview" && task.payload?.physicalCleanup) {
      const binding = task.payload.physicalCleanup;
      const prefix = `/api/v1/windows-agents/${agentId}/wecom-cleanup/${binding.obligationId}/`;
      assert.equal(task.payload.wecomCausalLease?.protocol,"wecom-causal-v1");
      const bootstrap={protocol:"wecom-causal-v1",bindingNonce:binding.nonce,pipeNonce:"c".repeat(48)};
      const record = { binding, prefix,bootstrap, hosts: null, closed: false };
      records.set(task.taskId, record);
      if (!runtimeHostRegistration) {
        record.hosts = [{ role: "reader", pid: ++pid, ...syntheticHostTime(), machineId: "a".repeat(64) }];
        await request("POST", prefix + "host", token, { binding, hosts: record.hosts,bootstrap:record.bootstrap });
      }
    }
    // The UI algorithm fixture may use the actual Node wrapper and OS child.
    // In that case only its acknowledged host/close calls supply identities;
    // Android tool observations below remain explicitly synthetic.
    if (runtimeHostRegistration && method === "POST" && body?.binding) {
      const record = records.get(body.binding.originalTaskId);
      if (record && route === record.prefix + "host") {record.hosts = structuredClone(body.hosts);record.bootstrap=structuredClone(body.bootstrap);}
      if (record && route === record.prefix + "host-closed") record.closed = true;
    }
    const match = route.match(/^\/api\/v1\/windows-agent-tasks\/([^/]+)\/status$/);
    if (method !== "POST" || !match || !["succeeded", "failed", "cancelled"].includes(body?.status)) return;
    const record = records.get(match[1]); if (!record) return;
    const { binding, hosts, prefix,bootstrap } = record;
    if (runtimeHostRegistration) {
      assert.ok(hosts && record.closed, "actual wrapper must register and close its own fixture child before status");
    } else {
      await request("POST", prefix + "host-closed", token, { binding, hosts,bootstrap, observedAt: new Date().toISOString(), exited: true, observerMachineId: hosts[0].machineId });
    }
    const created = await request("POST", prefix + "verify", token, { binding });
    const verification = (await request("GET", nextRoute, token)).task;
    assert.equal(verification?.taskId, created.taskId);
    assert.equal(verification.payload.causalLease?.protocol,"wecom-causal-v1");
    const fields={verificationId:verification.payload.verificationId,verificationNonce:verification.payload.verificationNonce,verificationTaskId:verification.taskId};
    const began=performance.now();
    const {challenge}=await request("POST",prefix+"challenge",token,{binding,...fields});
    const snapshots = [];
    for (let i = 0; i < 2; i++) { await pause(2); snapshots.push({sequence:i+1,elapsedMs:performance.now()-began, observedAt: new Date().toISOString(), packagesAbsent: true, packageNames: [...WECOM_PACKAGES], serialForwardCount: 0 }); }
    await request("POST", prefix + "proof", token, { binding,...fields,challenge,snapshots });
    records.delete(match[1]);
  }
  return { observe };
}
