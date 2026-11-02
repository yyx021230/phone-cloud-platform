// Action decisions must sample synchronously; a background observer is optional.
// These tests are offline numeric traces, not real OS freshness attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OfflineClockModel,OfflineTaskBudgets,syntheticProfile,fixtureSample} from './model.mjs';
const sample=(sequence,bootMs,workMs=bootMs)=>fixtureSample({sequence,bootUs:BigInt(bootMs)*1000n,workUs:BigInt(workMs)*1000n});
const budget=120_000_000n;
function ready(){
  const r=new OfflineTaskBudgets(syntheticProfile());r.observe(sample(1,1000));
  r.issue('fixture-one',budget,sample(2,1010));return r;
}

test('one observation and issue cannot authorize repeated decisions without new samples',()=>{
  const r=ready();
  assert.throws(()=>r.permits('fixture-one'),/sample_invalid/);
  assert.throws(()=>r.permits('fixture-one'),/sample_invalid/);
  assert.equal(r.statuses()[0].status,'maintenance');
});
test('proof gate with no fresh sample refuses instead of reading its last snapshot',()=>{
  const m=new OfflineClockModel(syntheticProfile()),a=m.observe(sample(1,1000));
  assert.throws(()=>m.proofWithinThreeSeconds(a),/sample_invalid/);
});
test('pause first arrives through proof decision, without prior background observation',()=>{
  const m=new OfflineClockModel(syntheticProfile()),a=m.observe(sample(1,1000));
  assert.throws(()=>m.proofWithinThreeSeconds(a,sample(2,11000,1000)),/os_pause_observed/);
});
test('pause first arrives through task decision and invalidates all outstanding tasks',()=>{
  const r=ready();r.issue('fixture-two',budget,sample(3,1020));
  assert.throws(()=>r.permits('fixture-one',sample(4,11020,1020)),/os_pause_observed/);
  assert.deepEqual(r.statuses().map(x=>x.status),['maintenance','maintenance']);
  assert.throws(()=>r.permits('fixture-two',sample(5,11030,1030)),/os_pause_observed/);
});
test('a proof sample is consumed once and its sequence cannot be replayed',()=>{
  const m=new OfflineClockModel(syntheticProfile()),a=m.observe(sample(1,1000)),s=sample(2,1010);
  assert.equal(m.proofWithinThreeSeconds(a,s),true);
  assert.throws(()=>m.proofWithinThreeSeconds(a,s),/sample_sequence_changed/);
});
test('healthy task decisions require fresh samples every time, including the second action',()=>{
  const r=ready();assert.equal(r.permits('fixture-one',sample(3,1020)),true);
  const second=sample(4,1030);assert.equal(r.permits('fixture-one',second),true);
  assert.throws(()=>r.permits('fixture-one',second),/sample_sequence_changed/);
  assert.equal(r.statuses()[0].status,'maintenance');
});
test('new budget issuance also refuses to reuse the last observation',()=>{
  const r=new OfflineTaskBudgets(syntheticProfile());r.observe(sample(1,1000));
  assert.throws(()=>r.issue('fixture-one',budget),/sample_invalid/);
  assert.equal(r.statuses().some(x=>x.status==='active'),false);
});
