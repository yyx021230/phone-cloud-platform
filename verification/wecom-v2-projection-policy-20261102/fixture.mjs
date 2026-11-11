// Synthetic normalized tuple derived from the already reviewed M3 pure claim
// producer. No DB/fake pool, Windows, executor or IO is imported.
import { createHash } from "node:crypto";
import { fixture as claimFixture } from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
import { createWecomV2ClaimPreparer } from "../../server/wecom-cleanup-v2-claim.mjs";
export function fixture({suffix="one",slot="main",mode="preview"}={}){
  const f=claimFixture({suffix,slot,mode,serial:`fixture-${suffix}`}),bundle=createWecomV2ClaimPreparer({readClaimContext:()=>f.context})(f.input),c=bundle.candidate,b=f.context.binding;
  const task=d=>({task_id:d.taskId,agent_id:d.agentId,adb_serial:d.adbSerial,status:d.status,created_at:d.createdAt,updated_at:d.updatedAt,data:structuredClone(d)});
  const job=d=>({job_id:d.jobId,device_id:d.deviceId,user_id:d.userId,kind:d.kind,status:d.status,created_at:d.createdAt,updated_at:d.updatedAt,data:structuredClone(d)});
  const lock=d=>({lock_id:d.lockId,device_id:d.deviceId,status:d.status,expires_at:d.expiresAt||null,data:structuredClone(d)});
  const target={deviceId:b.deviceId,serial:b.serial,agentId:b.agentId};
  const canonical={anchor:{physical_key:b.serial.toLowerCase(),device_id:b.deviceId,agent_id:b.agentId,active_obligation_id:b.obligationId,active_claim_operation_id:f.context.claimOperationId,
    mapping_revision:"1",mapping_state:"ready",mapping_fingerprint:createHash("sha256").update(JSON.stringify([b.deviceId,b.serial,b.agentId,f.input.device.deviceName])).digest("hex")},
    windowsTask:task(c.windowsTask),automationJob:job(c.automationJob),physicalHold:lock(c.physicalHold),businessLock:lock(c.businessLock),
    ledger:{obligation_id:b.obligationId,server_epoch:b.serverEpoch,revision:0,host_operation_id:null,close_operation_id:null,protocol_state:structuredClone(c.protocolState),claim_data:structuredClone(c.claimData)},device:structuredClone(f.input.device)};
  const observation={version:1,kind:"present",observationId:`observation-${suffix}`,serverEpoch:b.serverEpoch,target:structuredClone(target),canonical,legacyPending:[]};
  return {f,bundle,target,canonical,observation,request:{target:structuredClone(target),writes:[{kind:"windowsTask",record:structuredClone(f.input.task)},{kind:"automationJob",record:structuredClone(f.input.job)}]}};
}
