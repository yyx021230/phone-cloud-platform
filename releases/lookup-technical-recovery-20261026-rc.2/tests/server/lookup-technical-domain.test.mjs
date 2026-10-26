import test from 'node:test';import assert from 'node:assert/strict';
import {lookupFailureDomain,lookupTerminalResultReason} from './lookup-failure-domain.mjs';
for(const [reason,domain] of [
 ["error: device 'TEST-SERIAL' not found",'device'],
 ['error: device "TEST-SERIAL" unauthorized','device'],
 ["Command '['adb.exe', '-s', 'TEST', 'exec-out', 'screencap', '-p']' timed out after 15 seconds",'device'],
 ['poco_query_page_recovery_failed:poco_query_before_input_failed:RuntimeError:poco_rpc_failed:HTTPConnectionPool(test): Read timed out','device'],
 ['worker 已退出: verify_worker_adb_transport','device'],
 ['local_lookup_result_unconfirmed:foreground_changed','state'],
 ['poco_query_resume_observation_failed:local_lookup_result_unconfirmed:observation_budget_exhausted','page'],
 ['local_lookup_result_unconfirmed:ocr_reader_timeout','page'],
 ['model_read timed out after 120 seconds','page'],
 ['alipay_account_home_navigation_failed:search_activity_persisted','page'],
 ['selector_missing:我的','page'],
])test('incident classifier: '+reason,()=>{const j={result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:reason}}};assert.equal(lookupFailureDomain(j),domain);if(domain!=='page')assert.equal(lookupTerminalResultReason(j),'');});
