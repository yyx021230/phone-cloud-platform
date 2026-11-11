import test from 'node:test';
import assert from 'node:assert/strict';
import { WecomClient, WecomApiError } from './client.mjs';
const token='fixture-only';
test('caller POST transport failures are unknown and never automatically retried',async()=>{
  let calls=0;
  const client=new WecomClient({baseUrl:'http://127.0.0.1:12345',token,fetchImpl:async(url,options)=>{
    calls++;assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);assert.ok(!url.includes(token));throw new Error('fixture private diagnostic');
  }});
  await assert.rejects(client.submit({deviceNumber:59,phoneNumber:'19900000001'}),e=>e instanceof WecomApiError&&e.code==='transport_outcome_unknown'&&!e.message.includes('diagnostic'));
  assert.equal(calls,1);
});
test('malformed success responses do not become accepted jobs or permission to resend',async()=>{
  for(const value of [null,[],{}, {taskId:'fixture',status:'sent'}]){
    const c=new WecomClient({baseUrl:'http://127.0.0.1:12345',token,fetchImpl:async()=>({ok:true,status:200,json:async()=>value})});
    await assert.rejects(c.submit({}),e=>e.code==='response_outcome_unknown');
  }
});
test('only explicit origins and bounded task IDs are accepted before any network call',async()=>{
  for(const baseUrl of ['file:///tmp/test','http://user:secret@localhost','http://localhost/path','http://localhost/?secret=hidden']) assert.throws(()=>new WecomClient({baseUrl,token}),/invalid_base_url/);
  const c=new WecomClient({baseUrl:'http://127.0.0.1:12345',token,fetchImpl:()=>assert.fail('no request')});
  await assert.rejects(c.result('../other-admin-api'),/invalid_task_id/);await assert.rejects(c.devices({onlineOnly:'true'}),/invalid_online_filter/);
});
test('a business rejection exposes only the fixed code and original task reference',async()=>{
  const c=new WecomClient({baseUrl:'http://127.0.0.1:12345',token,fetchImpl:async()=>({ok:false,status:409,json:async()=>({error:'wecom_invitation_parameters_conflict',taskId:'fixture-original',privateField:'must not surface'})})});
  await assert.rejects(c.submit({}),e=>e.status===409&&e.taskId==='fixture-original'&&!e.message.includes('surface'));
});
