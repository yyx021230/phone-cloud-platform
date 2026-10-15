import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createRecoveryIsolation} from './recovery-isolation.mjs';
async function fixture(t,options={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-isolation-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const args={file:path.join(dir,'state.json'),agentId:'fixture',...options};return {args,store:await createRecoveryIsolation(args)};}
test('three failed commands isolate only that target; duplicate outcomes count once; restart and reconnect do not release',async t=>{
 const {store,args}=await fixture(t);await store.failure('a','1');await store.failure('a','1');await store.failure('a','2');assert.equal(store.reason('a'),'');await store.failure('a','3');assert.equal(store.reason('A'),'device_recovery_isolated');assert.equal(store.reason('B'),'');await store.confirmed('A');assert.equal(store.reason('A'),'device_recovery_isolated');const restart=await createRecoveryIsolation(args);assert.equal(restart.reason('A'),'device_recovery_isolated');assert.equal(restart.health().isolated[0].failures,3);
});
test('exhausted action ladder isolates without another destructive cycle',async t=>{const {store}=await fixture(t);await store.isolate('A');assert.equal(store.reason('A'),'device_recovery_isolated');assert.equal(store.health().isolated[0].reason,'recovery_attempts_exhausted');});
test('verified stable recovery clears pre-isolation failures; command ACK alone does not',async t=>{const {store}=await fixture(t);await store.failure('A','1');await store.failure('A','2');await store.confirmed('A');await store.failure('A','3');assert.equal(store.reason('A'),'');});
test('explicit target release persists; repeated heartbeat release cannot clear a new incident',async t=>{
 const {store,args}=await fixture(t);await store.isolate('A');await store.isolate('B');const control={releases:[{serial:'A',revision:2}]};assert.deepEqual(await store.release(control),['A']);assert.equal(store.reason('A'),'');assert.equal(store.reason('B'),'device_recovery_isolated');await store.isolate('A');await store.release(control);assert.equal(store.reason('A'),'device_recovery_isolated');const restart=await createRecoveryIsolation(args);await restart.release(control);assert.equal(restart.reason('A'),'device_recovery_isolated');
});
test('failed persistence blocks mutations; failed release cannot open target; retries can persist',async t=>{
 let fail=false;const {store}=await fixture(t,{write:async()=>{if(fail)throw Error('disk full');}});await store.isolate('A');fail=true;await assert.rejects(store.release({releases:[{serial:'A',revision:1}]}));assert.equal(store.reason('A'),'recovery_isolation_save_failed');assert.equal(store.health().isolated[0].serial,'A');fail=false;await store.release({releases:[{serial:'A',revision:1}]});assert.equal(store.reason('A'),'');
});
test('corrupt or foreign isolation file is preserved and fails closed, business discovery unaffected',async t=>{
 const {args}=await fixture(t);await fs.writeFile(args.file,'invalid');const store=await createRecoveryIsolation(args);assert.equal(store.reason('A'),'recovery_isolation_load_failed');await assert.rejects(store.release({releases:[]}));assert.equal(await fs.readFile(args.file,'utf8'),'invalid');
});
test('concurrent failures and release serialize; releasing A never drops failure evidence on B',async t=>{
 const {store}=await fixture(t);await Promise.all([store.failure('B','1'),store.release({releases:[{serial:'A',revision:1}]}),store.failure('B','2'),store.failure('B','3')]);assert.equal(store.reason('B'),'device_recovery_isolated');assert.equal(store.reason('A'),'');
});
