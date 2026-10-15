import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {createRecoveryIsolation} from './recovery-isolation.mjs';
import {recoverySnapshotAdmission} from './device-scan-pipeline.mjs';
async function harness(t,{mode='adb_reconnect',fail=false,pauseOnPersist=false,onlineOnPersist=false,terminal=false}={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-command-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const isolation=await createRecoveryIsolation({file:path.join(dir,'isolated.json'),agentId:'fixture'});
 const source=await fs.readFile(new URL('./index.mjs',import.meta.url),'utf8');const start=source.indexOf('async function recoverSelectedTarget(serial) {'),end=source.indexOf('  if (batchScope.rescue',start);assert(start>0&&end>start);const fn=source.slice(start,end).trim();
 let calls=0,paused=false,online=false,time=Date.now(),released=0;const observation={state:'adb_offline'},attempts=new Map();
 const ctx={Date:class extends Date{static now(){return time++;}},config:{pnpMaxAutomaticAttemptsPerDevice:5,pnpTargetResetCooldownSeconds:1,pnpTargetRetryMaxSeconds:1,pnpContinuousRecoveryEnabled:true,pnpRecoveryCycleCooldownSeconds:30,pnpTargetAbsentRetrySeconds:30,pnpPostActionProbeSeconds:5,adbPath:'fixture'},
  isSerialBusy:()=>false,observationsBySerial:new Map([['A',observation]]),pnpTargetRecoveryAttempts:attempts,lastDeviceRecoveryObservations:[{...observation,key:'A'}],pnpRecoveryControl:{reason:()=>paused?'device_recovery_paused':''},recoveryIsolation:isolation,
  deviceScanPipeline:{snapshot:()=>({observedAt:Date.now(),devices:online?[{adbSerial:'A',state:'device'}]:[]})},recoverySnapshotAdmission,pnpRecoveryAdmissionReason:()=>'',isPhysicalPnpInventoryReady:()=>true,
  normalizePnpRecoveryTargetState:x=>({...x,attempts:x?.attempts||0,actionHistory:x?.actionHistory||[]}),planPnpRecoveryAction:()=>({mode,attempt:1,terminal,instanceId:'fixture',targetType:'fixture'}),isDeferredPnpRecoveryPlan:()=>false,isAutomaticRecoveryAction:()=>!terminal,
  pnpRecoveryJournal:{record:()=>{}},schedulePnpRecoveryStateSave:()=>{},scheduleNextPnpRecoveryDueWake:()=>{},log:()=>{},safety:{canMutate:true},rescueKeys:new Set(),skipRecoveryIfAdbAlreadyOnline:async()=>false,pnpRecoveryActionBackoffMs:()=>1,
  pnpRecoverySafety:{recordAction:()=>{},health:()=>({}),recordFailure:()=>{}},publicPnpRecoveryHealth:x=>x,lastPnpRecoveryHealth:{},persistPnpRecoveryStateNow:async()=>{if(pauseOnPersist)paused=true;if(onlineOnPersist)online=true;},pnpMissingDeviceRecovery:{markReset:()=>{}},pnpRecoveryWakeScheduler:{schedule:()=>{}},
  pnpScreenCoordinator:{tryBegin:()=>()=>released++},cleanLogText:x=>String(x),
  run:async()=>{calls++;if(fail)throw Error('fixture command failed');return 'ok';},executePnpRecoveryAction:async()=>{calls++;if(fail)throw Error('fixture command failed');return {result:'ok'};}};
 const recover=vm.runInNewContext('('+fn+')',ctx);return {recover,isolation,attempts,calls:()=>calls,released:()=>released};
}
for(const mode of ['adb_reconnect','restart_adb_interface']){
 test(`actual ${mode} branch invokes command and returns result`,async t=>{const h=await harness(t,{mode});assert.equal((await h.recover('A')).status,'action_completed');assert.equal(h.calls(),1);});
 test(`actual ${mode} rejects pause arriving during persistence without consuming command`,async t=>{const h=await harness(t,{mode,pauseOnPersist:true});assert.equal((await h.recover('A')).reason,'device_recovery_paused');assert.equal(h.calls(),0);assert.equal(h.attempts.get('A').attempts,0);});
 test(`actual ${mode} rejects newly online target before command`,async t=>{const h=await harness(t,{mode,onlineOnPersist:true});assert.equal((await h.recover('A')).reason,'device_became_online');assert.equal(h.calls(),0);});
 test(`actual ${mode} stops fourth issued command after three errors`,async t=>{const h=await harness(t,{mode,fail:true});for(let i=0;i<3;i++)assert.equal((await h.recover('A')).status,'action_failed');assert.equal((await h.recover('A')).reason,'device_recovery_isolated');assert.equal(h.calls(),3);});
}
test('actual exhausted ladder isolates target before another cycle',async t=>{const h=await harness(t,{terminal:true});assert.equal((await h.recover('A')).status,'quarantined');assert.equal(h.calls(),0);assert.equal(h.isolation.reason('A'),'device_recovery_isolated');});
