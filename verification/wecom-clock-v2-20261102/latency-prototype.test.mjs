import test from 'node:test';
import assert from 'node:assert/strict';
import {offlineExperiment} from './latency-prototype.mjs';

test('offline actual child + HTTP stays within 3s, with both synthetic frames and real close',async()=>{
  for(const wallOffsetMs of [-300000,0,300000]) {
    const r=await offlineExperiment({wallOffsetMs});
    assert.equal(r.fixtureOnly,true);assert.equal(r.nativeSystemProof,false);assert.equal(r.androidFacts,'synthetic');
    assert.equal(r.accepted,true,JSON.stringify(r));assert.equal(r.actualChildClosed,true);
    assert.equal(r.operations,6);assert.ok(r.serverAgeMs<3000);
    assert.ok(r.events.indexOf('challenge_response_received')<r.events.indexOf('synthetic_first_fact'));
    assert.ok(r.events.indexOf('actual_child_close')<r.events.indexOf('fixture_proof_after_actual_close'));
  }
});
for(const fault of ['wrong_pid','old_nonce','early_fact']) test(`offline ${fault} cannot reach proof`,async()=>{
  const r=await offlineExperiment({fault});assert.equal(r.accepted,false);assert.equal(r.proofSent,false);
  assert.equal(r.reason,fault==='early_fact'?'fixture_fact_before_challenge':'fixture_ready_binding_invalid');
});
test('actual child close cost is included, never restamped after close',{timeout:7000},async()=>{
  const r=await offlineExperiment({closeDelayMs:3000});assert.equal(r.actualChildClosed,true);
  assert.equal(r.accepted,false);assert.equal(r.reason,'fixture_server_challenge_expired');assert.ok(r.serverAgeMs>3000);
});
test('challenge response latency plus reads plus close can exhaust the same 3s window',{timeout:7000},async()=>{
  const r=await offlineExperiment({challengeResponseDelayMs:2700,closeDelayMs:250});
  assert.equal(r.actualChildClosed,true);assert.equal(r.accepted,false);assert.equal(r.reason,'fixture_server_challenge_expired');
});
test('slow synthetic reads retain all guards and reject rather than skip a frame',{timeout:7000},async()=>{
  const r=await offlineExperiment({readDelayMs:600});assert.equal(r.accepted,false);
  assert.equal(r.reason,'fixture_local_facts_expired');assert.equal(r.proofSent,false);
});
test('simulated epoch change cannot consume an old challenge even within 3s',async()=>{
  const r=await offlineExperiment({restartBeforeProof:true});assert.equal(r.accepted,false);
  assert.equal(r.reason,'fixture_binding_or_epoch_invalid');assert.equal(r.actualChildClosed,true);
});
