import test from 'node:test';import assert from 'node:assert/strict';
import {createLookupHumanObserver} from './lookup-human-observer.mjs';
async function run({powers=['mWakefulness=Awake'],state='search_ready',busy=false,throws=false}={}){
 const reports=[],calls=[];let i=0;
 const observer=createLookupHumanObserver({agentId:'synthetic',canObserve:()=>!busy,readPower:async()=>{calls.push('power');if(throws)throw Error('private-error-text');return powers[Math.min(i++,powers.length-1)];},observe:async()=>{calls.push('page');return state;},request:async(_p,o)=>{if(o.method==='POST')reports.push(o.body);return {probes:[{probeId:'lease',adbSerial:'synthetic'}]};}});
 await observer.poll();return {reports,calls};
}
test('sleeping phone reports screen_off without reading or claiming a cleared page',async()=>{const r=await run({powers:['mWakefulness=Asleep']});assert.equal(r.reports[0].state,'screen_off');assert.equal(r.reports[0].reason,'screen_off');assert.deepEqual(r.calls,['power']);});
test('wakefulness must remain awake across the page read',async()=>{const r=await run({powers:['mWakefulness=Awake','mWakefulness=Asleep']});assert.equal(r.reports[0].state,'screen_off');assert.deepEqual(r.calls,['power','page','power']);});
test('unknown or failed power read is never a confirmed page or a fake puzzle',async()=>{for(const input of [{powers:['invalid']},{throws:true},{powers:['mWakefulness=Awake\nmWakefulness=Asleep']}]){const r=await run(input);assert.equal(r.reports[0].state,'unknown');assert.equal(r.reports[0].reason,'power_unavailable');assert.doesNotMatch(JSON.stringify(r.reports),/private-error/);assert.deepEqual(r.calls,['power']);}});
test('awake result and real puzzle retain distinct bounded telemetry',async()=>{for(const state of ['search_ready','present']){const r=await run({state});assert.equal(r.reports[0].state,state);assert.equal(r.reports[0].reason,state==='present'?'verification_present':'search_ready');assert.ok(r.reports[0].readDurationMs>=0&&r.reports[0].readDurationMs<=30000);assert.deepEqual(r.calls,['power','page','power']);}});
test('busy phones are not touched and report a distinct reason',async()=>{const r=await run({busy:true});assert.equal(r.reports[0].reason,'device_busy');assert.equal(r.reports[0].state,'unknown');assert.deepEqual(r.calls,[]);});

test('consistent wakefulness groups are accepted, transition or contradictory groups are not',async()=>{assert.equal((await run({powers:['mWakefulness=Awake\n  mWakefulness=Awake']})).reports[0].state,'search_ready');assert.equal((await run({powers:['mWakefulness=Waking']})).reports[0].state,'unknown');});
