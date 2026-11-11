// External-client acceptance: actual bridge/platform child processes and HTTP.
// Android, users and callback receiver are synthetic; no real ADB or invitation.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {createSimulatedWecomCleanup} from './wecom-causal-fixture.mjs';
import {WECOM_PREVIEW_DEVICES as phones} from './wecom-preview.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentSource=await fs.readFile(path.join(root,'windows-agent/src/index.mjs'),'utf8');
const statusSerializer=agentSource.match(/^function compactTaskResultForStatus\(result = \{\}\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(statusSerializer,'actual Agent status serializer exists');
const compactAgentStatus=new Function('compactEventDetail',statusSerializer+';return compactTaskResultForStatus;')(value=>value);
const dispatchPath='/api/v1/lead/dispatch',devicesPath='/api/v1/lead/devices/query';
const taskPath='/api/v1/user/automation/wecom-preview-tasks';
const appId='cps_external_fixture',secret='demo_secret_only_for_document';
// Deliberately independent of the bridge protocol implementation. The fixture
// uses JSON-safe IDs; full INT64 transport has separate lossless HTTP coverage.
function cpsSign(body){
  const fields=Object.entries(body).filter(([k,v])=>k!=='sign'&&v!==null&&v!=='').sort(([a],[b])=>a<b?-1:a>b?1:0);
  return createHash('sha256').update(fields.map(([k,v])=>k+'='+String(v)).join('&')+'&secret='+secret,'utf8').digest('hex');
}
function envelope(input){const body={...input,app_id:appId,timestamp:Date.now(),nonce:randomBytes(16).toString('hex')};return{...body,sign:cpsSign(body)};}
const executionPhones={member_43:'13900139043',member_59:'13900139059',member_155_main:'13900139155',member_155_clone:'13900139255'};
const lead=(id,member='member_43',phone='13800138000')=>({lead_id:id,phone,wecom_phone:executionPhones[member]});
async function listen(server,port=0){server.listen(port,'127.0.0.1');await once(server,'listening');return'http://127.0.0.1:'+server.address().port;}
async function unusedPort(){const server=http.createServer();await listen(server);const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function waitFor(fn,message,timeout=18000){const until=Date.now()+timeout;do{if(await fn())return;await pause(80);}while(Date.now()<until);throw Error(message);}
async function closeHttp(server){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}
function isolatedEnv(extra){return{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,TZ:'Asia/Shanghai',...extra};}
async function child(entry,env,base){
  let output='';const processChild=spawn(process.execPath,[entry],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  for(const stream of [processChild.stdout,processChild.stderr])stream.on('data',b=>{output=(output+b).slice(-12000);});
  try{await waitFor(async()=>{if(processChild.exitCode!==null)throw Error('isolated child exited: '+output.slice(-400));try{return(await fetch(base+'/healthz')).ok;}catch{return false;}},'isolated child did not start');}
  catch(error){if(processChild.exitCode===null&&processChild.signalCode===null){const exited=once(processChild,'exit');processChild.kill('SIGKILL');await exited;}throw error;}
  return{process:processChild,async stop(){if(processChild.exitCode!==null||processChild.signalCode!==null)return;let timer;const exited=once(processChild,'exit');processChild.kill('SIGTERM');try{await Promise.race([exited,new Promise((resolve,reject)=>{timer=setTimeout(()=>{processChild.kill('SIGKILL');reject(Error('isolated child needed forced shutdown'));},15000);timer.unref();})]);}finally{clearTimeout(timer);}}};
}

const long=process.env.CPS_WECOM_LONG_E2E==='1';
test(`CPS external HTTP lifecycle (${long?'real 121-second timeout':'short default wait'}; no real phones)`,{timeout:long?260000:150000},async t=>{
  assert.equal(cpsSign({lead_id:123456,result:'success',app_id:'cps_partner_demo',timestamp:1793584800000,nonce:'demo_nonce_001'}),'c3c79ff865b5ec0505bf53a5f6946e28aa840d1011d01976b2372e20aec8a081');
  await assert.rejects(fs.stat(path.join(root,'.env')),{code:'ENOENT'},'fixture refuses an inherited platform .env');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cps-external-http-'));
  let platform,bridge,pool,heartbeat,heartbeatWork=Promise.resolve();const servers=[];const violations=[];const trace=[];
  t.after(async()=>{clearInterval(heartbeat);await heartbeatWork;try{await bridge?.stop();await platform?.stop();}finally{for(const s of servers)await closeHttp(s);await pool?.end();await fs.rm(dir,{recursive:true,force:true});}});
  const platformPort=await unusedPort(),platformBase='http://127.0.0.1:'+platformPort;
  platform=await child('server/index.mjs',isolatedEnv({HOST:'127.0.0.1',PORT:String(platformPort),DATA_DIR:path.join(dir,'platform'),DATABASE_URL:'',REDIS_URL:'',STORAGE_BACKEND:'json',STRUCTURED_WRITES:'true',ADMIN_USERNAME:'fixture_admin',ADMIN_PASSWORD:'fixture-admin-only',SCREEN_MEDIA_AUTH_SECRET:'fixture-not-a-real-secret',PUBLIC_BASE_URL:platformBase,WINDOWS_AGENT_ONLINE_SECONDS:'300'}),platformBase);
  let cleanup;
  const platformCall=async(method,route,token,input,expected=200)=>{
    const res=await fetch(platformBase+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const body=await res.json();assert.equal(res.status,expected,method+' '+route+': '+body.error);await cleanup?.observe(method,route,input,body);return body;
  };
  const admin=(await platformCall('POST','/api/v1/auth/login','',{username:'fixture_admin',password:'fixture-admin-only'})).session.token;
  const agent=(await platformCall('POST','/api/v1/windows-agents',admin,{agentId:'cps-fixture-agent',agentName:'Synthetic Agent'},201)).token;
  await platformCall('POST','/api/v1/windows-agents/cps-fixture-agent/devices/sync',agent,{agent:{agentId:'cps-fixture-agent'},devices:[...['43','59','155'].map(n=>({adbSerial:phones[n].serial,state:'device',model:'Synthetic'})),{adbSerial:'fixture-offline',state:'device',model:'SyntheticOffline'}]});
  for(const n of ['43','59','155'])await platformCall('PUT','/api/v1/devices/'+encodeURIComponent('adb:'+phones[n].serial),admin,{listingStatus:'listed',deviceName:n});
  await platformCall('PUT','/api/v1/devices/adb%3Afixture-offline',admin,{listingStatus:'listed',deviceName:'67'});
  await platformCall('POST','/api/v1/windows-agents/cps-fixture-agent/devices/sync',agent,{agent:{agentId:'cps-fixture-agent'},devices:[...['43','59','155'].map(n=>({adbSerial:phones[n].serial,state:'device',model:'Synthetic'})),{adbSerial:'fixture-offline',state:'offline',model:'SyntheticOffline'}]});
  const poll='/api/v1/windows-agents/cps-fixture-agent/tasks/next?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1&wecomRemarkPhone=verified-v1';
  cleanup=createSimulatedWecomCleanup({request:platformCall,agentId:'cps-fixture-agent',token:agent,nextRoute:poll});
  await platformCall('GET',poll,agent);
  const lookupPath='/api/v1/user/automation/alipay-name-sessions';
  const lookup=(await platformCall('POST',lookupPath,admin,{deviceId:'adb:'+phones['59'].serial},201)).session;
  const lookupTask=(await platformCall('GET',poll,agent)).task;assert.equal(lookupTask.type,'alipay_name_start');
  await platformCall('POST','/api/v1/windows-agent-tasks/'+lookupTask.taskId+'/status',agent,{status:'succeeded',result:{currentAccount:'fixture-account',accountIdentityVerified:true,savedAccounts:[{account:'fixture-account',current:true}]}});
  const lookupBefore=(await platformCall('GET',lookupPath,admin)).sessions.find(s=>s.sessionId===lookup.sessionId);
  const locksForLookup=async()=>(await platformCall('GET','/api/v1/device-locks',admin)).locks.filter(l=>l.deviceId==='adb:'+phones['59'].serial&&l.status==='active');
  const lookupLocksBefore=await locksForLookup();assert.equal(lookupBefore.status,'ready');

  const callbackRequests=[],applied=new Map(),callbackPolicy=new Map(),callbackNonces=new Set();
  const callbackServer=http.createServer(async(req,res)=>{
    try{
      assert.equal(req.url,'/api/v1/lead/callback');assert.equal(req.method,'POST');let raw='';for await(const b of req)raw+=b;
      const body=JSON.parse(raw);assert.equal(cpsSign(body),body.sign);assert.equal(body.app_id,appId);assert.ok(Math.abs(Date.now()-body.timestamp)<=300000);
      assert.ok(!callbackNonces.has(body.nonce));callbackNonces.add(body.nonce);callbackRequests.push(body);
      const attempts=callbackRequests.filter(r=>r.lead_id===body.lead_id).length,policy=callbackPolicy.get(body.lead_id);
      if(policy==='500_once'&&attempts===1){res.writeHead(500,{'content-type':'application/json'});res.end('{"success":false,"code":500}');return;}
      if(policy==='reject'){res.writeHead(200,{'content-type':'application/json'});res.end('{"success":false,"code":1001}');return;}
      if(!applied.has(body.lead_id))applied.set(body.lead_id,body.result);
      else assert.equal(applied.get(body.lead_id),body.result,'CPS sees stable result on retry');
      if(policy==='ack_lost_once'&&attempts===1){res.destroy();return;}
      if(policy==='timeout_once'&&attempts===1)return; // Let the bridge's real 5s HTTP timeout fire.
      res.writeHead(200,{'content-type':'application/json'});res.end('{"success":true,"code":200}');
    }catch(error){violations.push(error.message);res.writeHead(400);res.end('{}');}
  });servers.push(callbackServer);const callbackBase=await listen(callbackServer);
  const submissions=new Map();let dropPlatformAck=true,raceLookup;
  const upstreamProxy=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const b of req)raw+=b;
      if(req.method==='POST'&&req.url===taskPath){
        const input=JSON.parse(raw);submissions.set(input.requestId,(submissions.get(input.requestId)||0)+1);
        assert.match(input.description,/^leadId:\d+$/);assert.equal(input.remarkName,input.description.slice('leadId:'.length));
        assert.equal(input.requireRemarkPhone,true);
        if(input.description==='leadId:208'&&!raceLookup){
          raceLookup=(await platformCall('POST',lookupPath,admin,{deviceId:'adb:'+phones['155'].serial},201)).session;
          const task=(await platformCall('GET',poll,agent)).task;assert.equal(task.type,'alipay_name_start');
          await platformCall('POST','/api/v1/windows-agent-tasks/'+task.taskId+'/status',agent,{status:'succeeded',result:{currentAccount:'race-fixture',accountIdentityVerified:true,savedAccounts:[{account:'race-fixture',current:true}]}});
          trace.push('lookup_wins_post_acceptance_race');
        }
      }
      const answer=await fetch(platformBase+req.url,{method:req.method,headers:{'content-type':'application/json',authorization:req.headers.authorization},...(req.method==='GET'?{}:{body:raw})});
      const bytes=await answer.text();
      if(req.method==='POST'&&req.url===taskPath&&answer.ok&&dropPlatformAck){dropPlatformAck=false;trace.push('original_platform_submission_ack_lost');res.destroy();return;}
      res.writeHead(answer.status,{'content-type':'application/json'});res.end(bytes);
    }catch{if(!res.destroyed){res.writeHead(502);res.end('{}');}}
  });servers.push(upstreamProxy);const upstreamBase=await listen(upstreamProxy);
  const databaseUrl=process.env.CPS_WECOM_E2E_DATABASE_URL||'',stateKey='external_'+process.pid+'_'+randomBytes(6).toString('hex');
  if(databaseUrl){const u=new URL(databaseUrl);assert.ok(['127.0.0.1','localhost'].includes(u.hostname)&&u.pathname==='/cps_wecom_client_fixture','dedicated loopback DB required');pool=new pg.Pool({connectionString:databaseUrl,max:2});await pool.query(await fs.readFile(path.join(root,'deploy/sql/cps-wecom.sql'),'utf8'));}
  const journal=path.join(dir,'bridge','journal.json');
  const snapshot=async()=>databaseUrl?(await pool.query('select data from phone_cloud_cps_wecom where state_key=$1',[stateKey])).rows[0]?.data:JSON.parse(await fs.readFile(journal,'utf8'));
  const bridgePort=await unusedPort(),bridgeBase='http://127.0.0.1:'+bridgePort;
  const members=[{deviceNumber:'43',appSlot:'main',wecom_phone:executionPhones.member_43},{deviceNumber:'59',appSlot:'main',wecom_phone:executionPhones.member_59},{deviceNumber:'155',appSlot:'main',wecom_phone:executionPhones.member_155_main},{deviceNumber:'155',appSlot:'clone',wecom_phone:executionPhones.member_155_clone}].map(m=>({...m,wecom_name:'已配置昵称',bindingVerified:true}));
  const bridgeEnv=isolatedEnv({NODE_ENV:'test',CPS_WECOM_ENABLED:'true',CPS_EXECUTION_MODE:'send',CPS_WECOM_CLIENTS_JSON:JSON.stringify([{appId,secret,callbackUrl:callbackBase+'/api/v1/lead/callback',allowLoopbackTest:true,allDeviceStatus:true,members}]),CPS_PLATFORM_BASE_URL:upstreamBase,CPS_PLATFORM_TOKEN:admin,CPS_DATA_DIR:path.dirname(journal),CPS_PORT:String(bridgePort),...(databaseUrl?{CPS_DATABASE_URL:databaseUrl,CPS_STATE_KEY:stateKey}:{})});
  bridge=await child('server/cps-wecom/main.mjs',bridgeEnv,bridgeBase);
  let dropCpsAck=true;const clientProxy=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const b of req)raw+=b;const answer=await fetch(bridgeBase+req.url,{method:req.method,headers:{'content-type':'application/json'},body:raw});const bytes=await answer.text();
      if(req.url===dispatchPath&&JSON.parse(raw).lead_id===101&&answer.ok&&dropCpsAck){dropCpsAck=false;trace.push('accepted_dispatch_ack_lost');res.destroy();return;}
      res.writeHead(answer.status,{'content-type':'application/json'});res.end(bytes);
    }catch{if(!res.destroyed){res.writeHead(502);res.end('{}');}}
  });servers.push(clientProxy);const cpsBase=await listen(clientProxy);
  const callRaw=async(route,body)=>{const r=await fetch(cpsBase+route,{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});return{status:r.status,body:await r.json()};};
  const call=(route,input)=>callRaw(route,envelope(input));
  const jobs=async()=>(await platformCall('GET',taskPath,admin)).tasks;
  const stage=async(id)=>(await snapshot()).leads.find(l=>l.leadId===String(id));
  const waitStage=(id,value)=>waitFor(async()=>(await stage(id))?.stage===value,'lead '+id+' did not reach '+value);
  const launches=new Map(),claims=new Map(),active=new Set();
  const pick=async(id)=>{let selected;await waitFor(async()=>{const data=await platformCall('GET',poll+'&activeTaskIds='+encodeURIComponent([...active].join(',')),agent);if(!data.task)return false;assert.equal(data.task.type,'wecom_customer_preview');selected=data.task;active.add(selected.taskId);launches.set(selected.payload.automationJobId,(launches.get(selected.payload.automationJobId)||0)+1);return true;},'Agent did not receive original task');if(id){const record=await stage(id);const bound=(await jobs()).find(j=>j.requestId===record.requestId);assert.equal(selected.payload.automationJobId,bound?.jobId);assert.equal(selected.payload.phoneNumber,lead(id).phone);}return selected;};
  const finish=async(task,result='success')=>{
    let payload;if(result==='frequency')payload={status:'failed',result:{previewStatus:'blocked',previewCode:'wecom_add_friend_too_frequent',sendStatus:'not_attempted',invitationSent:false,addFriendLimitConfirmed:true,addFriendLimitProof:'wecom_system_dialog_v1'}};
    else if(result==='duplicate')payload={status:'failed',result:{previewStatus:'blocked',previewCode:'already_contact',sendStatus:'not_attempted',invitationSent:false,remarkSaveStatus:'not_attempted'}};
    else{await platformCall('POST','/api/v1/windows-agents/cps-fixture-agent/wecom-preview-tasks/'+task.taskId+'/send-claim',agent,{},201);claims.set(task.payload.automationJobId,(claims.get(task.payload.automationJobId)||0)+1);payload={status:'succeeded',result:{previewStatus:'send_attempted',previewCode:'invitation_click_issued_delivery_unknown',sendStatus:'unknown',invitationSent:null,remarkSaveStatus:'confirmed',remarkPhoneSet:true,...(result==='success'?{invitationRequestConfirmed:true,invitationRequestProof:'wecom_system_dialog_v1'}:{})}};}
    payload.result=compactAgentStatus(payload.result);
    await platformCall('POST','/api/v1/windows-agent-tasks/'+task.taskId+'/status',agent,payload);active.delete(task.taskId);
  };

  await t.test('device status is signed, complete and read-only; real lookup occupancy refuses CPS admission',async()=>{
    const r=await call(devicesPath,{online_only:false});assert.equal(r.status,200);assert.equal(r.body.success,true);assert.equal(r.body.result.total,4);
    const accounts=r.body.result.devices.flatMap(d=>d.accounts);
    assert.equal(accounts.length,4);
    for(const account of accounts){
      assert.deepEqual(Object.keys(account).sort(),['app_slot','available','binding_verified','enabled','unavailable_reason','wecom_name','wecom_phone']);
    }
    assert.equal(r.body.result.devices.find(d=>d.device_number==='67').online,false);
    const busy=r.body.result.devices.find(d=>d.device_number==='59');assert.equal(busy.busy,true);assert.equal(busy.accounts[0].unavailable_reason,'device_busy');
    assert.equal(busy.accounts[0].wecom_phone,executionPhones.member_59);
    assert.equal(busy.accounts[0].wecom_name,'已配置昵称');
    const dual=r.body.result.devices.find(d=>d.device_number==='155');assert.equal(dual.accounts.length,2);
    assert.deepEqual(dual.accounts.map(a=>[a.app_slot,a.wecom_phone]),[['main',executionPhones.member_155_main],['clone',executionPhones.member_155_clone]]);
    assert.ok(dual.accounts.every(a=>a.wecom_name==='已配置昵称'));
    assert.equal((await call(devicesPath,{online_only:true})).body.result.total,3);
    assert.equal((await call(dispatchPath,lead(90,'member_59'))).body.code,2003);assert.equal((await snapshot()).leads.length,0);
    assert.deepEqual(await locksForLookup(),lookupLocksBefore);
    const wire=JSON.stringify(r.body);for(const hidden of [admin,agent,phones['59'].serial,'fixture-account'])assert.ok(!wire.includes(hidden));
  });
  let held;const submittedAt=Date.now();
  await t.test('lost client acceptance and lost internal POST response recover the original task once',async()=>{
    await assert.rejects(call(dispatchPath,lead(101)));assert.equal((await call(dispatchPath,lead(101))).body.success,true);
    held=await pick(101);await waitStage(101,'submitted');
    assert.equal((await snapshot()).leads.length,1);assert.equal(submissions.size,1);assert.equal([...submissions.values()][0],1);assert.deepEqual(trace,['accepted_dispatch_ack_lost','original_platform_submission_ack_lost']);
    heartbeat=setInterval(()=>{heartbeatWork=heartbeatWork.then(()=>platformCall('POST','/api/v1/windows-agent-tasks/'+held.taskId+'/status',agent,{status:'running',result:{previewStatus:'blocked',previewCode:'fixture_waiting'}})).catch(error=>violations.push(error.message));},15000).unref();
  });
  await t.test('concurrent repeated dispatch and new lead ID cannot overwrite or repeat held work',async()=>{
    const repeated=await Promise.all(Array.from({length:4},()=>call(dispatchPath,lead(101))));assert.ok(repeated.every(r=>r.body.success));
    assert.equal((await call(dispatchPath,lead(102))).body.code,2003);
    assert.equal((await call(dispatchPath,lead(101,'member_155_main'))).body.code,2003);
    const raw=envelope(lead(101));assert.equal((await callRaw(dispatchPath,raw)).body.success,true);assert.equal((await callRaw(dispatchPath,raw)).body.code,1003);
    assert.equal((await jobs()).length,1);assert.equal([...launches.values()][0],1);
  });
  let main;
  await t.test('another phone finishes while the first waits; callback 500 retries notification only',async()=>{
    const input=lead(201,'member_155_main');
    assert.deepEqual(Object.keys(input),['lead_id','phone','wecom_phone']);
    callbackPolicy.set(201,'500_once');
    const accepted=await call(dispatchPath,input);
    assert.equal(accepted.status,200);assert.equal(accepted.body.success,true);assert.equal(accepted.body.code,200);
    main=await pick();assert.equal(main.payload.appSlot,'main');assert.equal(main.payload.androidUser,0);assert.equal(main.payload.deviceNumber,'155');
    await finish(main);await waitStage(201,'completed');
    const callbacks=callbackRequests.filter(r=>r.lead_id===201);assert.equal(callbacks.length,2);assert.notEqual(callbacks[0].nonce,callbacks[1].nonce);assert.equal(applied.get(201),'success');
    for(const callback of callbacks){
      assert.deepEqual(Object.keys(callback).sort(),['app_id','lead_id','nonce','remark_phone_set','result','sign','timestamp']);
      assert.equal(callback.remark_phone_set,true);
    }
    assert.equal(claims.get(main.payload.automationJobId),1);assert.equal((await stage(101)).stage,'submitted');assert.equal((await jobs()).find(j=>j.jobId===held.payload.automationJobId).status,'running');
  });
  await t.test('main and clone bind distinct Android users and share one physical busy fence',async()=>{
    callbackPolicy.set(202,'ack_lost_once');assert.equal((await call(dispatchPath,lead(202,'member_155_clone'))).body.success,true);
    const clone=await pick();assert.equal(clone.payload.appSlot,'clone');assert.equal(clone.payload.androidUser,999);assert.equal(clone.payload.deviceNumber,'155');
    const status=(await call(devicesPath,{})).body.result;assert.equal(status.capacity.remaining,0);const list=status.devices.find(d=>d.device_number==='155');assert.equal(list.busy,true);assert.ok(list.accounts.every(a=>a.available===false));
    assert.equal((await call(dispatchPath,lead(203,'member_155_main','13900139001'))).body.code,2003);
    await finish(clone);await waitStage(202,'completed');assert.equal(callbackRequests.filter(r=>r.lead_id===202).length,2);assert.equal(applied.get(202),'success');assert.equal(claims.get(clone.payload.automationJobId),1);
    assert.equal((await jobs()).length,3);
  });
  await t.test('CPS signature rejection stops callback retries; no second device execution',async()=>{
    callbackPolicy.set(203,'reject');assert.equal((await call(dispatchPath,lead(203,'member_155_main','13900139001'))).body.success,true);
    const task=await pick();await finish(task,'duplicate');await waitStage(203,'needs_attention');assert.equal(callbackRequests.filter(r=>r.lead_id===203).length,1);assert.equal((await stage(203)).error,'callback_rejected');assert.equal(claims.has(task.payload.automationJobId),false);
  });
  await t.test('bridge restart preserves pending original execution, signatures and recipient fences',async()=>{
    await bridge.stop();bridge=await child('server/cps-wecom/main.mjs',bridgeEnv,bridgeBase);
    assert.equal((await call(dispatchPath,lead(101))).body.success,true);assert.equal((await call(dispatchPath,lead(102))).body.code,2003);
    assert.equal((await call(dispatchPath,lead(204,'member_155_clone'))).body.code,2003);
    assert.equal((await jobs()).length,4);assert.ok([...submissions.values()].every(n=>n===1));
  });
  await t.test('real callback HTTP timeout and bridge restart preserve the outbox without a second send',async()=>{
    callbackPolicy.set(207,'timeout_once');assert.equal((await call(dispatchPath,lead(207,'member_155_main','13900139007'))).body.success,true);
    const task=await pick();await finish(task);await waitFor(()=>callbackRequests.some(r=>r.lead_id===207),'callback did not begin');
    await bridge.stop();bridge=await child('server/cps-wecom/main.mjs',bridgeEnv,bridgeBase);await waitStage(207,'completed');
    const attempts=callbackRequests.filter(r=>r.lead_id===207);assert.equal(attempts.length,2);assert.notEqual(attempts[0].nonce,attempts[1].nonce);assert.ok(attempts[1].timestamp-attempts[0].timestamp>=9000);
    assert.equal(applied.get(207),'success');assert.equal(claims.get(task.payload.automationJobId),1);assert.equal(launches.get(task.payload.automationJobId),1);
  });
  await t.test('lookup acquiring a device after CPS acceptance is not preempted; only known non-admission retries',async()=>{
    assert.equal((await call(dispatchPath,lead(208,'member_155_main','13900139008'))).body.success,true);
    await waitFor(async()=>{const r=await stage(208);return r?.stage==='queued'&&r.error==='platform_busy_not_admitted';},'CPS did not preserve queued work after losing the occupancy race');
    const original=await stage(208);assert.ok(raceLookup);assert.equal((await jobs()).some(j=>j.requestId===original.requestId),false);
    const busy=(await call(devicesPath,{})).body.result.devices.find(d=>d.device_number==='155');assert.equal(busy.busy,true);assert.ok(busy.accounts.every(a=>a.available===false));
    assert.equal((await call(dispatchPath,lead(208,'member_155_main','13900139008'))).body.success,true);
    await platformCall('POST',lookupPath+'/'+raceLookup.sessionId+'/end',admin,{},202);const stop=(await platformCall('GET',poll,agent)).task;assert.equal(stop.type,'alipay_name_stop');
    await platformCall('POST','/api/v1/windows-agent-tasks/'+stop.taskId+'/status',agent,{status:'succeeded',result:{diagnostic:{lookupStopProof:{version:1,readerCleanupConfirmed:true,taskId:stop.taskId,sessionId:raceLookup.sessionId,generation:String(stop.payload?.managedLookup?.generation||'')}}}});
    const task=await pick();assert.equal(task.payload.automationJobId,(await jobs()).find(j=>j.requestId===original.requestId).jobId);await finish(task,'duplicate');await waitStage(208,'completed');
    assert.equal(submissions.get(original.requestId),2);assert.equal((await jobs()).filter(j=>j.requestId===original.requestId).length,1);
  });
  await t.test(`${long?'121 seconds':'short delay'} without a result then new-request retry does not create a second execution`,async()=>{
    const required=long?121000:1200;while(Date.now()-submittedAt<required)await pause(Math.min(500,required-(Date.now()-submittedAt)));const retryElapsed=Date.now()-submittedAt;assert.ok(retryElapsed>=required);
    assert.equal((await call(dispatchPath,lead(101))).body.success,true);assert.equal((await call(dispatchPath,lead(102))).body.code,2003);
    assert.equal((await stage(101)).stage,'submitted');assert.equal((await jobs()).length,6);assert.equal(launches.get(held.payload.automationJobId),1);assert.equal(callbackRequests.some(r=>r.lead_id===101),false);
    clearInterval(heartbeat);await heartbeatWork;await finish(held,'duplicate');await waitStage(101,'completed');assert.equal(applied.get(101),'duplicate');assert.equal(claims.has(held.payload.automationJobId),false);
    trace.push('timeout_retry_elapsed_ms:'+String(retryElapsed));
  });
  await t.test('unknown delivery cannot become a successful or frequency callback; no replay on new lead',async()=>{
    assert.equal((await call(dispatchPath,lead(205,'member_155_main','13900139005'))).body.success,true);const task=await pick();await finish(task,'unknown');await waitStage(205,'needs_attention');
    assert.equal(callbackRequests.some(r=>r.lead_id===205),false);assert.equal((await call(dispatchPath,lead(206,'member_155_main','13900139005'))).body.code,2003);assert.equal(claims.get(task.payload.automationJobId),1);
  });
  await t.test('frequency callback isolates only the exact member; its clone still accepts another customer',async()=>{
    assert.equal((await call(dispatchPath,lead(209,'member_155_main','13900139009'))).body.success,true);const task=await pick();await finish(task,'frequency');await waitStage(209,'completed');
    const result=callbackRequests.find(r=>r.lead_id===209);assert.equal(result.result,'failed');assert.equal(result.fail_reason,'添加好友过于频繁');
    const accounts=(await call(devicesPath,{})).body.result.devices.find(d=>d.device_number==='155').accounts;
    assert.equal(accounts.find(a=>a.app_slot==='main').unavailable_reason,'member_rate_limited');assert.equal(accounts.find(a=>a.app_slot==='clone').available,true);
    assert.equal((await call(dispatchPath,lead(210,'member_155_main','13900139010'))).body.code,2003);
    assert.equal((await call(dispatchPath,lead(211,'member_155_clone','13900139011'))).body.success,true);const clone=await pick();assert.equal(clone.payload.androidUser,999);await finish(clone,'duplicate');await waitStage(211,'completed');
  });
  await t.test('final accounting: one launch per job, exact callback effects and unchanged lookup',async()=>{
    assert.equal((await jobs()).length,9);assert.equal(launches.size,9);assert.ok([...launches.values()].every(n=>n===1));const raceRequest=(await stage(208)).requestId;assert.ok([...submissions].every(([id,n])=>n===(id===raceRequest?2:1)));assert.equal(callbackRequests.length,11);assert.equal(applied.size,7);assert.deepEqual(violations,[]);
    assert.deepEqual(await locksForLookup(),lookupLocksBefore);assert.deepEqual((await platformCall('GET',lookupPath,admin)).sessions.find(s=>s.sessionId===lookup.sessionId),lookupBefore);
    t.diagnostic(JSON.stringify({store:databaseUrl?'isolated_postgres':'temporary_json',physicalJobs:9,syntheticLaunches:9,syntheticSendClaims:4,callbacks:11,appliedCpsResults:7,lookupUnchanged:true,trace}));
  });
});
