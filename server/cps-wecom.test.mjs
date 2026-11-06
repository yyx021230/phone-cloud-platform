import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {signature,parseBody,stringifyBody,authenticate,parseClients,dispatchInput,ROUTES} from './cps-wecom/protocol.mjs';
import {createStore} from './cps-wecom/store.mjs';
import {createService} from './cps-wecom/service.mjs';
import {createPlatform} from './cps-wecom/platform.mjs';
import {createHttpServer,listen} from './cps-wecom/http.mjs';

const secret='demo_secret_only_for_document';
const members=[{wecom_corp_id:'ww_fixture',wecom_userid:'member_main',deviceNumber:'59',appSlot:'main',bindingVerified:true},{wecom_corp_id:'ww_fixture',wecom_userid:'member_clone',deviceNumber:'155',appSlot:'clone',bindingVerified:true}];
const config=(callbackUrl='http://127.0.0.1:1/api/v1/lead/callback')=>parseClients(JSON.stringify([{appId:'cps_partner_demo',secret,callbackUrl,allowLoopbackTest:true,allDeviceStatus:true,members}]));
const business=(id=123456n,member='member_main')=>({lead_id:id,phone:'13800138000',wecom_userid:member,wecom_corp_id:'ww_fixture'});
const inventory=()=>({updatedAt:'fixture',capacity:{limit:2,active:0,remaining:2},devices:[...members.map(m=>({deviceNumber:m.deviceNumber,deviceName:m.deviceNumber,deviceId:'adb:fixture'+m.deviceNumber,online:true,adbOnline:true,agentOnline:true,listed:true,busy:false,available:true,wecomAllowed:true,remarkPhoneReady:true,appSlots:[{appSlot:m.appSlot}],occupancy:null})),{deviceNumber:'78',deviceName:'78',online:false,adbOnline:false,agentOnline:true,listed:true,busy:false,wecomAllowed:false,available:false,appSlots:[],unavailableReason:'wecom_not_configured'}]});
async function fixture(t,{platform,fetchImpl,mode='send'}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cps-wecom-test-'));
  let now=1793584800000,seq=0;const store=await createStore({file:path.join(dir,'journal.json')});const clients=config();const submissions=[];let task=null;
  platform ||= {mode,inventory:async()=>inventory(),submit:async lead=>{submissions.push(lead.requestId);return task={jobId:'fixture-job-'+lead.leadId,requestId:lead.requestId,deviceId:lead.deviceId,deviceNumber:lead.target.deviceNumber,appSlot:lead.target.appSlot,mode:platform.mode,status:'running',result:{}};},find:async()=>task};
  const callbacks=[];fetchImpl ||= async(url,options)=>{callbacks.push(parseBody(options.body));return new Response(JSON.stringify({success:true,code:200}),{status:200});};
  const service=createService({store,clients,platform,fetchImpl,clock:()=>now,nonce:()=>`callback_nonce_${++seq}`});
  let closed=false;const close=async()=>{if(!closed){closed=true;await service.close();}};t.after(async()=>{try{await close();}finally{await fs.rm(dir,{recursive:true,force:true});}});
  const signed=(body,nonce)=>{const v={...body,app_id:'cps_partner_demo',timestamp:now,nonce:nonce||`request_nonce_${++seq}`};v.sign=signature(v,secret);return stringifyBody(v);};
  return {dir,store,service,clients,platform,callbacks,submissions,close,signed,advance:ms=>{now+=ms;},now:()=>now,task:()=>task};
}

