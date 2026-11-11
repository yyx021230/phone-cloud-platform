import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseClients,signature,stringifyBody,ROUTES} from './cps-wecom/protocol.mjs';
import {createStore} from './cps-wecom/store.mjs';
import {createService} from './cps-wecom/service.mjs';
import {createHttpServer,listen} from './cps-wecom/http.mjs';

const secret='synthetic-cps-phone-secret';
const members=[{wecom_phone:'13900139155',deviceNumber:'155',appSlot:'main',bindingVerified:true},
  {wecom_phone:'13900139255',deviceNumber:'155',appSlot:'clone',bindingVerified:true}];
const client=rows=>({appId:'fixture',secret,callbackUrl:'http://127.0.0.1:1/api/v1/lead/callback',allowLoopbackTest:true,allDeviceStatus:true,members:rows});
const phoneOnly=(id=1n,account=members[0].wecom_phone)=>({lead_id:id,phone:'13800138001',wecom_phone:account});
const input=(id=1n,account=members[0].wecom_phone)=>({...phoneOnly(id,account),wecom_userid:'member',wecom_corp_id:'ww_fixture'});
async function fixture(t,{rows=members,callbackFailures=0,deviceRows}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cps-phone-')),store=await createStore({file:path.join(dir,'journal.json')});
  let now=1793584800000,seq=0,busy=false;
  const clients=parseClients(JSON.stringify([client(rows)])),submitted=[],callbacks=[],jobs=new Map();
  const inventory=()=>({updatedAt:new Date(now).toISOString(),capacity:{remaining:2},devices:deviceRows??[{deviceNumber:'155',deviceName:'155',deviceId:'adb:synthetic155',listed:true,online:true,adbOnline:true,agentOnline:true,busy,available:!busy,wecomAllowed:true,remarkPhoneReady:true,appSlots:[{appSlot:'main'},{appSlot:'clone'}]},{deviceNumber:'78',online:false,busy:false,appSlots:[]}]});
  const platform={mode:'send',inventory:async()=>inventory(),submit:async lead=>{
    submitted.push(structuredClone(lead));const job={jobId:'job-'+lead.leadId,deviceId:lead.deviceId,deviceNumber:lead.target.deviceNumber,requestId:lead.requestId,appSlot:lead.target.appSlot,mode:'send',status:'running',result:{}};jobs.set(lead.leadId,job);return job;
  },find:async lead=>jobs.get(lead.leadId)};
  const service=createService({store,clients,platform,clock:()=>now,nonce:()=>`callback-${++seq}`,fetchImpl:async(url,opts)=>{
    callbacks.push(opts.body);const failed=callbacks.length<=callbackFailures;return new Response(JSON.stringify({success:!failed,code:failed?500:200}),{status:failed?500:200});
  }});
  const signed=v=>{const body={...v,app_id:'fixture',timestamp:now,nonce:`request-${++seq}`};return stringifyBody({...body,sign:signature(body,secret)});};
  const server=createHttpServer(service),address=await listen(server);t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await service.close();await fs.rm(dir,{recursive:true,force:true});});
  const post=async(route,v)=>{const r=await fetch(`http://127.0.0.1:${address.port}`+route,{method:'POST',headers:{'content-type':'application/json'},body:signed(v)});return{http:r.status,body:await r.json()};};
  return{clients,store,service,submitted,jobs,callbacks,signed,post,advance:ms=>{now+=ms;},busy:value=>{busy=value;},finish:async(id='1')=>{
    Object.assign(jobs.get(id),{status:'failed',result:{code:'already_contact',sendStatus:'not_attempted'}});now+=2000;await service.tick();await service.tick();
  }};
}

