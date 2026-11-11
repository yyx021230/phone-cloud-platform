import test from "node:test";
import assert from "node:assert/strict";
import {fixture} from "../wecom-v2-projection-policy-20261102/fixture.mjs";
import {validateFixtureCandidate,releaseCandidate,applyFixtureCandidate,isFixtureCasConflict} from "./owner-fixture.mjs";
const setup=()=>{const f=fixture();return {canonical:f.canonical,context:f.f.context,candidate:releaseCandidate(f.canonical)};};
test("synthetic normalized tuple matches candidate but grants no authority",()=>{const s=setup(),before=structuredClone(s);const r=validateFixtureCandidate(s.canonical,s.context,s.candidate);assert.equal(r.fixtureValidation,"candidate_matches_given_snapshot");assert.equal(r.writePermit,false);assert.equal(r.protocolPermit,false);assert.equal(r.canonicalSourceVerified,false);assert.deepEqual(s,before);});
for(const [label,mutate]of[
  ["context owner",s=>{s.context.ownerUserId="other-owner";}],["context claim",s=>{s.context.claimOperationId="other-claim";}],["context request",s=>{s.context.requestId="other_request";}],
  ["lock id",s=>{s.candidate.lockId="other-lock";}],["job id",s=>{s.candidate.taskId="other-job";}],["device",s=>{s.candidate.deviceId="adb:other";}],["owner",s=>{s.candidate.ownerUserId="other-owner";}],
  ["slot",s=>{s.candidate.appSlot="main";}],["kind",s=>{s.candidate.lockType="other_kind";}],["creation",s=>{s.candidate.createdAt="2098-01-01T00:00:00.000Z";}],
  ["expiry",s=>{s.candidate.expiresAt="2098-01-01T00:00:00.000Z";}],["cleared expiry",s=>{s.candidate.expiresAt="";}],
  ["candidate state",s=>{s.candidate.status="cleanup_pending";}],["source state",s=>{s.canonical.businessLock.status=s.canonical.businessLock.data.status="released";}],
  ["numeric revision",s=>{s.canonical.anchor.mapping_revision=1;}],["zero-prefixed revision",s=>{s.canonical.anchor.mapping_revision="01";}],
  ["Date transport",s=>{s.canonical.windowsTask.created_at=new Date(s.canonical.windowsTask.created_at);}],["unknown added",s=>{s.candidate.extra="not-authorized";}],
  ["unknown changed",s=>{s.canonical.businessLock.data.extra={nested:1};s.candidate.extra={nested:2};}],
  ["unknown removed",s=>{s.canonical.businessLock.data.extra="must-preserve";}],
  ["new marker",s=>{s.candidate.wecomV2Claim=null;}],["bad updated time",s=>{s.candidate.updatedAt=1;}],["different released time",s=>{s.candidate.releasedAt="2098-01-01T00:00:00.000Z";}],
  ["invalid reason",s=>{s.candidate.releaseReason=" bad ";}],["legacy ledger",s=>{s.canonical.ledger.claim_data=null;}],["missing hold",s=>{s.canonical.physicalHold=null;}]
])test(`${label} rejected before any DML`,async()=>{const s=setup();mutate(s);let dml=0;const client={query:async()=>{dml++;throw Error("must-not-query");}};await assert.rejects(applyFixtureCandidate(client,s.canonical,s.context,s.candidate),/fixture_business_candidate_rejected/);assert.equal(dml,0);});
test("unknown JSON extensions unchanged are preserved, not discarded",()=>{const s=setup();s.canonical.businessLock.data.extra={nested:[1,"keep"]};s.candidate.extra=structuredClone(s.canonical.businessLock.data.extra);assert.equal(validateFixtureCandidate(s.canonical,s.context,s.candidate).writePermit,false);assert.deepEqual(s.candidate.extra,{nested:[1,"keep"]});});
test("candidate accessors are rejected without invocation or DML",async()=>{const s=setup();let accessed=0,dml=0;Object.defineProperty(s.candidate,"extra",{get(){accessed++;return "bad";},enumerable:true});await assert.rejects(applyFixtureCandidate({query:async()=>{dml++;}},s.canonical,s.context,s.candidate),/candidate_rejected/);assert.equal(accessed,0);assert.equal(dml,0);});
test("same-message driver failure is not a local CAS conflict",async()=>{const s=setup(),driver=Error("fixture_business_cas_conflict");await assert.rejects(applyFixtureCandidate({query:async()=>{throw driver;}},s.canonical,s.context,s.candidate),error=>error===driver&&!isFixtureCasConflict(error));});
test("only owned zero-row classification is a CAS conflict",async()=>{const s=setup();await assert.rejects(applyFixtureCandidate({query:async()=>({rowCount:0,rows:[]})},s.canonical,s.context,s.candidate),error=>isFixtureCasConflict(error));});