test('CPS published signature vector is exact; booleans, zero and Chinese participate unchanged',()=>{
  const v={lead_id:123456n,result:'success',app_id:'cps_partner_demo',timestamp:1793584800000,nonce:'demo_nonce_001'};
  assert.equal(signature(v,secret),'c3c79ff865b5ec0505bf53a5f6946e28aa840d1011d01976b2372e20aec8a081');
  const a={z:false,a:0,text:' 北京 ',empty:'',nil:null};assert.equal(signature(a,secret),signature({text:' 北京 ',a:0,z:false},secret));
  assert.notEqual(signature(a,secret),signature({text:'北京',a:0,z:false},secret));
  assert.notEqual(signature(a,secret),signature({text:' 北京 ',a:0},secret));
});
test('INT64 survives parse, signature and callback serialization; duplicates/arrays/floats are rejected',()=>{
  const raw=' {"lead_id":9223372036854775807,"timestamp":1793584800000,"a":false} \n';const v=parseBody(raw);assert.equal(v.lead_id,9223372036854775807n);assert.match(stringifyBody(v),/:9223372036854775807,/);
  for(const raw of ['{"lead_id":1,"lead_id":2}','{"lead_id":1,"\\u006cead_id":2}','{"lead_id":1e3}','{"x":{}}','{"x":[]}','{"timestamp":9223372036854775807}','{"x":1,}','{"__proto__":1}','{"a":true}x'])assert.throws(()=>parseBody(raw));
  assert.throws(()=>dispatchInput({...business(),lead_id:9223372036854775808n}));
});
test('configuration rejects ambiguous member/slot, invalid callbacks and unknown auth',()=>{
  for(const callbackUrl of ['https://u:p@example.invalid/callback','http://example.invalid/callback','https://example.invalid/callback?secret=x'])assert.throws(()=>config(callbackUrl));
  assert.throws(()=>parseClients(JSON.stringify([{appId:'fixture',secret,callbackUrl:'https://example.invalid/callback',members:[members[0],members[0]]}])));
  assert.throws(()=>authenticate({app_id:'missing',sign:'0'.repeat(64)},config()));
});
test('all devices include offline and unmapped phones; account mapping/availability is explicit and private IDs stay private',async t=>{
  const f=await fixture(t);const r=await f.service.handle('POST',ROUTES.devices,f.signed({online_only:false}));assert.equal(r.status,200);assert.equal(r.body.code,200);assert.equal(r.body.result.total,3);
  assert.equal(r.body.result.devices[1].accounts[0].app_slot,'clone');assert.equal(r.body.result.devices[2].online,false);assert.equal(r.body.result.devices[2].unavailable_reason,'member_not_configured');
  assert.ok(!JSON.stringify(r.body).includes('adb:'));assert.ok(!JSON.stringify(r.body).includes(secret));
  const online=await f.service.handle('POST',ROUTES.devices,f.signed({online_only:true}));assert.equal(online.body.result.total,2);
  assert.equal((await f.service.handle('POST',ROUTES.devices,f.signed({online_only:'true'}))).body.code,2003);
});
test('nonce, skew and signatures fail before dispatch; one nonce is consumed across both routes',async t=>{
  const f=await fixture(t);const raw=f.signed(business(),'request_shared_nonce');assert.equal((await f.service.handle('POST',ROUTES.dispatch,raw)).body.success,true);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,raw)).body.code,1003);
  const dup=f.signed({},'request_shared_nonce');assert.equal((await f.service.handle('POST',ROUTES.devices,dup)).body.code,1003);
  const expired=f.signed(business());f.advance(300001);assert.equal((await f.service.handle('POST',ROUTES.dispatch,expired)).body.code,1002);
  const bad=parseBody(f.signed(business()));bad.phone='13900139000';assert.equal((await f.service.handle('POST',ROUTES.dispatch,stringifyBody(bad))).body.code,1001);
  assert.equal(f.submissions.length,0);
});
test('same lead with new nonce returns accepted once; parameter changes and unconfigured members fail closed',async t=>{
  const f=await fixture(t);const responses=await Promise.all(Array.from({length:4},()=>f.service.handle('POST',ROUTES.dispatch,f.signed(business()))));assert.ok(responses.every(r=>r.body.success));assert.equal(f.store.snapshot().leads.length,1);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed({...business(),phone:'13900139000'}))).body.code,2003);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business(2n,'missing')))).body.code,2003);
  await f.service.tick();assert.equal(f.submissions.length,1);await f.service.tick();assert.equal(f.submissions.length,1);
});
test('lost submission acknowledgement is reconciled by original request, never submitted twice',async t=>{
  let lead,posts=0;const platform={mode:'send',inventory:async()=>inventory(),submit:async r=>{lead=r;posts++;throw Error('fixture_lost_ack');},find:async()=>({jobId:'original',requestId:lead.requestId,deviceId:lead.deviceId,deviceNumber:lead.target.deviceNumber,appSlot:lead.target.appSlot,mode:platform.mode,status:'running',result:{}})};
  const f=await fixture(t,{platform});await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();assert.equal(f.store.snapshot().leads[0].stage,'reconcile');f.advance(5000);await f.service.tick();assert.equal(f.store.snapshot().leads[0].jobId,'original');assert.equal(posts,1);
});
test('unknown submission without original task stays held and does not become a fresh invitation',async t=>{
  let count=0;const f=await fixture(t,{platform:{mode:'send',inventory:async()=>inventory(),submit:async()=>{count++;throw Error();},find:async()=>null}});
  await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();f.advance(5000);await f.service.tick();assert.equal(f.store.snapshot().leads[0].stage,'needs_attention');assert.equal(count,1);assert.equal(f.callbacks.length,0);
});
test('verified duplicate callback retries with new signed nonce, without repeating device work',async t=>{
  let calls=0;const sent=[];const f=await fixture(t,{fetchImpl:async(url,options)=>{sent.push(parseBody(options.body));calls++;return new Response(JSON.stringify({success:calls>1,code:calls>1?200:500}),{status:calls>1?200:500});}});
  await f.service.handle('POST',ROUTES.dispatch,f.signed(business(12345678n)));await f.service.tick();Object.assign(f.task(),{status:'failed',result:{code:'already_contact',sendStatus:'not_attempted',remarkSaveStatus:'not_attempted'}});f.advance(2000);await f.service.tick();await f.service.tick();assert.equal(f.store.snapshot().leads[0].stage,'callback_pending');f.advance(5000);await f.service.tick();assert.equal(f.store.snapshot().leads[0].stage,'completed');
  assert.equal(sent[0].lead_id,12345678n);assert.equal(sent[0].result,'duplicate');assert.notEqual(sent[0].nonce,sent[1].nonce);assert.notEqual(sent[0].timestamp,sent[1].timestamp);assert.ok(sent.every(b=>signature(b,secret)===b.sign));assert.equal(f.submissions.length,1);
});
test('a native unknown send or unrelated failure cannot be disguised as CPS success or frequency limit',async t=>{
  for(const result of [{code:'invitation_click_issued_delivery_unknown',sendStatus:'unknown',invitationSent:null},{code:'login_required',sendStatus:'not_attempted',invitationSent:false},{code:'not_found',sendStatus:'not_attempted'}]){
    const f=await fixture(t);await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();Object.assign(f.task(),{status:'failed',result});f.advance(2000);await f.service.tick();assert.equal(f.store.snapshot().leads[0].stage,'needs_attention');assert.equal(f.callbacks.length,0);
  }
});
test('successful callback requires both send confirmation and independent remark phone confirmation',async t=>{
  const f=await fixture(t);await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();Object.assign(f.task(),{status:'succeeded',result:{sendStatus:'unknown',invitationSent:null,remarkPhoneSet:true,invitationRequestConfirmed:true,invitationRequestProof:'wecom_system_dialog_v1'}});f.advance(2000);await f.service.tick();await f.service.tick();assert.equal(f.callbacks[0].result,'success');assert.equal(f.callbacks[0].remark_phone_set,true);
});
test('only the local sender can use its toast or visual proof to trigger a success callback',async t=>{
  for(const [enabled,proof] of [[false,'wecom_sent_overlay_v1'],[true,'wecom_system_toast_v1'],[true,'wecom_sent_overlay_v1']]){
    const f=await fixture(t);f.platform.localInvitationProof=enabled;
    assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business()))).body.success,true);
    await f.service.tick();
    Object.assign(f.task(),{status:'succeeded',result:{sendStatus:'unknown',invitationSent:null,remarkPhoneSet:true,
      invitationRequestConfirmed:true,invitationRequestProof:proof}});
    f.advance(2000);await f.service.tick();await f.service.tick();
    assert.equal(f.callbacks.length,enabled?1:0);
    assert.equal(f.store.snapshot().leads[0].stage,enabled?'completed':'needs_attention');
    assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business()))).body.success,true);
    await f.service.tick();assert.equal(f.submissions.length,1);
  }
});
test('preview never calls CPS callback, including verified duplicate; same journal survives graceful restart',async t=>{
  const f=await fixture(t,{mode:'preview'});await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();Object.assign(f.task(),{status:'succeeded',result:{status:'ready_before_send'}});f.advance(2000);await f.service.tick();assert.equal(f.store.snapshot().leads[0].stage,'preview_complete');assert.equal(f.callbacks.length,0);await f.close();
  const next=await createStore({file:path.join(f.dir,'journal.json')});assert.equal(next.snapshot().leads.length,1);await next.close();
});
test('real loopback HTTP receives CPS dispatch and queries all status without accepting query/body confusion',async t=>{
  const f=await fixture(t);const server=createHttpServer(f.service),address=await listen(server);t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});const base='http://127.0.0.1:'+address.port;
  async function post(route,input){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:f.signed(input)});return{status:r.status,body:await r.json()};}
  const d=await post(ROUTES.devices,{});assert.equal(d.body.result.total,3);
  const a=await post(ROUTES.dispatch,business());assert.equal(a.body.success,true);assert.equal(a.body.code,200);
  assert.equal((await post(ROUTES.dispatch,business())).body.success,true);assert.equal(f.store.snapshot().leads.length,1);
  assert.equal((await post(ROUTES.dispatch+'?phone=x',business())).status,400);
});

