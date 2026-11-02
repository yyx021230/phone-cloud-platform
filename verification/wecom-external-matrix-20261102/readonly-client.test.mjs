import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedRequest,projectDevice} from './readonly-client.mjs';
test('collector refuses all actual phone submissions, claims, cleanup and configuration mutations',()=>{
  for(const route of ['/api/v1/wecom/customer-invitations','/api/v1/user/automation/wecom-preview-tasks',
    '/api/v1/windows-agents/demo/tasks/next','/api/v1/windows-agents/demo/wecom-cleanup/id/proof','/api/v1/admin/lookup-pool']){
    assert.equal(allowedRequest('POST',route,{}),false);assert.equal(allowedRequest('PUT',route,{}),false);
  }
  assert.equal(allowedRequest('POST','/api/v1/auth/login',{username:'fixture',password:'fixture-only'}),true);
  assert.equal(allowedRequest('POST','/api/v1/auth/login',{username:'fixture',password:'fixture-only',extra:true}),false);
});
test('GET scope is exact and result IDs cannot inject other routes',()=>{
  assert.equal(allowedRequest('GET','/api/v1/wecom/devices'),true);
  assert.equal(allowedRequest('GET','/api/v1/wecom/devices?onlineOnly=true'),true);
  assert.equal(allowedRequest('GET','/api/v1/wecom/customer-invitations/00000000-0000-4000-8000-000000000000'),true);
  for(const route of ['/api/v1/devices','/api/v1/wecom/devices?unknown=1','/api/v1/windows-agents/demo/tasks/next','/api/v1/wecom/customer-invitations/../../keys'])assert.equal(allowedRequest('GET',route),false);
});
test('inventory projection retains model/OS/busy facts and drops identity/customer secrets',()=>{
  const d=projectDevice({deviceNumber:'155',model:'Fixture',brand:'Fixture',androidVersion:'10',online:true,available:true,
    appSlots:[{appSlot:'main'},{appSlot:'clone'}],phoneNumber:'fixture-phone',token:'fixture-secret',serial:'fixture-serial',
    occupancy:{type:'screen_control',label:'in use',owner:'fixture-owner'},busy:true});
  assert.equal(d.model,'Fixture');assert.deepEqual(d.appSlots,['main','clone']);assert.equal(d.busy,true);
  for(const key of ['phoneNumber','token','serial'])assert.equal(Object.hasOwn(d,key),false);
  assert.deepEqual(d.occupancy,{type:'screen_control',label:'in use'});
});