test('signed device list exposes account phones under the correct main and clone; dispatch uses customer phone',async t=>{
  const f=await fixture(t);const list=(await f.post(ROUTES.devices,{})).body.result;
  assert.deepEqual(list.devices[0].accounts.map(a=>[a.wecom_phone,a.app_slot]),[[members[0].wecom_phone,'main'],[members[1].wecom_phone,'clone']]);
  assert.equal(list.devices[0].device_number,'155');assert.deepEqual(list.devices[1].accounts,[]);
  assert.ok(list.devices[0].accounts.every(a=>a.wecom_name===null));
  assert.equal((await f.post(ROUTES.dispatch,input(1n,members[1].wecom_phone))).body.success,true);await f.service.tick();
  const lead=f.submitted[0];assert.equal(lead.target.appSlot,'clone');assert.equal(lead.target.deviceNumber,'155');assert.equal(lead.input.phone,'13800138001');assert.notEqual(lead.input.phone,lead.input.wecom_phone);
});

test('configured account nicknames are display-only, may repeat, and include offline registered phones',async t=>{
  const names=['小文','小文','小文','小珍','珍珍'];
  const rows=names.map((wecom_name,i)=>({deviceNumber:String(200+i),wecom_phone:'13900139'+String(200+i),wecom_name,appSlot:'main',bindingVerified:true}));
  const deviceRows=rows.map((m,i)=>({deviceNumber:m.deviceNumber,deviceName:'phone '+m.deviceNumber,deviceId:i===0||i===2?'adb:synthetic'+m.deviceNumber:null,
    listed:true,online:i===0||i===2,adbOnline:i===0||i===2,agentOnline:i===0||i===2,busy:false,available:i===0||i===2,wecomAllowed:true,remarkPhoneReady:true,appSlots:[{appSlot:'main'}],wecom_name:'untrusted upstream name'}));
  deviceRows.push({deviceNumber:'78',online:false,busy:false,appSlots:[],wecom_name:'not authorized for this app'});
  const f=await fixture(t,{rows,deviceRows});
  const result=(await f.post(ROUTES.devices,{})).body.result;
  assert.deepEqual(result.devices.slice(0,5).map(d=>[d.device_number,d.accounts[0].wecom_phone,d.accounts[0].wecom_name]),rows.map(m=>[m.deviceNumber,m.wecom_phone,m.wecom_name]));
  assert.deepEqual(result.devices[5].accounts,[]);
  const offline=result.devices.filter(d=>['201','203','204'].includes(d.device_number));
  assert.ok(offline.every(d=>!d.online&&!d.available&&d.accounts[0].unavailable_reason==='adb_offline'));
  const online=(await f.post(ROUTES.devices,{online_only:true})).body.result.devices;
  assert.deepEqual(online.map(d=>[d.device_number,d.accounts[0].wecom_name]),[['200','小文'],['202','小文']]);
  assert.equal((await f.post(ROUTES.dispatch,{...input(1n,rows[1].wecom_phone),wecom_name:'小文'})).body.code,2003);
  assert.equal((await f.post(ROUTES.dispatch,input(1n,rows[1].wecom_phone))).body.code,2003);
  assert.equal((await f.post(ROUTES.dispatch,input(2n,rows[2].wecom_phone))).body.success,true);await f.service.tick();
  assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].target.deviceNumber,'202');
  assert.equal(f.submitted[0].target.wecom_phone,rows[2].wecom_phone);assert.equal(f.submitted[0].input.wecom_name,undefined);
  assert.ok(!JSON.stringify(result).includes('untrusted upstream name'));assert.ok(!JSON.stringify(result).includes('not authorized for this app'));
});

test('nickname changes never invalidate or repeat an existing phone-routed task',async t=>{
  const f=await fixture(t,{rows:[{...members[0],wecom_name:'旧昵称'}]});
  assert.equal((await f.post(ROUTES.dispatch,input())).body.success,true);
  const member=[...f.clients.get('fixture').members.values()][0];member.wecom_name='新昵称';
  await f.service.tick();assert.equal(f.submitted.length,1);
  assert.equal((await f.post(ROUTES.devices,{})).body.result.devices[0].accounts[0].wecom_name,'新昵称');
  member.wecom_name='小文';f.advance(2100);await f.service.tick();
  assert.equal((await f.post(ROUTES.dispatch,input())).body.success,true);await f.service.tick();
  assert.equal(f.submitted.length,1);assert.equal(f.store.snapshot().leads[0].stage,'submitted');
});

