import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {runLookupWithAccountPolicy} from './lookup-account-policy.mjs';
const src=await fs.readFile(new URL('./index.mjs',import.meta.url),'utf8');
const classifier=new Function(src.slice(src.indexOf('function alipayAccountSwitchReasonFromError('),src.indexOf('async function observeLookupHumanVerification('))+';return classifyAlipayNameLookupFailure;')();
const now=Date.parse('2026-10-27T08:00:00Z');
const task={taskId:'original-task',type:'alipay_name_query',payload:{resultId:'original-result',phoneNumber:'13800000000',accountCooldownProtocol:1,knownAccount:'fixture-A',accountIdentityVerified:true,savedAccounts:[{account:'fixture-A',current:true},{account:'fixture-B',current:false}],accountCooldowns:[],preparedLookup:{verifiedAccount:'fixture-A',probePhone:'13900000000'}}};
const error=raw=>{const diagnostic=classifier(raw);return Object.assign(new Error(diagnostic.message),{code:diagnostic.code,diagnostic});};
test('persistent refreshed search error uses real classifier, durable cooldown then original-query handoff',async()=>{
 const calls=[];
 await assert.rejects(runLookupWithAccountPolicy({task,now:()=>now,execute:async t=>{
   assert.equal(t.taskId,task.taskId);assert.equal(t.payload.resultId,task.payload.resultId);
   calls.push('original-query');throw error('alipay_account_restriction_switch_required:frequent_or_abnormal_access');
 },recordLimit:async r=>{
   calls.push('persist');assert.equal(r.account,'fixture-A');assert.equal(r.phoneQueryStarted,true);
   assert.equal(r.reason,'frequent_or_abnormal_access');return {accountCooldown:{account:r.account,limitedAt:new Date(now).toISOString(),cooldownUntil:new Date(now+28800000).toISOString()}};
 }}),e=>e.code==='alipay_prepared_account_limited'&&e.diagnostic.currentAccount==='fixture-A');
 assert.deepEqual(calls,['original-query','persist']);
});
for(const reason of ['network_refresh_unconfirmed','visual_network_busy','adb_read_unavailable','ocr_reader_timeout'])test(reason+' is not account restriction',async()=>{
 await assert.rejects(runLookupWithAccountPolicy({task,recordLimit:assert.fail,execute:async()=>{throw error('local_lookup_result_unconfirmed:'+reason);}}),e=>e.code==='alipay_lookup_result_unconfirmed');
});
test('failed persistence cannot acknowledge rotation or replay a submitted number',async()=>{
 let calls=0;
 await assert.rejects(runLookupWithAccountPolicy({task,now:()=>now,execute:async()=>{calls++;throw error('alipay_account_restriction_switch_required:frequent_or_abnormal_access');},recordLimit:async()=>({})}),e=>e.code==='alipay_cooldown_persist_unconfirmed');
 assert.equal(calls,1);
});
