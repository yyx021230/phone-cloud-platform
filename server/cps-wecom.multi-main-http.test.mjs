// Actual loopback CPS HTTP and persistence; all devices/results are synthetic.
// No ADB, native worker, real account, customer search or invitation.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createService} from './cps-wecom/service.mjs';
import {createStore} from './cps-wecom/store.mjs';
import {createHttpServer,listen} from './cps-wecom/http.mjs';
import {parseClients} from './cps-wecom/protocol.mjs';

test('two main accounts process multiple customers independently; retries never repeat execution',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cps-multi-main-'));
  const app='synthetic_multi_main',secret='synthetic_test_only_multi_main_secret';
  let now=Date.now(),service,api;
  const events=[],jobs=new Map(),busy=new Set(),callbacks=[];
  const accounts={'200':'13900139200','202':'13900139202'};
  function sign(body){
    const text=Object.keys(body).filter(k=>k!=='sign'&&body[k]!==null&&body[k]!=='').sort().map(k=>k+'='+String(body[k])).join('&');
    return createHash('sha256').update(text+'&secret='+secret).digest('hex');
  }
  const receiver=http.createServer(async(req,res)=>{
    try{
      assert.equal(req.method,'POST');assert.equal(req.url,'/api/v1/lead/callback');
      let raw='';for await(const b of req)raw+=b;
      const body=JSON.parse(raw);assert.equal(body.sign,sign(body));assert.equal(body.app_id,app);
      assert.ok(!callbacks.some(c=>c.nonce===body.nonce));callbacks.push(body);
      const fail=body.lead_id===20201&&callbacks.filter(c=>c.lead_id===20201).length===1;
      res.writeHead(fail?500:200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:!fail,code:fail?500:200}));
    }catch(error){res.writeHead(500);res.end('{}');events.push({error:error.message});}
  });
  const callbackAddress=await listen(receiver);
  const clients=parseClients(JSON.stringify([{appId:app,secret,callbackUrl:`http://127.0.0.1:${callbackAddress.port}/api/v1/lead/callback`,allowLoopbackTest:true,allDeviceStatus:true,
    members:Object.entries(accounts).map(([deviceNumber,wecom_phone])=>({deviceNumber,wecom_phone,appSlot:'main',bindingVerified:true}))}]));
  const platform={mode:'send',async inventory(){return {capacity:{limit:2,active:busy.size,remaining:2-busy.size},devices:Object.keys(accounts).map(n=>({deviceNumber:n,deviceId:'adb:synthetic_'+n,listed:true,online:true,adbOnline:true,agentOnline:true,busy:busy.has(n),available:!busy.has(n),wecomAllowed:true,remarkPhoneReady:true,appSlots:[{appSlot:'main'}]}))};},
    async submit(lead){
      assert.ok(!jobs.has(lead.leadId),'no second execution for the original lead');
      assert.ok(!busy.has(lead.target.deviceNumber),'no overlap on one physical phone');
      const job={jobId:'synthetic_'+lead.leadId,requestId:lead.requestId,deviceId:lead.deviceId,deviceNumber:lead.target.deviceNumber,appSlot:'main',mode:'send',status:'running'};
      jobs.set(lead.leadId,job);busy.add(job.deviceNumber);events.push({start:lead.leadId,device:job.deviceNumber,phone:lead.input.phone});return job;
    },async find(lead){return jobs.get(lead.leadId)||null;}};
  const store=await createStore({file:path.join(dir,'journal.json')});
  try{
    service=createService({store,clients,platform,clock:()=>now});await service.initialize();api=createHttpServer(service);const address=await listen(api);
    async function call(route,business){
      const body={...business,app_id:app,timestamp:now,nonce:randomBytes(12).toString('hex')};body.sign=sign(body);
      const r=await fetch(`http://127.0.0.1:${address.port}`+route,{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
      assert.equal(r.status,200);return r.json();
    }
    const dispatch=(n,id,customer)=>call('/api/v1/lead/dispatch',{lead_id:id,phone:customer,wecom_phone:accounts[n],wecom_corp_id:'synthetic_corp',wecom_userid:'synthetic_member_'+n});
    const devices=()=>call('/api/v1/lead/devices/query',{online_only:false});
    const tick=async()=>{now+=2100;await service.tick();};
    async function finish(id,kind='success'){
      const job=jobs.get(String(id));assert.ok(job);busy.delete(job.deviceNumber);
      const result={invitationSent:false,sendStatus:'not_attempted',remarkSaveStatus:'not_attempted',execution:{cleanupConfirmed:true}};
      if(kind==='success')Object.assign(result,{invitationSent:true,sendStatus:'confirmed',remarkPhoneSet:true,invitationRequestConfirmed:true,invitationRequestProof:'wecom_system_dialog_v1'});
      else if(kind==='duplicate')result.code='already_contact';
      else if(kind==='frequency')Object.assign(result,{code:'wecom_add_friend_too_frequent',addFriendLimitConfirmed:true,addFriendLimitProof:'wecom_system_dialog_v1'});
      else Object.assign(result,{code:'wecom_search_returned_without_result'});
      Object.assign(job,{status:kind==='success'?'succeeded':'failed',result,completedAt:new Date(now).toISOString()});await tick();await tick();
    }
    const initial=await devices();assert.equal(initial.result.total,2);assert.ok(initial.result.devices.every(d=>d.accounts.length===1&&d.accounts[0].app_slot==='main'));
    assert.equal((await dispatch('200',20001,'13900200001')).success,true);
    assert.equal((await dispatch('202',20201,'13900202001')).success,true);await tick();assert.equal(jobs.size,2);assert.equal(busy.size,2);
    for(let i=0;i<3;i++)assert.equal((await dispatch('200',20001,'13900200001')).success,true);
    assert.equal((await dispatch('200',20999,'13900200001')).code,2003);
    assert.equal((await dispatch('200',20002,'13900200002')).code,2003);
    await finish(20201);assert.equal(store.snapshot().leads.find(l=>l.leadId==='20201').stage,'callback_pending');
    assert.equal(busy.has('200'),true);assert.equal(busy.has('202'),false);
    assert.equal((await dispatch('202',20202,'13900202002')).success,true);await tick();assert.equal(jobs.size,3);
    now+=6000;await service.tick();assert.equal(callbacks.filter(c=>c.lead_id===20201).length,2);assert.equal(jobs.size,3);
    await finish(20202,'duplicate');
    assert.equal((await dispatch('202',20203,'13900202003')).success,true);await tick();await finish(20203,'frequency');
    assert.equal((await dispatch('202',20204,'13900202004')).code,2003);assert.equal(busy.has('200'),true);
    await finish(20001);
    assert.equal((await dispatch('200',20002,'13900200002')).success,true);await tick();await finish(20002,'ordinary');
    assert.equal(store.snapshot().leads.find(l=>l.leadId==='20002').stage,'needs_attention');assert.equal(callbacks.filter(c=>c.lead_id===20002).length,0);
    assert.equal(store.snapshot().leads.find(l=>l.leadId==='20002').error,'wecom_search_returned_without_result');
    assert.equal((await dispatch('200',20003,'13900200003')).success,true);await tick();await finish(20003);
    assert.equal((await dispatch('200',20001,'13900200001')).success,true);await tick();
    assert.equal(jobs.size,6);assert.equal(events.filter(e=>e.start).length,6);assert.equal(new Set(events.filter(e=>e.start).map(e=>e.phone)).size,6);
    assert.equal(busy.size,0);assert.equal(callbacks.length,6);assert.ok(!events.some(e=>e.error));
    assert.equal(store.snapshot().leads.filter(l=>l.stage==='completed').length,5);
    const final=await devices();assert.equal(final.result.devices.find(d=>d.device_number==='200').available,true);
    assert.equal(final.result.devices.find(d=>d.device_number==='202').accounts[0].unavailable_reason,'member_rate_limited');
    // Next virtual business day: a burst can be acknowledged before the first
    // physical job claims its phone. All six must drain, one per phone at once.
    // Do not erase the previous recipient/limit records to make this possible.
    now+=86400000;
    const burst=[];
    for(const n of ['200','202'])for(let i=1;i<=3;i++){
      const id=Number(n)*100+100+i;burst.push(String(id));
      assert.equal((await dispatch(n,id,'139003'+n+String(i).padStart(2,'0'))).success,true);
    }
    assert.equal(store.snapshot().leads.filter(l=>l.stage==='queued').length,6);
    await tick();assert.equal(busy.size,2);
    for(let round=0;round<20;round++){
      const running=[...jobs].filter(([id,j])=>burst.includes(id)&&j.status==='running').map(([id])=>id);
      for(const id of running)await finish(id);
      if(burst.every(id=>store.snapshot().leads.find(l=>l.leadId===id)?.stage==='completed'))break;
      await tick();
    }
    assert.ok(burst.every(id=>store.snapshot().leads.find(l=>l.leadId===id)?.stage==='completed'));
    assert.equal(jobs.size,12);assert.equal(events.filter(e=>e.start).length,12);
    assert.equal(new Set(events.filter(e=>e.start).map(e=>e.phone)).size,12);
    assert.equal(busy.size,0);assert.equal(callbacks.length,12);assert.ok(!events.some(e=>e.error));
    assert.ok((await devices()).result.devices.every(d=>d.available&&!d.busy));
    t.diagnostic(JSON.stringify({boundary:'synthetic phones/results and virtual time only',customers:12,jobs:12,burstCustomers:6,callbackAttempts:callbacks.length,completed:11,needsAttention:1,blockedPhoneDidNotBlockOtherPhone:true,realInvitations:0}));
  }finally{
    if(api)await new Promise(r=>api.close(r));if(service)await service.close();else await store.close();await new Promise(r=>receiver.close(r));await fs.rm(dir,{recursive:true,force:true});
  }
});