test('nickname config accepts Unicode and rejects invalid values without requiring names for old configs',()=>{
  for(const name of ['小文','名字 😀','😀'.repeat(80)])assert.equal(parseClients(JSON.stringify([client([{...members[0],wecom_name:name}])])).get('fixture').members.values().next().value.wecom_name,name);
  for(const name of [null,1,{},'', ' ', ' 小文','小文 ', '😀'.repeat(81),'小\n文','小\u0000文','小\u0085文','\ud800']){
    assert.throws(()=>parseClients(JSON.stringify([client([{...members[0],wecom_name:name}])])),/cps_member_name_invalid/);
  }
  assert.equal(parseClients(JSON.stringify([client([members[0]])])).size,1);
});
test('account phone is required in phone mode, validated, signed, and never falls back to another member',async t=>{
  const f=await fixture(t);
  for(const phone of [undefined,'',13900139155,'1390013915','13900139999']){
    const v=input();if(phone===undefined)delete v.wecom_phone;else v.wecom_phone=phone;
    assert.equal((await f.post(ROUTES.dispatch,v)).body.success,false);
  }
  const tampered=JSON.parse(f.signed(input()));tampered.wecom_phone=members[1].wecom_phone;
  const response=await f.service.handle('POST',ROUTES.dispatch,JSON.stringify(tampered));assert.equal(response.body.code,1001);assert.equal(f.store.snapshot().leads.length,0);
});
test('121-second retry and changed member ID do not duplicate the same account/customer',async t=>{
  const f=await fixture(t);assert.equal((await f.post(ROUTES.dispatch,input())).body.success,true);await f.service.tick();f.advance(121000);
  assert.equal((await f.post(ROUTES.dispatch,input())).body.success,true);await f.service.tick();assert.equal(f.submitted.length,1);
  assert.equal((await f.post(ROUTES.dispatch,input(2n))).body.success,false);
  assert.equal((await f.post(ROUTES.dispatch,{...input(3n),wecom_userid:'different-member'})).body.success,false);
  assert.equal((await f.post(ROUTES.dispatch,input(1n,members[1].wecom_phone))).body.success,false);
});
test('phone-only retries reuse the original lead even after its callback redacts the customer phone',async t=>{
  const f=await fixture(t);
  assert.equal((await f.post(ROUTES.dispatch,input())).body.success,true);
  await f.service.tick();await f.finish();
  assert.equal(f.store.snapshot().leads[0].input.phone,undefined);
  for(const body of [phoneOnly(),{...phoneOnly(),wecom_corp_id:null,wecom_userid:''}]){
    assert.equal((await f.post(ROUTES.dispatch,body)).body.success,true);
  }
  assert.equal((await f.post(ROUTES.dispatch,{...phoneOnly(),wecom_userid:'different-member'})).body.code,2003);
  assert.equal((await f.post(ROUTES.dispatch,{...phoneOnly(),phone:'13800138002'})).body.code,2003);
  assert.equal((await f.post(ROUTES.dispatch,phoneOnly(2n))).body.code,2003);
  await f.service.tick();
  assert.equal(f.submitted.length,1);assert.equal(f.callbacks.length,1);
});
test('callbacks retry notification only; changing configured slot never reroutes a pending phone task',async t=>{
  const f=await fixture(t,{callbackFailures:1});await f.post(ROUTES.dispatch,input());await f.service.tick();await f.finish();
  assert.equal(f.callbacks.length,1);f.advance(5000);await f.service.tick();assert.equal(f.callbacks.length,2);assert.equal(f.submitted.length,1);
  await f.post(ROUTES.dispatch,{...input(2n,members[1].wecom_phone),phone:'13800138002'});
  const mapping=[...f.clients.get('fixture').members.values()].find(m=>m.appSlot==='clone');mapping.appSlot='main';await f.service.tick();
  assert.equal(f.store.snapshot().leads.find(l=>l.leadId==='2').error,'member_mapping_changed');assert.equal(f.submitted.length,1);
});
test('busy physical phone makes both account phone entries unavailable; unverified account cannot execute',async t=>{
  const f=await fixture(t);f.busy(true);const row=(await f.post(ROUTES.devices,{})).body.result.devices[0];
  assert.ok(row.accounts.every(a=>a.available===false&&a.unavailable_reason==='device_busy'));assert.equal((await f.post(ROUTES.dispatch,input())).body.success,false);
  f.busy(false);[...f.clients.get('fixture').members.values()][0].bindingVerified=false;
  assert.equal((await f.post(ROUTES.dispatch,input())).body.success,false);assert.equal(f.store.snapshot().leads.length,0);
});
test('a rate limit belongs to account phone even when caller changes member metadata',async t=>{
  const f=await fixture(t);await f.post(ROUTES.dispatch,input());await f.service.tick();
  Object.assign(f.jobs.get('1'),{status:'failed',completedAt:new Date(1793584800000).toISOString(),result:{code:'wecom_add_friend_too_frequent',addFriendLimitConfirmed:true,addFriendLimitProof:'wecom_system_dialog_v1',sendStatus:'not_attempted'}});
  f.advance(2000);await f.service.tick();const r=await f.post(ROUTES.dispatch,{...input(2n),phone:'13800138002',wecom_userid:'changed'});
  assert.equal(r.body.success,false);assert.match(r.body.message,/过频/);const row=(await f.post(ROUTES.devices,{})).body.result.devices[0];assert.equal(row.accounts[0].unavailable_reason,'member_rate_limited');assert.equal(row.accounts[1].available,true);
});
test('phone binding optionally pins official IDs and rejects conflicting caller identity',async t=>{
  const f=await fixture(t,{rows:[{...members[0],wecom_corp_id:'ww_other',wecom_userid:'member'}]});
  assert.equal((await f.post(ROUTES.dispatch,input())).body.success,false);assert.equal(f.submitted.length,0);
  assert.equal((await f.post(ROUTES.dispatch,{...phoneOnly(),wecom_userid:123})).body.code,2003);
  assert.equal((await f.post(ROUTES.dispatch,phoneOnly())).body.success,true);await f.service.tick();
  assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].target.wecom_corp_id,'ww_other');
  assert.equal((await f.post(ROUTES.dispatch,{...input(),wecom_corp_id:'ww_other'})).body.success,true);
  assert.equal((await f.post(ROUTES.dispatch,input())).body.code,2003);
  assert.equal((await f.post(ROUTES.dispatch,{...phoneOnly(2n),phone:'13800138002'})).body.success,true);
  [...f.clients.get('fixture').members.values()][0].wecom_corp_id='ww_changed';
  await f.service.tick();
  assert.equal(f.store.snapshot().leads.find(l=>l.leadId==='2').error,'member_mapping_changed');
  assert.equal(f.submitted.length,1);
});
test('legacy recipient fence survives phone routing migration and callback phone redaction',async t=>{
  const legacy={deviceNumber:'155',appSlot:'main',wecom_corp_id:'ww_fixture',wecom_userid:'member',bindingVerified:true};const f=await fixture(t,{rows:[legacy]});
  assert.equal((await f.post(ROUTES.dispatch,{lead_id:1n,phone:'13800138001'})).body.code,2003);
  const old=input();delete old.wecom_phone;await f.post(ROUTES.dispatch,old);await f.service.tick();await f.finish();
  await f.store.transact(s=>{delete s.recipients[0].physicalKey;});assert.equal(f.store.snapshot().leads[0].input.phone,undefined);
  f.clients.set('fixture',parseClients(JSON.stringify([client([members[0]])])).get('fixture'));
  assert.match((await f.post(ROUTES.dispatch,phoneOnly(2n))).body.message,/不能重复添加/);
  assert.equal((await f.post(ROUTES.dispatch,{...input(2n),wecom_userid:'new-member'})).body.success,false);assert.equal(f.submitted.length,1);
  const moved={...members[0],deviceNumber:'202',wecom_corp_id:legacy.wecom_corp_id,wecom_userid:legacy.wecom_userid};
  f.clients.set('fixture',parseClients(JSON.stringify([client([moved])])).get('fixture'));
  assert.match((await f.post(ROUTES.dispatch,phoneOnly(2n))).body.message,/不能重复添加/);
});
test('configuration rejects duplicate account phones, mixed routing, shared slots and partial official IDs',()=>{
  for(const rows of [[members[0],{...members[1],wecom_phone:members[0].wecom_phone}], [members[0],{...members[1],appSlot:'main'}],
    [members[0],{deviceNumber:'59',appSlot:'main',wecom_corp_id:'ww_x',wecom_userid:'m'}], [{...members[0],wecom_userid:'partial'}]]){
    assert.throws(()=>parseClients(JSON.stringify([client(rows)])));
  }
  assert.throws(()=>parseClients(JSON.stringify([client([members[0]]),{...client([{...members[1],deviceNumber:'59',wecom_phone:members[0].wecom_phone}]),appId:'other'}])));
});