test('platform bridge joins only verified private identities, requests phone proof and never leaks platform credentials',async()=>{
  const calls=[];const adapter=createPlatform({baseUrl:'http://127.0.0.1:1',token:'fixture-private-platform-token',fetchImpl:async(url,options)=>{
    calls.push({path:url.pathname,options});const body=url.pathname.endsWith('wecom-cps-devices')?{devices:[{deviceNumber:'59',deviceId:'adb:verified',cpsRemarkPhoneReady:true}]}:url.pathname.endsWith('wecom/devices')?inventory():{task:{jobId:'fixture'}};
    return new Response(JSON.stringify(body),{status:200});
  }});
  const rows=await adapter.inventory();assert.equal(rows.devices[0].deviceId,'adb:verified');assert.equal(rows.devices[0].remarkPhoneReady,true);assert.equal(rows.devices[1].deviceId,null);
  await adapter.submit({leadId:'12345678',input:{phone:'13800138000'},requestId:'cps_fixture',deviceId:'adb:verified',target:{appSlot:'main'}});
  const sent=JSON.parse(calls.at(-1).options.body);assert.equal(sent.requireRemarkPhone,true);assert.equal(sent.remarkName,'12345678');assert.equal(sent.phoneNumber,'13800138000');assert.equal(sent.description,'leadId:12345678');assert.equal(sent.mode,'preview');
  await adapter.submit({leadId:'9223372036854775807',input:{phone:'13800138000'},target:{appSlot:'main'}});
  const longest=JSON.parse(calls.at(-1).options.body);assert.equal(longest.remarkName,'9223372036854775807');assert.equal(longest.description,'leadId:9223372036854775807');assert.equal(longest.phoneNumber,'13800138000');assert.equal(longest.requireRemarkPhone,true);
});
test('busy before admission may wait; stale physical remapping cannot switch the selected phone',async t=>{
  let count=0;const platform={mode:'send',inventory:async()=>inventory(),submit:async()=>{count++;throw Object.assign(Error(),{noAdmission:true});},find:async()=>null};const f=await fixture(t,{platform});
  await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();assert.equal(f.store.snapshot().leads[0].stage,'queued');
  platform.inventory=async()=>{const v=inventory();v.devices[0].deviceId='adb:replacement';return v;};f.advance(5000);await f.service.tick();assert.equal(f.store.snapshot().leads[0].error,'physical_device_mapping_changed');assert.equal(count,1);
});
test('one phone submission hanging does not block a second phone reaching its original task',async t=>{
  let release;const wait=new Promise(r=>{release=r;});const platform={mode:'send',inventory:async()=>inventory(),find:async()=>null,submit:async lead=>{
    if(lead.target.deviceNumber==='59')await wait;
    return {jobId:'job_'+lead.leadId,deviceId:lead.deviceId,requestId:lead.requestId,deviceNumber:lead.target.deviceNumber,appSlot:lead.target.appSlot,mode:platform.mode,status:'running',result:{}};
  }};const f=await fixture(t,{platform});await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.handle('POST',ROUTES.dispatch,f.signed(business(2n,'member_clone')));
  const work=f.service.tick();try{for(let i=0;i<100;i++){if(f.store.snapshot().leads.find(r=>r.leadId==='2').stage==='submitted')break;await new Promise(r=>setTimeout(r,5));}assert.equal(f.store.snapshot().leads.find(r=>r.leadId==='2').stage,'submitted');}finally{release();await work;}
});

