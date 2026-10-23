import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupFailureDomain} from './lookup-failure-domain.mjs';
import {recordLookupPreparationFailure,lookupDeviceUnavailable,pagePreparationRetryAt} from './lookup-device-availability.mjs';
for(const reason of ['alipay_known_overlay_not_dismissed:real_name','alipay_known_overlay_close_unverified:fullscreen_ad','alipay_known_overlay_reappeared:real_name'])test('overlay error remains temporary page failure: '+reason,()=>{
 const job={result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:reason}}};assert.equal(lookupFailureDomain(job),'page');
 const now=Date.now(),d={deviceId:'d'},s={devices:[d],preparations:[{clientId:'c',preparationId:'p'}]},c={clientId:'c',deviceId:'d'};
 for(let i=0;i<3;i++)recordLookupPreparationFailure(s,c,{},now,{domain:lookupFailureDomain(job),code:'alipay_lookup_failed',jobId:'j'+i});
 assert.equal(lookupDeviceUnavailable(d),false);assert.equal(d.preparationIssue.domain,'page');assert.ok(pagePreparationRetryAt(s,d,'c')>now);
});
test('real device offline remains isolated from overlays',()=>assert.equal(lookupFailureDomain({result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:'device offline'}}}),'device'));