test('new single-account phones: signed list, dispatch, timeout retry and callback retry stay independent',async t=>{
  const rows=[{wecom_phone:'13900139200',deviceNumber:'200',appSlot:'main',bindingVerified:true},
    {wecom_phone:'13900139202',deviceNumber:'202',appSlot:'main',bindingVerified:true}];
  const deviceRows=rows.map(m=>({deviceNumber:m.deviceNumber,deviceName:m.deviceNumber,deviceId:'adb:synthetic'+m.deviceNumber,
    listed:true,online:true,adbOnline:true,agentOnline:true,busy:false,available:true,wecomAllowed:true,remarkPhoneReady:true,appSlots:[{appSlot:'main'}]}));
  const f=await fixture(t,{rows,deviceRows,callbackFailures:1});
  const list=(await f.post(ROUTES.devices,{})).body.result.devices;
  assert.deepEqual(list.map(d=>[d.device_number,d.accounts.map(a=>[a.wecom_phone,a.app_slot])]),
    rows.map(m=>[m.deviceNumber,[[m.wecom_phone,'main']]]));
  assert.equal((await f.post(ROUTES.dispatch,input(1n,rows[0].wecom_phone))).body.success,true);await f.service.tick();
  f.advance(121000);
  assert.equal((await f.post(ROUTES.dispatch,input(1n,rows[0].wecom_phone))).body.success,true);await f.service.tick();
  assert.equal(f.submitted.length,1);
  deviceRows[0].busy=true;deviceRows[0].available=false;
  assert.equal((await f.post(ROUTES.dispatch,{...input(2n,rows[1].wecom_phone),phone:'13800138002'})).body.success,true);await f.service.tick();
  assert.deepEqual(f.submitted.map(l=>[l.target.deviceNumber,l.target.appSlot]),[['200','main'],['202','main']]);
  assert.equal(f.submitted[0].input.phone,'13800138001');assert.equal(f.submitted[0].input.wecom_phone,rows[0].wecom_phone);
  await f.finish('2');assert.equal(f.callbacks.length,1);f.advance(5000);await f.service.tick();
  assert.equal(f.callbacks.length,2);assert.equal(f.submitted.length,2);
  assert.equal(f.jobs.get('1').status,'running');
});
