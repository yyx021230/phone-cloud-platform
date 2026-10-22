import test from 'node:test';import assert from 'node:assert/strict';import {lookupName} from '../public/downloads/lookup.mjs';
test('HTTP sample pauses new submissions, checks original prepare key and resumes original submit key',async()=>{
 let clock=0;const state={},calls=[],sleeps=[];const responses=[
 [200,{ok:true,status:'ready',ready:true,acceptingRequests:false,code:'lookup_no_available_device'}],
 [200,{ok:true,status:'ready',ready:true,acceptingRequests:true}],
 [503,{ok:false,code:'lookup_no_available_device',accepted:false,retryAfterSeconds:30}],
 [200,{ok:true,status:'ready',ready:true,acceptingRequests:false}],
 [200,{ok:true,status:'ready',ready:true,acceptingRequests:true}],
 [202,{ok:true,lookupId:'original-id',status:'queued'}],
 [200,{ok:true,lookupId:'original-id',status:'queued',code:'lookup_no_available_device',retryAfterSeconds:30}],
 [200,{ok:true,lookupId:'original-id',status:'completed',name:''}]];
 const result=await lookupName({baseUrl:'http://127.0.0.1',apiKey:'synthetic',phoneNumber:'13800000000',state,saveState:async()=>{},waitMs:240000,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},fetchImpl:async(url,o)=>{calls.push({path:new URL(url).pathname,method:o.method,key:o.headers['Idempotency-Key']});const [status,body]=responses.shift();return new Response(JSON.stringify(body),{status,headers:status===503?{'Retry-After':'30'}:{}});}});
 assert.equal(result.name,'');assert.deepEqual(calls.map(c=>c.path.split('/').pop()),['prepare','prepare','tasks','prepare','prepare','tasks','original-id','original-id']);assert.equal(new Set(calls.filter(c=>c.path.endsWith('/prepare')).map(c=>c.key)).size,1);assert.equal(new Set(calls.filter(c=>c.path.endsWith('/tasks')).map(c=>c.key)).size,1);assert.deepEqual(sleeps,[30000,30000,30000,30000]);
});
