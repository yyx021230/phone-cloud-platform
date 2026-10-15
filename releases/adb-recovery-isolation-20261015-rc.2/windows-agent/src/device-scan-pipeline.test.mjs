import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceScanPipeline,recoverySnapshotAdmission} from './device-scan-pipeline.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('stalled recovery never delays second discovery/publication, no duplicate maintenance',async()=>{
 const gate=deferred();let phase=0,calls=0;const published=[];
 const pipeline=createDeviceScanPipeline({discover:async()=>[{adbSerial:'A',state:phase++?'device':'offline'},{adbSerial:'B',state:'device'}],publish:async s=>published.push(s),maintain:async()=>{calls++;await gate.promise;}});
 await pipeline.scan();await pipeline.scan();await pipeline.scan();
 assert.equal(calls,1);assert.equal(published.length,3);assert.equal(published[1].devices[0].state,'device');assert(pipeline.maintenanceActive());gate.resolve();await tick();assert(!pipeline.maintenanceActive());
});
test('failed maintenance is contained; only future scans may start next maintenance',async()=>{
 let publications=0,runs=0;const errors=[];const pipeline=createDeviceScanPipeline({discover:async()=>[],publish:async()=>publications++,maintain:async()=>{runs++;throw Error('PnP failure');},onError:e=>errors.push(e.message)});
 await pipeline.scan();await tick();assert.equal(publications,1);assert.deepEqual(errors,['PnP failure']);await pipeline.scan();await tick();assert.equal(runs,2);
});
test('failed discovery does not publish false empty inventory or start recovery',async()=>{
 let fail=false,pubs=0,maint=0;const gate=deferred();const p=createDeviceScanPipeline({discover:async()=>{if(fail)throw Error('ADB timeout');return [{adbSerial:'B',state:'device'}];},publish:async()=>pubs++,maintain:async()=>{maint++;await gate.promise;}});
 await p.scan();fail=true;await assert.rejects(p.scan(),/ADB timeout/);assert.equal(pubs,1);assert.equal(maint,1);assert.equal(p.snapshot().devices[0].state,'device');gate.resolve();
});
test('in-flight discovery has one owner and publication must complete before recovery',async()=>{
 const read=deferred(),publish=deferred();let maint=0;const p=createDeviceScanPipeline({discover:()=>read.promise,publish:()=>publish.promise,maintain:async()=>maint++});const first=p.scan();assert.equal((await p.scan()).reason,'already_running');read.resolve([]);await tick();assert.equal(maint,0);publish.resolve();await first;assert.equal(maint,1);
});
test('maintenance receives newest isolated snapshot after inventory wait; cannot mutate publication',async()=>{
 const gate=deferred();let phase=0;const seen=[];const p=createDeviceScanPipeline({discover:async()=>[{adbSerial:'A',state:phase++?'unauthorized':'offline'}],publish:async()=>{},maintain:async(s,o,latest)=>{s.devices[0].state='bad';await gate.promise;seen.push(latest().devices[0].state);}});
 await p.scan();await p.scan();assert.equal(p.snapshot().devices[0].state,'unauthorized');gate.resolve();await tick();assert.deepEqual(seen,['unauthorized']);
});
test('command admission rejects stale, newly online or unauthorized target, not unrelated target',()=>{
 const s={observedAt:100,devices:[{adbSerial:'A',state:'device'},{adbSerial:'B',state:'unauthorized'},{adbSerial:'C',state:'offline'}]};assert.equal(recoverySnapshotAdmission(s,'a',{now:101}),'device_became_online');assert.equal(recoverySnapshotAdmission(s,'B',{now:101}),'device_unauthorized');assert.equal(recoverySnapshotAdmission(s,'C',{now:101}),'');assert.equal(recoverySnapshotAdmission(s,'C',{now:40000}),'adb_snapshot_stale');assert.equal(recoverySnapshotAdmission({observedAt:0,devices:[]},'C'),'adb_snapshot_stale');
});
