import test from 'node:test';import assert from 'node:assert/strict';
import {recordLookupPreparationFailure as fail,recordLookupPreparationSuccess as pass,preparationBlocked,preparationFailureEvidence} from './lookup-device-availability.mjs';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
const fixture=()=>({devices:[{deviceId:'d',prepareFailureCount:0}],preparations:[{clientId:'a',preparationId:'round-one'}]});
const c={deviceId:'d',clientId:'a'};
test('page and identity errors have two attempts per round, never persistent hardware isolation',()=>{
 for(const domain of ['page','unknown']){
  const s=fixture(),d=s.devices[0];fail(s,c,{},1000,{domain,code:'alipay_account_identity_unverified'});assert.equal(preparationBlocked(s,d,'a'),false);
  const second={};fail(s,c,second,2000,{domain});fail(s,c,second,3000,{domain});assert.equal(d.preparationIssue.rounds[0].count,2);
  assert.equal(preparationBlocked(s,d,'a'),true);assert.equal(d.prepareFailureCount,0);assert.notEqual(d.lookupUnavailable,true);
  const copy=structuredClone(s);assert.equal(preparationBlocked(copy,copy.devices[0],'a'),true);
  copy.preparations[0].preparationId='next-round';assert.equal(preparationBlocked(copy,copy.devices[0],'a'),false);
  assert.equal(preparationBlocked(s,d,'other-client'),false);
 }
});
test('three evidenced executor failures still trip persistent quarantine; late successes never clear it',()=>{
 const s=fixture(),d=s.devices[0];for(let i=0;i<3;i++)fail(s,c,{},i*1000,{domain:'device',jobId:'failure-'+i});
 assert.equal(d.lookupUnavailable,true);pass(s,c);assert.equal(d.lookupUnavailable,true);assert.equal(d.prepareFailureCount,3);
});
test('a successful probe clears transient issue and counter but never invents a readiness proof',()=>{
 const s=fixture(),d=s.devices[0];fail(s,c,{},0,{domain:'page'});pass(s,c);assert.equal(d.preparationIssue,undefined);assert.equal(d.quarantineUntil,0);assert.equal(d.readinessProof,undefined);
});
test('terminal preparation classification does not mistake missing account labels for transport failure',()=>{
 const j=(code,reason='')=>({kind:'alipay_name_start',status:'failed',jobId:'j',result:{errorCode:code,diagnostic:{runnerReason:reason}}});
 for(const code of ['alipay_account_identity_unverified','alipay_page_element_changed','alipay_ui_hierarchy_unavailable'])assert.equal(preparationFailureEvidence(j(code)).domain,'page');
 assert.equal(preparationFailureEvidence(j('alipay_lookup_failed','alipay_my_tab_missing')).domain,'page');
 assert.equal(preparationFailureEvidence(j('alipay_lookup_failed','Airtest/Poco worker 已退出')).domain,'device');
 assert.equal(preparationFailureEvidence(j('task_failed')).domain,'unknown');
 assert.equal(preparationFailureEvidence({...j('task_failed'),status:'running'}),null);
});
test('adapter requires the matching terminal worker before using preparation failure evidence',()=>{
 const job={kind:'alipay_name_start',status:'failed',jobId:'j',sessionId:'s',deviceId:'d',windowsTaskId:'t',result:{errorCode:'alipay_account_identity_unverified'}};
 const task={taskId:'t',status:'running'},state={automationJobs:[job],windowsTasks:[task]};const a=createManagedLookupAdapter({state});
 assert.equal(a.preparationFailure({...c,sessionId:'s'}),null);task.status='failed';assert.equal(a.preparationFailure({...c,sessionId:'s'}).domain,'page');
 job.deviceId='another';assert.equal(a.preparationFailure({...c,sessionId:'s'}),null);
});
test('legacy isolation requires three consecutive managed start page failures ending at trip time',()=>{
 const jobs=[0,1,2].map(i=>({jobId:'j'+i,deviceId:'d',windowsTaskId:'t'+i,source:'managed-api',kind:'alipay_name_start',status:'failed',createdAt:new Date(1000*i).toISOString(),completedAt:new Date(1000*i+500).toISOString(),result:{errorCode:'alipay_account_identity_unverified'}}));
 const state={automationJobs:jobs,windowsTasks:jobs.map(j=>({taskId:j.windowsTaskId,status:'failed'}))},a=createManagedLookupAdapter({state});
 assert.equal(a.legacyPageIsolation({deviceId:'d',lookupUnavailableAt:2600}).jobIds.length,3);
 for(const trip of [2000,20000,NaN])assert.equal(a.legacyPageIsolation({deviceId:'d',lookupUnavailableAt:trip}),null);
 jobs[1].result={errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:'device offline'}};assert.equal(a.legacyPageIsolation({deviceId:'d',lookupUnavailableAt:2600}),null);
 jobs[1].result={errorCode:'alipay_account_identity_unverified'};jobs[1].kind='alipay_name_query';assert.equal(a.legacyPageIsolation({deviceId:'d',lookupUnavailableAt:2600}),null);
});