test('configured but unverified account cannot execute or be advertised as available',async t=>{
  const f=await fixture(t);const member=f.clients.get('cps_partner_demo').members.values().next().value;member.bindingVerified=false;
  const list=await f.service.handle('POST',ROUTES.devices,f.signed({}));assert.equal(list.body.result.devices[0].available,false);assert.equal(list.body.result.devices[0].unavailable_reason,'member_binding_unverified');
  const submit=await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));assert.equal(submit.body.success,false);assert.equal(f.store.snapshot().leads.length,0);
});

test('HTTP oversized body is rejected with a defined response before authentication or task creation',async t=>{
  const f=await fixture(t);const server=createHttpServer(f.service),address=await listen(server);t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const r=await fetch('http://127.0.0.1:'+address.port+ROUTES.dispatch,{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(17000)});
  assert.equal(r.status,413);assert.equal((await r.json()).code,2003);assert.equal(f.store.snapshot().nonces.length,0);assert.equal(f.store.snapshot().leads.length,0);
});

test('lead-only remarks admit nine-digit and maximum INT64 IDs without losing idempotency',async t=>{
  for(const lead_id of [123456789n,9223372036854775807n]){
    const f=await fixture(t);
    const r=await f.service.handle('POST',ROUTES.dispatch,f.signed(business(lead_id)));
    assert.equal(r.body.success,true);
    assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business(lead_id)))).body.success,true);
    assert.equal(f.store.snapshot().leads.length,1);assert.equal(f.store.snapshot().leads[0].leadId,lead_id.toString());
    assert.equal(f.store.snapshot().recipients.length,1);await f.service.tick();assert.equal(f.submissions.length,1);
  }
});

