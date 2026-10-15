import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPnpRecoveryControl,RECOVERY_CONTROL_PROTOCOL as protocol} from './pnp-recovery-control.mjs';
const input=(revision,serials=[])=>({protocol,revision,paused:serials.map(serial=>({serial,reason:'fixture pause',updatedAt:'fixture'}))});
const barrier=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
async function fixture(t,options={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pnp-pause-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const opts={file:path.join(dir,'control.json'),agentId:'fixture-agent',...options};return {opts,control:await createPnpRecoveryControl(opts)};}
test('startup waits for authoritative state; pause18 never blocks130; persists across restart',async t=>{
 const {opts,control:c}=await fixture(t);assert.equal(c.reason('130'),'recovery_controls_not_synced');await c.apply(input(0));assert.equal(c.reason('130'),'');await c.apply(input(1,['18']));assert.equal(c.reason('18'),'device_recovery_paused');assert.equal(c.reason('130'),'');const restarted=await createPnpRecoveryControl(opts);assert.equal(restarted.reason('130'),'recovery_controls_not_synced');await restarted.apply(input(1,['18']));assert.equal(restarted.reason('18'),'device_recovery_paused');await restarted.apply(input(2));assert.equal(restarted.reason('18'),'');
});
test('new pause blocks immediately while persistence waits; ack only after write',async t=>{
 let slow=false;const b=barrier();const {control:c}=await fixture(t,{write:async()=>{if(slow)await b.promise;}});await c.apply(input(0));slow=true;const pending=c.apply(input(1,['18']));assert.equal(c.reason('18'),'device_recovery_paused');assert.equal(c.reason('130'),'');assert.equal(c.health().revision,0);b.release();await pending;assert.equal(c.health().revision,1);
});
test('queued later pause survives earlier write finishing',async t=>{
 let count=0;const first=barrier(),second=barrier();const {control:c}=await fixture(t,{write:async()=>{if(++count===2)await first.promise;else if(count===3)await second.promise;}});await c.apply(input(0));const a=c.apply(input(1,['18']));await Promise.resolve();const b=c.apply(input(2,['18','130']));first.release();await a;assert.equal(c.reason('130'),'device_recovery_paused');second.release();await b;assert.equal(c.health().revision,2);
});
test('failed pause write is not acknowledged and blocks only that target; retry recovers',async t=>{
 let fail=false;const {control:c}=await fixture(t,{write:async()=>{if(fail)throw Error('disk unavailable');}});await c.apply(input(0));fail=true;await assert.rejects(c.apply(input(1,['18'])));assert.equal(c.reason('18'),'device_recovery_paused');assert.equal(c.reason('130'),'');assert.equal(c.health().revision,0);fail=false;await c.apply(input(1,['18']));assert.equal(c.health().revision,1);
});
test('failed resume never clears existing pause; stale and conflicting responses rejected',async t=>{
 let fail=false;const {control:c}=await fixture(t,{write:async()=>{if(fail)throw Error('disk');}});await c.apply(input(1,['18']));fail=true;await assert.rejects(c.apply(input(2)));assert.equal(c.reason('18'),'device_recovery_paused');await assert.rejects(c.apply(input(0)),/stale/);await assert.rejects(c.apply(input(1)),/conflicting/);assert.equal(c.reason('18'),'device_recovery_paused');
});
test('corrupt persisted state blocks recovery until new authenticated control arrives',async t=>{
 const {opts}=await fixture(t);await fs.writeFile(opts.file,'broken');const c=await createPnpRecoveryControl(opts);assert.equal(c.reason('130'),'recovery_controls_not_synced');await c.apply(input(2,['18']));assert.equal(c.reason('130'),'');
});
test('invalid, duplicate or unsupported control does not clear pause',async t=>{
 const {control:c}=await fixture(t);await c.apply(input(1,['18']));for(const bad of [null,{},input(2,['18','18']),input(2,['*']),{...input(2),protocol:'other'}])await assert.rejects(c.apply(bad));assert.equal(c.reason('18'),'device_recovery_paused');
});
test('real Agent integration has filters, heartbeat delivery, and final guards after both persistence waits',async()=>{
 const source=await fs.readFile(new URL('./index.mjs',import.meta.url),'utf8');
 assert.match(source,/await pnpRecoveryControl\.apply\(response.agent\?\.recoveryControl\)/);
 assert.match(source,/plan.resetSerials\s*\.filter\(serial => !\(pnpRecoveryControl.reason\(serial\) \|\| recoveryIsolation.reason\(serial\)\)\)/);
 assert.match(source,/const reason = \(pnpRecoveryControl.reason\(serial\) \|\| recoveryIsolation.reason\(serial\)\) \|\| recoverySnapshotAdmission\(deviceScanPipeline.snapshot\(\),serial\) \|\| pnpRecoveryAdmissionReason/);
 const mutation = source.indexOf('const result = await executePnpRecoveryAction(target)');
 const persisted = source.lastIndexOf('await persistPnpRecoveryStateNow();', mutation);
 const boundary = source.slice(persisted, mutation);
 assert.match(boundary,/await inspectWindowsDeviceInstallActivity\(\)/);
 assert.match(boundary,/if \(installer.busy\)/);
 const guard = boundary.indexOf('const paused = pauseBeforeCommand();');
 assert(guard > boundary.indexOf('await inspectWindowsDeviceInstallActivity()'));
 assert.match(boundary.slice(guard),/if \(paused\) return paused;/);
 assert.match(boundary.slice(guard),/if \(isSerialBusy\(serial\)\)/);
 assert(!boundary.slice(guard).includes('await '),'no async gap after final guards');
 assert.match(boundary.slice(guard),/pnpRecoverySafety.recordAction\(\);\s*commandIssued=true;/);
 assert.match(source,/await persistPnpRecoveryStateNow\(\);\s*const paused = pauseBeforeCommand\(\);\s*if \(paused\) return paused;\s*pnpRecoverySafety.recordAction\(\);\s*commandIssued=true;\s*const output = await run\(config.adbPath/);
});
