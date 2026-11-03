import assert from 'node:assert/strict';
import test from 'node:test';
import { wecomErrorInfo } from './wecom-errors.mjs';
import { publicPreview, publicInvitation } from './wecom-preview.mjs';
import { wecomErrorLabel } from '../public/wecom-automation-ui.js';

const execution = {version:1,phase:'cleanup',failurePhase:'recipient_search',elapsedMs:25000,cleanupConfirmed:true,events:[],transportFailure:{reason:'read_timeout',errorType:'ReadTimeout',elapsedMs:23000}};

test('classifies root cause separately from unknown side effects without authorizing retries',()=>{
  for(const [code,category] of [['login_required','login'],['human_required','human'],['adb_io_timeout','device_connection'],['device_lease_lost','device_busy'],['wecom_app_slot_not_configured','configuration'],['already_contact','business_stop'],['preview_cleanup_unconfirmed','cleanup'],['page_changed_before_action','page_compatibility'],['home_navigation_timeout','timeout'],['qa_transport_unknown','test_environment'],['unclassified_fixture','internal']]){
    const info=wecomErrorInfo({code,status:'failed',execution,remarkSaveStatus:'unknown'});
    assert.equal(info.category,category);assert.equal(info.outcomeUnconfirmed,true);
    assert.equal(info.phase,'recipient_search');assert.match(info.action,/请勿重复提交/);
    assert.equal(info.canRetry,undefined);
  }
  assert.equal(wecomErrorInfo({code:'already_contact',status:'failed',remarkSaveStatus:'not_attempted'}).outcomeUnconfirmed,false);
});

test('validated transport cause reaches internal UI and integration result without raw diagnostics',()=>{
  const job={jobId:'fixture',status:'failed',wecomDeviceNumber:'185',result:{previewCode:'wecom_rpc_delivery_unknown_no_replay',sendStatus:'not_attempted',remarkSaveStatus:'not_attempted',diagnostic:{wecomExecution:execution}}};
  const task=publicPreview(job),external=publicInvitation(task);
  assert.equal(task.result.errorInfo.category,'transport');assert.match(task.result.errorInfo.message,/等待响应超时/);
  assert.deepEqual(external.errorInfo,task.result.errorInfo);assert.equal(external.status,'failed');
  assert.match(wecomErrorLabel(task),/客户搜索.*等待响应超时.*wecom_rpc_delivery_unknown_no_replay/);
  const peer={...execution,transportFailure:{...execution.transportFailure,reason:'peer_verification_failed',errorType:'PeerDenied'}};
  assert.equal(wecomErrorInfo({code:job.result.previewCode,status:'failed',execution:peer}).category,'test_environment');
  const malformed={...execution,failurePhase:'private contact',transportFailure:{message:'private contact'}};
  const value=wecomErrorInfo({code:job.result.previewCode,status:'failed',execution:malformed});
  assert.equal(value.phase,'');assert.ok(!JSON.stringify(value).includes('private'));
});

test('active/safe pre-send tasks do not acquire error labels and unknown sends retain original status',()=>{
  for(const status of ['queued','running'])assert.equal(wecomErrorInfo({code:'login_required',status}),null);
  for(const code of ['preview_ready','stopped_before_send','send_boundary_reached'])assert.equal(wecomErrorInfo({code,status:'succeeded'}),null);
  const task=publicPreview({jobId:'fixture',status:'stalled',wecomMode:'send',wecomSendClaimAt:'fixture',result:{previewCode:'login_required',remarkSaveStatus:'unknown'}});
  assert.equal(publicInvitation(task).status,'unknown');assert.equal(task.result.invitationSent,null);
  assert.equal(task.result.errorInfo.category,'login');assert.equal(task.result.errorInfo.outcomeUnconfirmed,true);
  assert.equal(wecomErrorLabel({result:{code:'legacy_code'}}),'legacy_code');
});