test('signed HTTP preserves maximum INT64 through remark, phone proof request and callback',async t=>{
  const posts=[];const adapter=createPlatform({baseUrl:'http://127.0.0.1:1',token:'fixture-private-platform-token',mode:'send',fetchImpl:async(url,options)=>{
    let body;
    if(url.pathname.endsWith('wecom-cps-devices'))body={devices:members.map(m=>({deviceNumber:m.deviceNumber,deviceId:'adb:fixture'+m.deviceNumber,cpsRemarkPhoneReady:true}))};
    else if(url.pathname.endsWith('wecom/devices'))body=inventory();
    else{
      assert.equal(options.method,'POST');const input=JSON.parse(options.body);posts.push(input);
      body={task:{jobId:'fixture-max-id',deviceId:input.deviceId,deviceNumber:'59',appSlot:input.appSlot,requestId:input.requestId,mode:input.mode,status:'failed',result:{code:'already_contact',sendStatus:'not_attempted',remarkSaveStatus:'not_attempted'}}};
    }
    return new Response(JSON.stringify(body),{status:200});
  }});
  const f=await fixture(t,{platform:adapter});const server=createHttpServer(f.service),address=await listen(server);
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const post=async input=>{
    const response=await fetch('http://127.0.0.1:'+address.port+ROUTES.dispatch,{method:'POST',headers:{'content-type':'application/json'},body:f.signed(input)});
    assert.equal(response.status,200);return response.json();
  };
  const input=business(9223372036854775807n);
  assert.equal((await post(input)).success,true);assert.equal((await post(input)).success,true);
  await f.service.tick();assert.equal(posts.length,1);
  assert.equal(posts[0].remarkName,'9223372036854775807');assert.equal(posts[0].description,'leadId:9223372036854775807');
  assert.equal(posts[0].phoneNumber,input.phone);assert.equal(posts[0].requireRemarkPhone,true);
  await f.service.tick();assert.equal(f.callbacks.length,1);assert.equal(f.callbacks[0].lead_id,9223372036854775807n);
  assert.equal(f.callbacks[0].result,'duplicate');assert.equal(signature(f.callbacks[0],secret),f.callbacks[0].sign);
  assert.equal((await post(input)).success,true);await f.service.tick();assert.equal(posts.length,1);
  assert.equal((await post(business(9223372036854775806n))).code,2003);
});

