import test from 'node:test';import assert from 'node:assert/strict';
import {applyStructuredOverlay,createPostgresRepositories}from './postgres-repositories.mjs';
test('retirement tombstone defeats an older snapshot without rewriting task or SMS history',()=>{
 const task={jobId:'past',deviceId:'adb:old'},sms={messageId:'past-sms',deviceId:'adb:old'};
 const state={devices:[{deviceId:'adb:old',deviceName:'18',xhsAccounts:[{xhsId:'fixture'}]},{deviceId:'adb:unrelated'}],automationJobs:[task],smsMessages:[sms]};
 applyStructuredOverlay(state,{devices:[{deviceId:'adb:old',inventoryRetiredAt:'2026-11-11T08:00:00.000Z',replacementDeviceId:'adb:new'},{deviceId:'adb:new',deviceName:'18',xhsAccounts:[{xhsId:'fixture'}]}]});
 assert.deepEqual(state.devices.map(d=>d.deviceId),['adb:new','adb:unrelated']);
 assert.equal(state.automationJobs[0],task);assert.equal(state.smsMessages[0],sms);
});
test('ordinary empty retirement field remains visible and no legacy device is implicitly deleted',()=>{
 const state={devices:[{deviceId:'legacy'}]};applyStructuredOverlay(state,{devices:[{deviceId:'current',inventoryRetiredAt:''}]});assert.deepEqual(state.devices.map(d=>d.deviceId),['current','legacy']);
});
