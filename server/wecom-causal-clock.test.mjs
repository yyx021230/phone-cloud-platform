import test from "node:test";
import assert from "node:assert/strict";
import {createWecomCausalClock} from "./wecom-causal-clock.mjs";
const business=()=>({taskId:"task-one",jobId:"job-one",lockId:"lock-one",deviceId:"adb:synthetic",serial:"synthetic",agentId:"agent-one",appSlot:"main",androidUser:0,operationFingerprint:"a".repeat(64)});
const verification=()=>({binding:{version:1,obligationId:"physical-one",originalTaskId:"task-one",executionId:"execution-one",deviceId:"adb:synthetic",serial:"synthetic",agentId:"agent-one",appSlot:"main",androidUser:0,nonce:"nonce-one"},verificationId:"verify-one",verificationNonce:"verification-nonce",verificationTaskId:"verify-task"});
function fixture(){let at=0n,counter=0;const clock=createWecomCausalClock({mono:()=>at,id:()=>`id-${++counter}`,epoch:"epoch-one"});return {clock,set:n=>{at=n;},add:n=>{at+=n;}};}
const rejected=fn=>assert.throws(fn,/wecom_cleanup_causal_context_unconfirmed/);
test("business original creation mark, fixed300s and conservative millisecond floor",()=>{const f=fixture(),m=f.clock.mark();f.add(10000000000n);const t=f.clock.businessLease(m,business());assert.equal(f.clock.remaining(t,business()),290000);f.add(1n);assert.equal(f.clock.remaining(t,business()),289999);f.set(300000000000n);assert.equal(f.clock.remaining(t,business()),0);});
test("verification fixed120s from original mark",()=>{const f=fixture(),m=f.clock.mark("verification");f.add(1000000000n);const t=f.clock.verificationLease(m,verification());assert.equal(f.clock.remaining(t,verification()),119000);});
test("marks are owned one-shot and cannot be reconstructed from JSON",()=>{const f=fixture(),m=f.clock.mark();rejected(()=>f.clock.businessLease({},business()));f.clock.businessLease(m,business());rejected(()=>f.clock.businessLease(m,business()));});
test("ticket JSON roundtrip only works in its original service epoch/context",()=>{const f=fixture(),t=f.clock.businessLease(f.clock.mark(),business());assert.equal(f.clock.remaining(JSON.parse(JSON.stringify(t)),business()),300000);const other=fixture();rejected(()=>other.clock.remaining(t,business()));});
for(const key of Object.keys(business()))test(`business context drift rejects: ${key}`,()=>{const f=fixture(),t=f.clock.businessLease(f.clock.mark(),business()),v=business();v[key]=typeof v[key]==="number"?999:`changed-${v[key]}`;rejected(()=>f.clock.remaining(t,v));});
for(const key of ["verificationId","verificationNonce","verificationTaskId"])test(`verification context drift rejects: ${key}`,()=>{const f=fixture(),v=verification(),t=f.clock.verificationLease(f.clock.mark("verification"),v);v[key]+="-changed";rejected(()=>f.clock.challenge(t,v));});
test("old epoch or forged purpose cannot restore authority from wall",()=>{const f=fixture(),t=f.clock.businessLease(f.clock.mark(),business());rejected(()=>f.clock.remaining({...t,epoch:"old"},business()));rejected(()=>f.clock.remaining({...t,purpose:"verification"},business()));});
test("same challenge request returns exact same nonce without resetting3s",()=>{const f=fixture(),v=verification(),t=f.clock.verificationLease(f.clock.mark("verification"),v),c=f.clock.challenge(t,v);f.add(2000000000n);assert.deepEqual(f.clock.challenge(t,v),c);f.add(1000000000n);assert.equal(f.clock.validateChallenge(c,t,v),true);f.add(1n);rejected(()=>f.clock.validateChallenge(c,t,v));});
test("network, decoding and device-gate queue all count in one issue-to-validation window",()=>{const f=fixture(),v=verification(),t=f.clock.verificationLease(f.clock.mark("verification"),v),c=f.clock.challenge(t,v);for(const ns of [600000000n,1200000000n,900000000n,300000001n])f.add(ns);rejected(()=>f.clock.validateChallenge(c,t,v));});
test("wrong nonce, original verification or epoch rejected",()=>{const f=fixture(),v=verification(),t=f.clock.verificationLease(f.clock.mark("verification"),v),c=f.clock.challenge(t,v);rejected(()=>f.clock.validateChallenge({...c,challengeId:"old"},t,v));rejected(()=>f.clock.validateChallenge({...c,epoch:"old"},t,v));rejected(()=>f.clock.validateChallenge(c,t,{...v,verificationNonce:"old"}));});
test("challenge cannot start with3s or less left in120s lease",()=>{const f=fixture(),v=verification(),t=f.clock.verificationLease(f.clock.mark("verification"),v);f.set(117000000000n);rejected(()=>f.clock.challenge(t,v));});
test("monotonic regression poisons this instance; new mark cannot revive it",()=>{const f=fixture(),t=f.clock.businessLease(f.clock.mark(),business());f.set(1n);f.clock.remaining(t,business());f.set(0n);rejected(()=>f.clock.remaining(t,business()));f.set(100n);rejected(()=>f.clock.mark());});
test("non-bigint clock and unsafe scope fail closed",()=>{const c=createWecomCausalClock({mono:()=>0,id:()=>"id",epoch:"epoch"});rejected(()=>c.mark());const f=fixture();rejected(()=>f.clock.businessLease(f.clock.mark(),{...business(),extra:true}));});

