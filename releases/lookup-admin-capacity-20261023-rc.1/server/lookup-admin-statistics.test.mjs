import test from 'node:test';import assert from 'node:assert/strict';
import {lookupDay,lookupStatistics} from './lookup-admin-statistics.mjs';
const now=Date.parse('2026-10-23T00:30:00.000Z');
test('business statistics exclude probes and duplicate original IDs, count midnight and cross-day completion correctly',()=>{
 const rows=[{lookupId:'old',createdAt:'2026-10-22T15:59:59.999Z',completedAt:'2026-10-22T16:00:00.000Z',status:'succeeded',name:'名',attempts:[{deviceId:'d1',at:'2026-10-22T16:00:00.000Z'},{deviceId:'d2',at:'2026-10-22T16:01:00.000Z'}]},
 {lookupId:'today',createdAt:'2026-10-22T16:00:00.000Z',status:'queued'},
 {lookupId:'empty',createdAt:'2026-10-23T00:00:00.000Z',completedAt:'2026-10-23T00:00:10.000Z',status:'not_found',attempts:[{deviceId:'d1',at:'2026-10-23T00:00:00.000Z'}]},
 {lookupId:'bad',createdAt:'2026-10-23T00:00:00.000Z',completedAt:'2026-10-23T00:00:00.000Z',status:'failed'},
 {lookupId:'cancel',createdAt:'2026-10-23T00:00:00.000Z',completedAt:'2026-10-23T00:00:00.000Z',status:'cancelled'},
 {lookupId:'probe',purpose:'readiness_probe',createdAt:'2026-10-23T00:00:00.000Z',status:'succeeded',name:'测试'}];
 const s=lookupStatistics([...rows,rows[0]],now);assert.equal(s.day.date,'2026-10-23');assert.equal(s.all.submitted,5);assert.equal(s.today.submitted,4);assert.equal(s.today.completed,4);assert.equal(s.today.named,1);assert.equal(s.today.empty,1);assert.equal(s.today.failed,1);assert.equal(s.today.cancelled,1);assert.equal(s.today.devicesUsed,2);assert.equal(s.all.completed,4);
 assert.equal(lookupDay(Date.parse('2026-10-23T15:59:59.999Z')).date,'2026-10-23');assert.equal(lookupDay(Date.parse('2026-10-23T16:00:00.000Z')).date,'2026-10-24');
 assert.doesNotMatch(JSON.stringify(s),/lookupId|deviceId|attempts|名/);
});
