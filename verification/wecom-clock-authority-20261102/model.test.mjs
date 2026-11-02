import test from 'node:test';
import assert from 'node:assert/strict';
import {OfflineClockModel,OfflineTaskBudgets,syntheticProfile,fixtureSample} from './model.mjs';
const us=ms=>BigInt(ms)*1000n;
function trace(os='linux',changes={}){
  const model=new OfflineClockModel(syntheticProfile(os,changes));let n=1,now=us(1000);
  const anchor=model.observe(fixtureSample({bootUs:now,sequence:n}));
  const next=(ms,extra={})=>{now+=us(ms);return fixtureSample({sequence:++n,bootUs:now,...extra});};
  const step=(ms,extra={})=>model.observe(next(ms,extra));
  return{model,anchor,step,next};
}

for(const os of ['linux','windows']){
  test(`${os}: bounded samples count 3s using interval upper bound, not nominal time`,()=>{
    const t=trace(os);for(let n=0;n<29;n++)t.step(100);
    assert.equal(t.model.proofWithinThreeSeconds(t.anchor,t.next(0)),true);
    t.step(100);assert.equal(t.model.proofWithinThreeSeconds(t.anchor,t.next(0)),false);
  });
  test(`${os}: 10s OS suspend poisons epoch from boot/work interval gap`,()=>{
    const t=trace(os);
    assert.throws(()=>t.step(10000,{workUs:us(1000)}),/os_pause_observed/);
    assert.throws(()=>t.model.proofWithinThreeSeconds(t.anchor),/os_pause_observed/);
  });
  test(`${os}: event-loop blockage counts as monitor gap, not continuity success`,()=>{
    const t=trace(os);assert.throws(()=>t.step(2000),/monitor_gap_unknown/);
  });
}