test("finite quotas reject before sampling and never evict a pending business or its verification",()=>{
  let calls=0,n=0;const c=createWecomCausalClock({mono:()=>{calls++;return 0n;},id:()=>`id-${++n}`,epoch:"bounded",capacity:1});
  const b=c.businessLease(c.mark(),business()),v=c.verificationLease(c.mark("verification"),verification()),challenge=c.challenge(v,verification());
  const before=c.counts(),samples=calls;
  for(const purpose of ["business","verification"])assert.throws(()=>c.mark(purpose),e=>e.message==="wecom_cleanup_causal_capacity_full"&&e.statusCode===503);
  assert.equal(calls,samples);assert.deepEqual(c.counts(),before);assert.equal(c.remaining(b,business()),300000);assert.equal(c.validateChallenge(challenge,v,verification()),true);
});
test("original mark belongs to one quota and failed pre-bind creation can release only that mark",()=>{
  const c=createWecomCausalClock({mono:()=>0n,epoch:"bounded",capacity:1});
  for(let i=0;i<1000;i++){
    const stamp=c.mark();try{rejected(()=>c.verificationLease(stamp,verification()));assert.throws(()=>{throw Error("synthetic-pre-bind-failure");},/pre-bind-failure/);}finally{assert.equal(c.releaseMark(stamp),true);}
    assert.equal(c.releaseMark(stamp),false);assert.equal(c.counts().business,0);
  }
  const stamp=c.mark(),ticket=c.businessLease(stamp,business());assert.equal(c.releaseMark(stamp),false);assert.equal(c.counts().business,1);
  rejected(()=>c.retire(ticket,{...business(),taskId:"other"}));assert.equal(c.remaining(ticket,business()),300000);
});
test("known completed exact scopes retire challenge and lease IDs without cumulative growth",()=>{
  let n=0;const c=createWecomCausalClock({mono:()=>0n,id:()=>`id-${++n}`,epoch:"bounded",capacity:1});
  for(let i=0;i<1000;i++){
    const b=c.businessLease(c.mark(),business()),v=c.verificationLease(c.mark("verification"),verification());c.challenge(v,verification());
    c.retire(v,verification());c.retire(b,business());assert.deepEqual(c.counts(),{capacity:1,business:0,verification:0,marks:0,leases:0,challenges:0});
    rejected(()=>c.remaining(b,business()));rejected(()=>c.challenge(v,verification()));
  }
});
test("unacknowledged bound creations consume finite capacity rather than replacing original tickets",()=>{
  let n=0;const c=createWecomCausalClock({mono:()=>0n,id:()=>`id-${++n}`,epoch:"bounded",capacity:2}),tickets=[];
  for(let i=0;i<2;i++){
    const stamp=c.mark();try{assert.throws(()=>{tickets.push(c.businessLease(stamp,business()));throw Error("synthetic-persistence-unknown");},/persistence-unknown/);}finally{assert.equal(c.releaseMark(stamp),false);}
  }
  for(let i=0;i<1000;i++)assert.throws(()=>c.mark(),/causal_capacity_full/);
  assert.deepEqual(c.counts(),{capacity:2,business:2,verification:0,marks:0,leases:2,challenges:0});
  for(const ticket of tickets)assert.equal(c.remaining(ticket,business()),300000);
  // Independent quota leaves room for original cleanup, even at full business capacity.
  assert.ok(c.verificationLease(c.mark("verification"),verification()));
});
test("retired ticket cannot revive even when the random ID source repeats",()=>{
  const c=createWecomCausalClock({mono:()=>0n,id:()=>"repeated-random",epoch:"bounded",capacity:1});
  const old=c.businessLease(c.mark(),business());c.retire(old,business());
  const next=c.businessLease(c.mark(),business());assert.notEqual(next.leaseId,old.leaseId);
  rejected(()=>c.remaining(old,business()));assert.equal(c.remaining(next,business()),300000);
});