test('two-minute timeout, fresh lead ID, restart and phone migration cannot bypass the logical recipient fence',async t=>{
  const f=await fixture(t);assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business()))).body.success,true);
  await f.service.tick();f.advance(121000);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business()))).body.success,true);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business(2n)))).body.code,2003);
  await f.close();const store=await createStore({file:path.join(f.dir,'journal.json')});
  const client=f.clients.get('cps_partner_demo');client.members.get(JSON.stringify(['ww_fixture','member_main'])).deviceNumber='155';
  const next=createService({store,clients:f.clients,platform:f.platform,clock:f.now});
  try{
    assert.equal((await next.handle('POST',ROUTES.dispatch,f.signed(business(3n)))).body.code,2003);
    assert.equal((await next.handle('POST',ROUTES.dispatch,f.signed(business()))).body.success,true);
    await next.tick();assert.equal(f.submissions.length,1);assert.equal(store.snapshot().leads[0].error,'member_mapping_changed');
  }finally{await next.close();}
});

test('concurrent different lead IDs for the same member/customer reserve only one original execution',async t=>{
  const f=await fixture(t);const replies=await Promise.all(Array.from({length:8},(_,i)=>f.service.handle('POST',ROUTES.dispatch,f.signed(business(BigInt(i+1))))));
  assert.equal(replies.filter(r=>r.body.success).length,1);assert.equal(f.store.snapshot().leads.length,1);await f.service.tick();assert.equal(f.submissions.length,1);
});

test('a completed callback retains the recipient fence after deleting the raw phone',async t=>{
  const f=await fixture(t);await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();
  Object.assign(f.task(),{status:'failed',result:{code:'already_contact',sendStatus:'not_attempted',remarkSaveStatus:'not_attempted'}});
  f.advance(2000);await f.service.tick();await f.service.tick();assert.equal(f.store.snapshot().leads[0].input.phone,undefined);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business(2n)))).body.code,2003);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business()))).body.success,true);assert.equal(f.submissions.length,1);
});

test('only terminal confirmed non-send with cleanup permits a different lead for the same recipient',async t=>{
  for(const cleanupConfirmed of [false,true]){
    const f=await fixture(t);await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();
    Object.assign(f.task(),{status:'failed',result:{code:'not_found',sendStatus:'not_attempted',sendClaimed:false,invitationSent:false,remarkSaveStatus:'not_attempted',execution:{cleanupConfirmed}}});
    f.advance(2000);await f.service.tick();const r=await f.service.handle('POST',ROUTES.dispatch,f.signed(business(2n)));
    assert.equal(r.body.success,cleanupConfirmed);assert.equal(f.callbacks.length,0);
  }
});

test('confirmed frequency pauses just that official member immediately, persists, and expires at China midnight',async t=>{
  const f=await fixture(t);await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();
  Object.assign(f.task(),{status:'failed',completedAt:new Date(f.now()).toISOString(),result:{code:'wecom_add_friend_too_frequent',sendStatus:'not_attempted',addFriendLimitConfirmed:true,addFriendLimitProof:'wecom_system_dialog_v1'}});
  f.advance(2000);await f.service.tick();assert.equal(f.callbacks.length,0);
  const r=await f.service.handle('POST',ROUTES.devices,f.signed({}));assert.equal(r.body.result.devices[0].accounts[0].unavailable_reason,'member_rate_limited');assert.equal(r.body.result.devices[1].accounts[0].available,true);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed({...business(2n),phone:'13900139000'}))).body.success,false);
  assert.equal((await f.service.handle('POST',ROUTES.dispatch,f.signed(business(3n,'member_clone')))).body.success,true);
  const until=f.store.snapshot().limits[0].until;await f.close();const store=await createStore({file:path.join(f.dir,'journal.json')});
  const next=createService({store,clients:f.clients,platform:f.platform,clock:f.now});
  try{
    const before=await next.handle('POST',ROUTES.devices,f.signed({}));assert.equal(before.body.result.devices[0].accounts[0].available,false);
    f.advance(until-f.now()+1);
    const after=await next.handle('POST',ROUTES.devices,f.signed({}));assert.equal(after.body.result.devices[0].accounts[0].available,true);
    await next.tick();assert.equal(store.snapshot().leads[0].error,'rate_limit_callback_day_changed');assert.equal(f.callbacks.length,0);
  }finally{await next.close();}
});