for(const key of ['hostId','bootId','processEpoch','timeDomain','sourceId'])test(`changed ${key} rejects old authority`,()=>{
  const t=trace();const s=fixtureSample({sequence:2,bootUs:us(1010)});s.domain[key]='fixture-other';
  assert.throws(()=>t.model.observe(s),/domain_changed/);
  assert.throws(()=>t.model.snapshotAge(t.anchor),/domain_changed/);
});
for(const direction of [-1,1])test(`local wall ${direction>0?'forward':'backward'} jump cannot extend a lease`,()=>{
  const t=trace();const s=fixtureSample({sequence:2,bootUs:us(1010)});s.wallBeforeUs+=us(direction*10000);s.wallAfterUs=s.wallBeforeUs;
  assert.throws(()=>t.model.observe(s),/local_wall_discontinuity|counter_regression/);
  assert.throws(()=>t.model.snapshotRemainingLowerBound(300_000_000n,t.anchor),/local_wall_discontinuity|counter_regression/);
});
test('constant wall offset never becomes an offset estimate from another host',()=>{
  for(const offset of [-300000,300000]){
    const m=new OfflineClockModel(syntheticProfile());
    const sample=n=>fixtureSample({sequence:n,bootUs:us(n*100),wallUs:us(1_790_000_000_000+offset+n*100)});
    const a=m.observe(sample(1));assert.equal(m.proofWithinThreeSeconds(a,sample(2)),true);
  }
});
test('counter rollback, wide read bracket, missing sample and continuity flag fail closed',()=>{
  for(const alter of [s=>{s.bootBeforeUs=us(900);s.bootAfterUs=us(900);},s=>{s.bootAfterUs+=us(150);},
    s=>{s.sequence=3;},s=>{s.continuity=true;}]){
    const t=trace();const s=fixtureSample({sequence:2,bootUs:us(1010)});alter(s);
    assert.throws(()=>t.model.observe(s),/counter_regression|sample_span_unbounded|sample_sequence_changed|sample_invalid/);
    assert.throws(()=>t.model.proofWithinThreeSeconds(t.anchor),/offline_clock_/);
  }
});
test('profile needs explicit bounds; ordinary hrtime and .NET wrapper are not selected sources',()=>{
  assert.throws(()=>new OfflineClockModel(syntheticProfile('linux',{bootErrorUs:null})),/profile_unbounded/);
  assert.throws(()=>new OfflineClockModel(syntheticProfile('linux',{scope:'unmeasured-current-production'})),/profile_unbounded/);
  assert.throws(()=>new OfflineClockModel(syntheticProfile('linux',{apis:{boot:'process.hrtime',work:'performance.now',wall:'Date.now'}})),/source_not_selected/);
  assert.throws(()=>new OfflineClockModel(syntheticProfile('windows',{apis:{boot:'Environment.TickCount64',work:'QueryUnbiasedInterruptTimePrecise',wall:'GetSystemTimePreciseAsFileTime'}})),/source_not_selected/);
});
test('uncharacterized VM rejects even harmless samples or continuity=true',()=>{
  for(const extra of [{}, {continuity:true}])assert.throws(()=>new OfflineClockModel(syntheticProfile('linux',{
    environment:'uncharacterized-production-vm',...extra})),/vm_pause_uncharacterized|profile_unbounded/);
});
test('indistinguishable VM freeze trace demonstrates a real observability limit',()=>{
  // A VM can expose the same guest trace after 10ms work or after an unseen
  // 10s freeze + 10ms work if every guest counter pauses. No predicate on this
  // identical trace can establish which real interval occurred.
  const ordinary=[fixtureSample(),fixtureSample({sequence:2,bootUs:us(1010)})];
  const hiddenFreeze=structuredClone(ordinary);assert.deepEqual(ordinary,hiddenFreeze);
  assert.throws(()=>new OfflineClockModel(syntheticProfile('linux',{environment:'uncharacterized-production-vm'})),/vm_pause_uncharacterized/);
  // Deliberately show why the assumed OS-semantics profile is NOT evidence
  // about a real VM: it cannot magically detect a freeze absent in its inputs.
  const conditional=new OfflineClockModel(syntheticProfile());const a=conditional.observe(ordinary[0]);
  assert.equal(conditional.proofWithinThreeSeconds(a,hiddenFreeze[1]),true);
});
test('stamps from another model and fabricated stamps cannot revive old budgets',()=>{
  const a=trace(),b=trace();assert.throws(()=>b.model.snapshotAge(a.anchor),/foreign_stamp/);
  assert.throws(()=>a.model.snapshotAge({fixtureOnly:true,sequence:1}),/foreign_stamp/);
  assert.throws(()=>a.model.snapshotRemainingLowerBound(3_000_001n,a.anchor),/budget_changed/);
});
test('full RTT upper bound reduces a received lease and preserves strict 3s margin',()=>{
  const server=trace('linux'),client=trace('windows');
  server.step(100);client.step(200);
  const remaining=server.model.snapshotRemainingLowerBound(300_000_000n,server.anchor);
  const received=client.model.snapshotReceiveLeaseLowerBound(remaining,client.anchor);
  assert.ok(received<=remaining-us(240)); // 200ms plus two synthetic 20ms errors.
  assert.equal(client.model.snapshotReceiveLeaseLowerBound(us(3200),client.anchor)>us(3000),false);
  assert.throws(()=>client.model.snapshotReceiveLeaseLowerBound(300_000_001n,client.anchor),/remaining_invalid/);
});
test('quantization/noise grid never accepts an actually older-than-3s fact under its stated bounds',()=>{
  const error=20_000n;
  for(const trueAge of [us(2900),us(2980),us(3000),us(3001),us(3040)]){
    for(const e0 of [-error,0n,error])for(const e1 of [-error,0n,error]){
      const p=syntheticProfile('windows',{rateErrorPpm:0n,maxMonitorGapUs:us(4000)});
      const model=new OfflineClockModel(p),start=us(1000)+e0,end=us(1000)+trueAge+e1;
      const first=model.observe(fixtureSample({bootUs:start}));model.observe(fixtureSample({sequence:2,bootUs:end}));
      const age=model.snapshotAge(first);assert.ok(age.lowerUs<=trueAge&&age.upperUs>=trueAge);
      if(trueAge>us(3000))assert.equal(model.proofWithinThreeSeconds(first,fixtureSample({sequence:3,bootUs:end})),false);
    }
  }
});

