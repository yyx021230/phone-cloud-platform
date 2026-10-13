import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';
import {initialManagedLookupState} from './managed-lookup-store.mjs';

function fixture({confirmedStop=true}={}) {
  let state=initialManagedLookupState();
  state.config={...state.config,enabled:true,concurrency:2};
  state.grants=[{clientId:'fixture',enabled:true,consentReference:'fixture-consent'}];
  state.devices=[130,118].map(n=>({deviceId:'d'+n,deviceNumber:n,enabled:true}));
  state.channels=[{deviceId:'d130',deviceNumber:130,clientId:'fixture',sessionId:'old130',requestId:'failed130',phase:'stopping'},
    {deviceId:'d118',deviceNumber:118,clientId:'fixture',sessionId:'old118',requestId:'done118',queryId:'q118',phase:'querying'}];
  state.requests=[{lookupId:'failed130',clientId:'fixture',status:'failed',attempts:[]},
    {lookupId:'done118',clientId:'fixture',status:'running',attempts:[]},
    ...['next1','next2'].map(lookupId=>({lookupId,clientId:'fixture',status:'queued',deadline:Date.now()+60000,attempts:[]}))];
  const events=[];
  const store={snapshot:()=>structuredClone(state),transact:async fn=>{
    const next=structuredClone(state), commits=[];
    const result=await fn(next,{onRollback:()=>{},onCommit:fn=>commits.push(fn)});
    state=next;commits.forEach(fn=>fn());return result;
  }};
  let service;
  const adapter={clientValid:()=>true,health:()=>({ready:true}),observe:c=>c.sessionId==='old130'?{stopped:confirmedStop}:c.queryId==='q118'?{result:{status:'succeeded',name:'fixture'}}:{busy:true},
    start:async c=>{
      // Same admission rule as the platform's acquireAutomationDeviceLock:
      // a published managed reservation is still a device conflict.
      if(service.reserved(c.deviceId))throw new Error('device_busy');
      c.sessionId='new-'+c.deviceId;events.push({kind:'start',device:c.deviceId});
    },query:async(c,r)=>{c.queryId=r.queryId='q-'+r.lookupId;events.push({kind:'query',device:c.deviceId});}};
  service=createManagedLookupService({store,adapter});return {service,store,events};
}

test('confirmed stop does not roll back another phone result or collide with the old reservation',async()=>{
  const f=fixture();await f.service.tick();
  assert.equal(f.store.snapshot().requests.find(r=>r.lookupId==='done118').status,'succeeded');
  assert.deepEqual(f.events,[{kind:'query',device:'d118'}]);
  assert.equal(f.service.reserved('d130'),undefined);
  assert.equal(f.store.snapshot().requests.find(r=>r.lookupId==='next2').status,'queued');
  await f.service.tick();
  assert.deepEqual(f.events,[{kind:'query',device:'d118'},{kind:'start',device:'d130'}]);
  assert.equal(f.service.admin().counts.executing,2);
});

test('unconfirmed stop retains its reservation while another phone receives the next query',async()=>{
  const f=fixture({confirmedStop:false});await f.service.tick();
  assert.equal(f.service.reserved('d130').phase,'stopping');
  assert.deepEqual(f.events,[{kind:'query',device:'d118'}]);
  assert.equal(f.service.admin().counts.executing,2);
});
