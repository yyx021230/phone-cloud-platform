import test from 'node:test';import assert from 'node:assert/strict';
import {safeCallRecord,safeNativeResult,safeResources} from './wecom_qa_trace.mjs';
const call={version:1,elapsedMs:1,kind:'call',id:1,call:'rpc.setAttr',state:'begin'};
test('private diagnostics still reject UI, parameters and arbitrary labels',()=>{
 assert.deepEqual(safeCallRecord(call),call);
 for(const change of [{phoneNumber:'private'},{params:['private']},{call:'rpc.private'},{elapsedMs:Infinity},{kind:'raw'}])assert.equal(safeCallRecord({...call,...change}),null);
});
test('safe stack is metadata only and does not preserve thread names or locals',()=>{
 const row={version:1,elapsedMs:1,kind:'stack',activeCalls:[{id:1,call:'rpc.send'}],threads:[{role:'main',alive:true,daemon:false,stack:[{module:'requests.adapters',function:'send',line:1}]}]};
 assert.deepEqual(safeCallRecord(row),row);
 assert.equal(safeCallRecord({...row,threads:[{...row.threads[0],name:'private-token'}]}),null);
 assert.equal(safeCallRecord({...row,threads:[{...row.threads[0],stack:[{...row.threads[0].stack[0],locals:{secret:'private'}}]}]}),null);
});
test('resource proof cannot name arbitrary ports or publish UI output',()=>{
 const r={readerStarted:true,pid:'123',startToken:'12345',forwards:[[23456,10080]],cleanupConfirmed:false};
 assert.deepEqual(safeResources(r),r);
 assert.equal(safeResources({...r,forwards:[[5037,22]]}),null);
 const result=safeNativeResult({previewStatus:'blocked',previewCode:'device_lease_lost',invitationSent:false,isolation:{resources:r},privateField:'secret'});
 assert.equal(result.privateField,undefined);assert.equal(result.isolation.productionWindowsTask,false);
});

test('tail records retain only one bounded sanitized layer',()=>{
 const t={version:1,elapsedMs:2,kind:'tail',record:call};assert.deepEqual(safeCallRecord(t),t);
 assert.equal(safeCallRecord({...t,record:{...call,params:['private']}}),null);
 assert.equal(safeCallRecord({...t,record:t}),null);
});
