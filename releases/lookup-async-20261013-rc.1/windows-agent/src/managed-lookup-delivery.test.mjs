import test from 'node:test';
import assert from 'node:assert/strict';
import {hydrateManagedLookupTask} from './managed-lookup-delivery.mjs';
test('managed lookup cannot execute on lost/negative ACK and retains same task/generation',async()=>{
  const task={taskId:'fixture-task',type:'alipay_name_query',deliveryToken:'fixture-lease',payload:{managedLookup:{protocol:'managed_lookup_v1',generation:'fixture-generation'}}};let acks=0;
  const request=async p=>{if(p.endsWith('/payload'))return {payload:{phoneNumber:'13800000000',managedLookup:task.payload.managedLookup}};acks++;throw new Error('simulated lost ACK');};
  const result=await hydrateManagedLookupTask(task,{request});assert.equal(result.acknowledged,false);assert.equal(acks,3);assert.equal(result.task.taskId,task.taskId);
  const bad=await hydrateManagedLookupTask(task,{request:async p=>p.endsWith('/payload')?{payload:{managedLookup:task.payload.managedLookup}}:{ok:false}});assert.equal(bad.acknowledged,false);
  await assert.rejects(hydrateManagedLookupTask({...task,deliveryToken:''},{request}),/delivery_invalid/);
  await assert.rejects(hydrateManagedLookupTask(task,{request:async()=>({payload:{managedLookup:{generation:'stale'}}})}),/generation_mismatch/);
});
