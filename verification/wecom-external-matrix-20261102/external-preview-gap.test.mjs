import test from 'node:test';
import assert from 'node:assert/strict';
import {WECOM_PREVIEW_DEVICES,invitationRequest} from '../../server/wecom-preview.mjs';
test('all eight configured phones / nine slots refuse external preview; safe reads must not become send tasks',()=>{
  const devices=Object.entries(WECOM_PREVIEW_DEVICES).map(([number,entry])=>({deviceName:number,deviceId:'adb:'+entry.serial,adb:{serial:entry.serial}}));
  let slots=0;
  for(const [deviceNumber,entry] of Object.entries(WECOM_PREVIEW_DEVICES))for(const appSlot of Object.keys(entry.appSlots)){
    slots++;
    const input={deviceNumber,appSlot,phoneNumber:'13900000000',remarkName:'fixture-only'};
    assert.throws(()=>invitationRequest({...input,mode:'preview'},devices,{requestId:'fixture-only-request'}),{message:'invalid_wecom_invitation_fields',statusCode:400});
    // Pure parsing only: explicitly prove why omitting the rejected field is
    // unsafe for a before-send test. No HTTP submit/Agent/phone is involved.
    assert.equal(invitationRequest(input,devices,{requestId:'fixture-only-request'}).mode,'send');
  }
  assert.equal(devices.length,8);assert.equal(slots,9);
});
