import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createManagedLookupStore} from './managed-lookup-store.mjs';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
import {canDeliverManagedLookupTask} from './managed-lookup-delivery.mjs';

test('legacy-memory task remains invisible to Agent until entire managed transaction commits',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'managed-admission-'));
  let release, entered;
  const blocked=new Promise(r=>entered=r), continueSave=new Promise(r=>release=r);
  const store=await createManagedLookupStore({file:path.join(temp,'state.json'),persistLegacy:async()=>{entered();await continueSave;}});
  t.after(async()=>{release();await store.close();await fs.rm(temp,{recursive:true,force:true});});
  const state={devices:[{deviceId:'fixture'}],automationJobs:[],automationSessions:[],windowsTasks:[],deviceLocks:[],audit:[]};
  let counter=0,throwOnLock=false;
  const adapter=createManagedLookupAdapter({state,userFor:()=>({userId:'owner'}),
    createSession:input=>{const s={...input,sessionId:'s'+ ++counter};state.automationSessions.push(s);return s;},
    createJob:input=>{const j={...input,jobId:'j'+ ++counter};state.automationJobs.push(j);return j;},
    acquireLock:()=>{const lock={lockId:'l'+ ++counter};state.deviceLocks.push(lock);if(throwOnLock)throw Error('injected lock conflict');return lock;},
    queueTask:(_d,j)=>{const task={taskId:'t'+ ++counter,type:j.kind,payload:{}};state.windowsTasks.push(task);return task;}});
  const transaction=store.transact(async(s,tx)=>{const c={deviceId:'fixture',clientId:'client',generation:'fixture-generation'};await adapter.start(c,{},tx);s.channels.push(c);});
  await blocked;assert.equal(state.windowsTasks.length,1);assert.equal(store.snapshot().channels.length,0);
  assert.equal(canDeliverManagedLookupTask(state.windowsTasks[0]),false,'in-memory task must not be leased before state/task persistence');
  release();await transaction;assert.equal(store.snapshot().channels.length,1);assert.equal(canDeliverManagedLookupTask(state.windowsTasks[0]),true);
  await assert.rejects(store.transact(async(s,tx)=>{await adapter.start({deviceId:'fixture',clientId:'client',generation:'second'}, {},tx);throw Error('injected failure');}),/injected failure/);
  assert.equal(state.windowsTasks.length,1,'failed transaction removes only its own new task');
  throwOnLock=true;await assert.rejects(store.transact(async(s,tx)=>adapter.start({deviceId:'fixture',clientId:'client',generation:'third'}, {},tx)),/injected lock conflict/);
  assert.equal(state.automationSessions.length,1);assert.equal(state.automationJobs.length,1);assert.equal(state.deviceLocks.length,1);assert.equal(state.windowsTasks.length,1);
});
