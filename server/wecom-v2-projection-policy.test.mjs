import test from "node:test";
import assert from "node:assert/strict";
import {createWecomV2ProjectionPolicy} from "./wecom-v2-projection-policy.mjs";
import {fixture} from "../verification/wecom-v2-projection-policy-20261102/fixture.mjs";
import {createWecomV2HostPreparer} from "./wecom-cleanup-v2-host.mjs";
import {fixture as hostFixture} from "../verification/wecom-v2-cas-m2-20261102/fixture.mjs";
function setup(f=fixture()){
  const providers={readPolicyEpoch:()=>f.observation.serverEpoch,readCanonicalProjection:()=>f.observation};
  return {f,providers,policy:createWecomV2ProjectionPolicy(providers)};
}
function result(s){const r=s.policy({targets:[s.f.request]});assert.equal(r.writePermit,false);assert.equal(r.protocolPermit,false);const d=r.results[0];for(const k of["writePermit","protocolPermit","releaseAllowed","canonicalSourceVerified"])assert.equal(d[k],false);assert.equal(d.retainExistingObligations,true);return d;}
for(const slot of["main","clone"])for(const mode of["preview","send"])test(`retain reviewed M3 normalized ${slot}/${mode} tuple, no permissions`,()=>{const s=setup(fixture({slot,mode}));assert.equal(result(s).decision,"retain_canonical");});
test("old queued proposals without v2 markers retain committed canonical rows",()=>{const s=setup(),before=structuredClone(s.f);assert.equal(s.f.request.writes[0].record.wecomV2Claim,undefined);assert.equal(result(s).decision,"retain_canonical");assert.deepEqual(s.f,before);});
for(const status of["running","stalled","succeeded","failed","cancelled","expired"])test(`canonical ${status} legitimate progress is not original queued CAS`,()=>{
  const s=setup();for(const row of[s.f.canonical.windowsTask,s.f.canonical.automationJob]){row.status=row.data.status=status;row.updated_at=row.data.updatedAt="2026-11-02T05:01:00.000Z";row.data.result={stage:"later"};row.data.events.push({type:"progress"});}
  assert.equal(result(s).decision,"retain_canonical");
});
test("success/failed or running/cancelled status divergence is legitimate",()=>{const s=setup();s.f.canonical.windowsTask.status=s.f.canonical.windowsTask.data.status="succeeded";s.f.canonical.automationJob.status=s.f.canonical.automationJob.data.status="failed";assert.equal(result(s).decision,"retain_canonical");s.f.canonical.windowsTask.status=s.f.canonical.windowsTask.data.status="running";s.f.canonical.automationJob.status=s.f.canonical.automationJob.data.status="cancelled";assert.equal(result(s).decision,"retain_canonical");});
test("business lock release and proposed physical release cannot clear obligation",()=>{const s=setup();s.f.canonical.businessLock.status=s.f.canonical.businessLock.data.status="released";s.f.request.writes.push({kind:"physicalHold",record:{...structuredClone(s.f.canonical.physicalHold.data),status:"released"}});assert.equal(result(s).decision,"retain_canonical");assert.notEqual(s.f.canonical.anchor.active_obligation_id,null);});
for(const key of["anchor","windowsTask","automationJob","physicalHold","businessLock","ledger","device"])test(`missing canonical ${key} rejects only that target`,()=>{const s=setup();s.f.canonical[key]=null;assert.equal(result(s).decision,"reject_target");});
for(const mutate of[
  s=>{s.f.canonical.ledger.claim_data=null;},s=>{s.f.canonical.ledger.protocol_state.version=1;},
  s=>{s.f.canonical.windowsTask.status=s.f.canonical.windowsTask.data.status="queued";},s=>{delete s.f.canonical.windowsTask.data.wecomV2Claim;},
  s=>{s.f.canonical.automationJob.data.phoneNumber="13900000001";},s=>{s.f.canonical.physicalHold.data.physicalCleanup.originalJobId="other";},
  s=>{s.f.canonical.anchor.mapping_state="disabled";},s=>{s.f.canonical.anchor.mapping_fingerprint="0".repeat(64);},
  s=>{s.f.canonical.device.adb.agentId="other";},s=>{s.f.canonical.windowsTask.status="failed";}
])test(`canonical conflict ${mutate} is not repaired/upgraded`,()=>{const s=setup();mutate(s);const before=structuredClone(s.f);assert.equal(result(s).decision,"reject_target");assert.deepEqual(s.f,before);});
for(const kind of["windowsTask","automationJob","device","physicalHold","businessLock"])test(`changed immutable proposed ${kind} refused`,()=>{
  const s=setup(),lookup={windowsTask:s.f.canonical.windowsTask.data,automationJob:s.f.canonical.automationJob.data,device:s.f.canonical.device,physicalHold:s.f.canonical.physicalHold.data,businessLock:s.f.canonical.businessLock.data};
  const record=structuredClone(lookup[kind]);if(kind==="windowsTask")record.payload.phoneNumber="13900000001";else if(kind==="automationJob")record.wecomRemarkName="other";else if(kind==="device")record.deviceName="99";else record.taskId="other";
  s.f.request.writes=[{kind,record}];assert.equal(result(s).decision,"reject_target");
});
for(const raw of[null,undefined,{},true,{kind:"unknown"}])test(`missing observation ${JSON.stringify(raw)} never means absent`,()=>{const s=setup();s.providers.readCanonicalProjection=()=>raw;const policy=createWecomV2ProjectionPolicy(s.providers);assert.equal(policy({targets:[s.f.request]}).results[0].decision,"ownership_unconfirmed");});
test("explicit observed absent remains candidate with zero permission",()=>{const s=setup();s.f.observation.kind="observed_absent";s.f.observation.canonical=null;assert.equal(result(s).decision,"legacy_candidate");});
test("absent with records or v1 pending never upgrades or releases",()=>{const s=setup();s.f.observation.kind="observed_absent";assert.equal(result(s).decision,"reject_target");s.f.observation.canonical=null;s.f.observation.legacyPending=[{version:1,lockId:"legacy-duty"}];assert.equal(result(s).decision,"reject_target");});
test("provider bool cannot attest ownership/provenance",()=>{const s=setup();s.providers.readCanonicalProjection=()=>({ready:true,canonicalVerified:true});const policy=createWecomV2ProjectionPolicy(s.providers);assert.equal(policy({targets:[s.f.request]}).results[0].decision,"ownership_unconfirmed");});
test("first device provider fails, independent second still classified",()=>{
  const a=fixture({suffix:"a"}),b=fixture({suffix:"b"});let calls=0;
  const policy=createWecomV2ProjectionPolicy({readPolicyEpoch:()=>a.observation.serverEpoch,readCanonicalProjection:t=>{calls++;if(t.deviceId===a.target.deviceId)throw Error("sensitive-business-data");return b.observation;}});
  const r=policy({targets:[a.request,b.request]});assert.deepEqual(r.results.map(x=>x.decision),["ownership_unconfirmed","retain_canonical"]);assert.equal(calls,2);assert.equal(JSON.stringify(r).includes("sensitive-business-data"),false);
});
test("first canonical conflict, second confirmed absence independently continues",()=>{const a=fixture({suffix:"a"}),b=fixture({suffix:"b"});a.canonical.windowsTask=null;b.observation.kind="observed_absent";b.observation.canonical=null;
  const policy=createWecomV2ProjectionPolicy({readPolicyEpoch:()=>a.observation.serverEpoch,readCanonicalProjection:t=>t.deviceId===a.target.deviceId?a.observation:b.observation});
  assert.deepEqual(policy({targets:[a.request,b.request]}).results.map(x=>x.decision),["reject_target","legacy_candidate"]);
});
test("invalid target does not throw whole batch or invoke provider for it",()=>{const s=setup();const r=s.policy({targets:[{bad:true},s.f.request]});assert.deepEqual(r.results.map(x=>x.decision),["reject_target","retain_canonical"]);});
test("canonical provider getter not invoked and next target continues",()=>{const a=fixture({suffix:"a"}),b=fixture({suffix:"b"});let invoked=0;
  const bad={...a.observation,get canonical(){invoked++;return a.canonical;}};const policy=createWecomV2ProjectionPolicy({readPolicyEpoch:()=>a.observation.serverEpoch,readCanonicalProjection:t=>t.deviceId===a.target.deviceId?bad:b.observation});
  assert.deepEqual(policy({targets:[a.request,b.request]}).results.map(x=>x.decision),["ownership_unconfirmed","retain_canonical"]);assert.equal(invoked,0);
});
test("immutable frozen results contain no business data or snapshots",()=>{const s=setup();const r=s.policy({targets:[s.f.request]});assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.results)&&Object.isFrozen(r.results[0]));
  for(const secret of[s.f.f.input.job.phoneNumber,s.f.f.input.job.wecomRemarkName,s.f.f.context.binding.nonce,"claim_data","payload"])assert.equal(JSON.stringify(r).includes(secret),false);
});
test("unknown COMMIT-like observation never produces replay/clear/write action",()=>{const s=setup();s.f.observation.kind="unknown";s.f.observation.canonical=null;assert.equal(result(s).decision,"ownership_unconfirmed");assert.equal(s.f.canonical.anchor.active_obligation_id,s.f.f.context.binding.obligationId);});
test("changed epoch and mismatched target observations stay unconfirmed",()=>{const s=setup();s.f.observation.target.agentId="other";assert.equal(result(s).decision,"ownership_unconfirmed");s.f.observation.target=s.f.request.target;s.f.observation.serverEpoch="other";assert.equal(result(s).decision,"ownership_unconfirmed");});
test("normalized M1 revision1/2 progress retains exact claim",()=>{
  const s=setup(),hf=hostFixture("policy-progress"),b=s.f.f.context.binding;hf.body.binding=b;hf.body.readyNonce=b.handshakeNonce;hf.facts.agentInstanceId=b.agentInstanceId;hf.facts.spawnNonce=b.handshakeNonce;
  const prepare=createWecomV2HostPreparer({readAuthenticatedBinding:()=>b,readParentInstanceFacts:()=>hf.facts}),l=s.f.canonical.ledger;
  for(const action of["host","host-closed"]){const body=action==="host"?hf.body:{...hf.body,operationId:"policy-close",expectedRevision:1,closeEventId:"policy-close-event"};if(action==="host-closed")hf.facts.closeEventId=body.closeEventId;
    l.protocol_state=structuredClone(prepare(l.protocol_state,action,body).nextState);l.revision=l.protocol_state.revision;l.host_operation_id=l.protocol_state.hostOperationId;l.close_operation_id=l.protocol_state.closeOperationId;assert.equal(result(s).decision,"retain_canonical");}
});
test("batch getter is rejected without invoking user code",()=>{const s=setup();let n=0;const r=s.policy({get targets(){n++;return[s.f.request];}});assert.equal(n,0);assert.equal(r.requestError,"invalid_batch");});
test("missing provider and extra authority booleans rejected at construction",()=>{assert.throws(()=>createWecomV2ProjectionPolicy({}),/providers_required/);const s=setup();assert.throws(()=>createWecomV2ProjectionPolicy({...s.providers,verified:true}),/providers_required/);});