test('missing trustworthy frequency time isolates member without fabricating a callback day',async t=>{
  const f=await fixture(t);await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();
  Object.assign(f.task(),{status:'failed',result:{code:'wecom_add_friend_too_frequent',addFriendLimitConfirmed:true,addFriendLimitProof:'wecom_system_dialog_v1'}});
  f.advance(2000);await f.service.tick();assert.equal(f.store.snapshot().leads[0].error,'limit_time_unconfirmed');assert.equal(f.store.snapshot().limits[0].until,null);assert.equal(f.callbacks.length,0);
});

test('preview journal cannot become a send journal on restart',async t=>{
  const f=await fixture(t,{mode:'preview'});await f.service.initialize();await f.close();
  const store=await createStore({file:path.join(f.dir,'journal.json')});const next=createService({store,clients:f.clients,platform:{...f.platform,mode:'send'}});
  try{await assert.rejects(next.initialize(),/mode_changed/);assert.equal((await next.handle('POST',ROUTES.dispatch,f.signed(business()))).status,503);assert.equal(store.snapshot().leads.length,0);}finally{await next.close();}
});

test('callback rejection and exhausted retries do not repeat device operations',async t=>{
  for(const code of [1001,500]){
    const f=await fixture(t,{fetchImpl:async()=>new Response(JSON.stringify({success:false,code}),{status:code===500?500:200})});
    await f.service.handle('POST',ROUTES.dispatch,f.signed(business()));await f.service.tick();Object.assign(f.task(),{status:'failed',result:{code:'already_contact',sendStatus:'not_attempted'}});f.advance(2000);await f.service.tick();
    for(let i=0;i<7;i++){await f.service.tick();f.advance(60000);}
    const record=f.store.snapshot().leads[0];assert.equal(record.stage,'needs_attention');assert.equal(record.attempts,code===500?5:1);assert.equal(f.submissions.length,1);
  }
});

test('queued work on one busy phone cannot consume the slot of a second idle phone',async t=>{
  const seen=[];let busy=false;const platform={mode:'send',inventory:async()=>{const v=inventory();v.devices[0].busy=busy;return v;},find:async()=>null,submit:async lead=>{seen.push(lead.leadId);return{mode:'send',jobId:'job_'+lead.leadId,requestId:lead.requestId,deviceId:lead.deviceId,deviceNumber:lead.target.deviceNumber,appSlot:lead.target.appSlot,status:'running'};}};
  const f=await fixture(t,{platform});
  await f.service.handle('POST',ROUTES.dispatch,f.signed(business(1n)));await f.service.handle('POST',ROUTES.dispatch,f.signed({...business(2n),phone:'13900139000'}));await f.service.handle('POST',ROUTES.dispatch,f.signed(business(3n,'member_clone')));
  busy=true;await f.service.tick();assert.deepEqual(seen,['3']);assert.equal(f.store.snapshot().leads[0].stage,'queued');
});

test('future-but-valid timestamp cannot replay after the nominal five-minute nonce interval',async t=>{
  const f=await fixture(t);const b=parseBody(f.signed({}));b.timestamp+=300000;b.sign=signature(b,secret);const raw=stringifyBody(b);
  assert.equal((await f.service.handle('POST',ROUTES.devices,raw)).body.success,true);f.advance(300001);
  assert.equal((await f.service.handle('POST',ROUTES.devices,raw)).body.code,1003);
});
