import test from 'node:test';import assert from 'node:assert/strict';import {lookupName} from '../public/downloads/lookup.mjs';
for(const status of ['expired','stopping','stopped'])test('sample requires explicit restart after '+status,async()=>{
 const state={};let calls=0;await assert.rejects(lookupName({baseUrl:'http://127.0.0.1',apiKey:'synthetic',phoneNumber:'13800000000',state,saveState:async()=>{},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({ok:true,status,ready:false}),{status:200});}}),/重新启动/);assert.equal(calls,1);assert.ok(state.prepareKey);assert.equal(state.lookupId,undefined);
});
