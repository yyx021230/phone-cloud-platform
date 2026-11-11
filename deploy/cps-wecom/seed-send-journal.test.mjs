import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {seedSendJournal}from './seed-send-journal.mjs';
import {createStore}from '../../server/cps-wecom/store.mjs';
import {createService}from '../../server/cps-wecom/service.mjs';
function source(key='preview-main',state='not_sent',id='101'){
 const recipient={key:'a'.repeat(64),physicalKey:'b'.repeat(64),appId:'fixture',leadId:id,state,updatedAt:1};
 const lead={appId:'fixture',leadId:id,fingerprint:'c'.repeat(64),recipientKey:recipient.key,stage:'needs_attention',attempts:0,outcome:null};
 return {key,data:{version:2,revision:2,executionMode:'preview',leads:[lead],recipients:[recipient],nonces:[],limits:[]}};
}
test('a separate send journal preserves preview rows and stronger old recipient guards without replay',async t=>{
 const first=source(),second=source('preview-pilot','unknown','102');second.data.recipients[0].updatedAt=0;
 const inputs=[first,second],before=structuredClone(inputs),seed=seedSendJournal(inputs);
 assert.deepEqual(inputs,before);assert.equal(seed.executionMode,'send');assert.equal(seed.leads.length,2);assert.equal(seed.recipients[0].state,'unknown');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cps-send-seed-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'journal.json');await fs.writeFile(file,JSON.stringify(seed));const store=await createStore({file});
 const service=createService({store,clients:new Map(),platform:{mode:'send',submit:()=>assert.fail('must not execute old preview')},fetchImpl:()=>assert.fail('must not callback old preview')});
 await service.initialize();await service.tick();assert.equal(store.snapshot().leads.length,2);await service.close();
});
for(const stage of ['queued','dispatching','submitted','reconcile','callback_pending','callback_inflight','completed'])test('reject source work stage '+stage,()=>{
 const s=source();s.data.leads[0].stage=stage;assert.throws(()=>seedSendJournal([s]),/ineligible/);
});
test('newer not-sent cannot erase an older unknown, confirmed, or existing-contact guard',()=>{
 for(const state of ['unknown','request_confirmed','already_contact']){const a=source('preview-old',state),b=source('preview-new','not_sent','102');b.data.recipients[0].updatedAt=100;assert.equal(seedSendJournal([a,b]).recipients[0].state,state);}
});
test('source conflicts, formal mode, callbacks and cross-device recipient aliases fail closed',()=>{
 for(const change of [s=>s.key='production',s=>s.data.executionMode='send',s=>s.data.leads[0].attempts=1,s=>s.data.leads[0].outcome={result:'success'},s=>s.data.recipients[0].leadId='missing']){const s=source();change(s);assert.throws(()=>seedSendJournal([s]),/ineligible/);}
 const a=source(),b=source('preview-pilot');b.data.leads[0].fingerprint='d'.repeat(64);assert.throws(()=>seedSendJournal([a,b]),/ineligible/);
 const c=source('preview-pilot','unknown','102');c.data.recipients[0].physicalKey='e'.repeat(64);assert.throws(()=>seedSendJournal([a,c]),/ineligible/);
});
test('nonce windows and member limits retain their conservative bound',()=>{
 const a=source(),b=source('preview-pilot','not_sent','102');a.data.nonces=[{key:'d'.repeat(64),expiresAt:30}];b.data.nonces=[{key:'d'.repeat(64),expiresAt:10}];a.data.limits=[{key:'e'.repeat(64),until:null}];b.data.limits=[{key:'e'.repeat(64),until:100}];const seed=seedSendJournal([a,b]);assert.equal(seed.nonces[0].expiresAt,30);assert.equal(seed.limits[0].until,null);
});