test('exact 3000ms age upper bound permits; one microsecond more rejects',()=>{
  for(const [age,accepted] of [[3_000_000n,true],[3_000_001n,false]]){
    const t=trace('linux',{bootErrorUs:0n,workErrorUs:0n,wallErrorUs:0n,rateErrorPpm:0n,maxMonitorGapUs:us(4000)});
    t.model.observe(fixtureSample({sequence:2,bootUs:us(1000)+age}));
    assert.equal(t.model.snapshotAge(t.anchor).upperUs,age);
    assert.equal(t.model.proofWithinThreeSeconds(t.anchor,fixtureSample({sequence:3,bootUs:us(1000)+age})),accepted);
  }
});
test('remaining lower bound exactly 3000ms or one microsecond less cannot pass strict business margin',()=>{
  const t=trace('windows',{bootErrorUs:0n,workErrorUs:0n,wallErrorUs:0n,rateErrorPpm:0n});t.step(100);
  for(const remaining of [3_000_000n,2_999_999n]){
    const result=t.model.snapshotReceiveLeaseLowerBound(remaining+us(100),t.anchor);
    assert.equal(result,remaining);assert.equal(result>us(3000),false);
  }
  assert.equal(t.model.snapshotReceiveLeaseLowerBound(3_100_001n,t.anchor)>us(3000),true);
});
test('BigInt negative, oversized and wrong-type readings cannot issue an authority',()=>{
  for(const value of [-1n,2n**63n,NaN,1.5,undefined]){
    const t=trace();const s=fixtureSample({sequence:2,bootUs:us(1010)});s.bootBeforeUs=value;
    assert.throws(()=>t.model.observe(s),/sample_invalid/);
    assert.throws(()=>t.model.snapshotAge(t.anchor),/sample_invalid/);
  }
  for(const changed of [{bootErrorUs:-1n},{rateErrorPpm:1_000_000n},{maxSampleSpanUs:2n**63n}]){
    assert.throws(()=>new OfflineClockModel(syntheticProfile('linux',changed)),/profile_unbounded/);
  }
  const t=trace();for(const value of [-1n,2n**63n,NaN])assert.throws(()=>t.model.snapshotReceiveLeaseLowerBound(value,t.anchor),/remaining_invalid/);
});
test('rate error and read brackets are conservatively deducted, never added to a budget',()=>{
  const m=new OfflineClockModel(syntheticProfile('linux',{bootErrorUs:0n,workErrorUs:0n,wallErrorUs:0n,rateErrorPpm:10_000n,maxMonitorGapUs:us(4000)}));
  const a=m.observe(fixtureSample());m.observe(fixtureSample({sequence:2,bootUs:us(3990)}));
  assert.ok(m.snapshotAge(a).upperUs>us(3000));
  assert.equal(m.proofWithinThreeSeconds(a,fixtureSample({sequence:3,bootUs:us(3990)})),false);
  const b=new OfflineClockModel(syntheticProfile('windows',{rateErrorPpm:0n,maxSampleSpanUs:us(100)}));
  const start=b.observe(fixtureSample({spanUs:us(10)}));b.observe(fixtureSample({sequence:2,bootUs:us(1100),spanUs:us(10)}));
  assert.equal(b.snapshotAge(start).upperUs,us(150)); // 100 elapsed + 10 bracket + 40 error.
});
test('pause invalidates every outstanding ticket from numeric observations, not an injected poison flag',()=>{
  const r=new OfflineTaskBudgets(syntheticProfile('windows'));r.observe(fixtureSample());
  r.issue('fixture-one',120_000_000n,fixtureSample({sequence:2,bootUs:us(1001)}));
  r.issue('fixture-two',3_000_000n,fixtureSample({sequence:3,bootUs:us(1002)}));
  assert.throws(()=>r.observe(fixtureSample({sequence:4,bootUs:us(11002),workUs:us(1002)})),/os_pause_observed/);
  assert.deepEqual(r.statuses().map(x=>x.status),['maintenance','maintenance']);
  assert.throws(()=>r.permits('fixture-one'),/os_pause_observed/);assert.throws(()=>r.permits('fixture-two'),/os_pause_observed/);
  assert.throws(()=>r.issue('fixture-new',3_000_000n),/os_pause_observed/);
});
test('new epoch or JSON restart cannot silently rearm an old task with a fresh origin',()=>{
  const old=new OfflineTaskBudgets(syntheticProfile());old.observe(fixtureSample());
  old.issue('fixture-original',120_000_000n,fixtureSample({sequence:2,bootUs:us(1001)}));
  const snapshot=JSON.parse(JSON.stringify(old.snapshot()));
  const changed=fixtureSample({sequence:3,bootUs:us(1010)});changed.domain.processEpoch='fixture-new-epoch';
  assert.throws(()=>old.observe(changed),/domain_changed/);assert.throws(()=>old.permits('fixture-original'),/domain_changed/);
  const restored=new OfflineTaskBudgets(syntheticProfile(),{restored:snapshot});
  const first=fixtureSample();first.domain.processEpoch='fixture-new-epoch';restored.observe(first);
  const current=fixtureSample({sequence:2,bootUs:us(1001)});current.domain.processEpoch='fixture-new-epoch';
  assert.equal(restored.permits('fixture-original',current),false);
  assert.throws(()=>restored.issue('fixture-original',120_000_000n),/old_task_no_rearm/);
  assert.equal(restored.statuses()[0].status,'maintenance');
});
test('business action gate samples before checking margin and refuses a missing or reused sequence',()=>{
  const fresh=trace('windows');
  const s=fresh.next(100);
  assert.equal(fresh.model.businessLeaseWithinMargin(120_000_000n,fresh.anchor,s),true);
  assert.throws(()=>fresh.model.businessLeaseWithinMargin(120_000_000n,fresh.anchor,s),/sample_sequence_changed/);
  const absent=trace('windows');
  assert.throws(()=>absent.model.businessLeaseWithinMargin(120_000_000n,absent.anchor),/sample_invalid/);
});
test('a direct proof decision detects a stalled observer instead of reusing the old age',()=>{
  const t=trace();
  assert.throws(()=>t.model.proofWithinThreeSeconds(t.anchor,t.next(2000)),/monitor_gap_unknown/);
  assert.throws(()=>t.model.proofWithinThreeSeconds(t.anchor,t.next(1)),/monitor_gap_unknown/);
});
