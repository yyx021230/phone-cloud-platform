import { createSimulatedWecomCleanup } from "./wecom-causal-fixture.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("preview HTTP covers authentication, legacy and local phones, leases, original-id reuse and restart", { timeout: 30_000 }, async (t) => {
  const databaseUrl = process.env.WECOM_PREVIEW_TEST_DATABASE_URL || "";
  if (databaseUrl) {
    const u = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(u.hostname) && u.pathname === "/wecom_preview_fixture", "isolated fixture database required");
  }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-data-http-"));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let server;
  let output = "";
  const stop = async () => { if (server && server.exitCode === null) { server.kill(); await once(server, "exit"); } };
  t.after(async () => { await stop(); await fs.rm(storage, { recursive: true, force: true }); });
  const start = async () => {
    server = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: storage, DATABASE_URL: databaseUrl, STORAGE_BACKEND: databaseUrl ? "postgres" : "json", STRUCTURED_WRITES: "true", REDIS_URL: "", ADMIN_USERNAME: "fixture_admin",
      ADMIN_PASSWORD: "fixture-admin-only", SCREEN_MEDIA_AUTH_SECRET: "fixture-collection-secret",
      PUBLIC_BASE_URL: base, WINDOWS_AGENT_ONLINE_SECONDS: "300"
    }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { output += chunk; });
    server.stderr.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
      if (server.exitCode !== null) throw new Error(`fixture server failed: ${output.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("fixture server did not start");
  };
  let cleanupFixture;
  const request = async (method, route, token, body, expected = 200) => {
    const response = await fetch(`${base}${route}`, { method, headers: {
      "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${result.error || "unexpected status"}`);
    await cleanupFixture?.observe(method, route, body, result);
    return result;
  };
  await start();
  const admin = (await request("POST", "/api/v1/auth/login", "", { username: "fixture_admin", password: "fixture-admin-only" })).session.token;
  await request("POST", "/api/v1/users", admin, { username: "preview_user", password: "fixture-user-only", role: "user", enabled: true }, 201);
  const user = (await request("POST", "/api/v1/auth/login", "", { username: "preview_user", password: "fixture-user-only" })).session.token;
  const agent = (await request("POST", "/api/v1/windows-agents", admin, { agentId: "fixture-agent", agentName: "Fixture" }, 201)).token;
  const { WECOM_PREVIEW_DEVICES: pool } = await import("./wecom-preview.mjs");
  await request("POST", "/api/v1/windows-agents/fixture-agent/devices/sync", agent, {
    agent: { agentId: "fixture-agent" }, devices: [...Object.values(pool).map(d => ({ adbSerial: d.serial, state: "device", model: "Fixture" })), { adbSerial: "fixture-extra", state: "device", model: "OtherFixture" }]
  });
  for (const [number,row] of Object.entries(pool)) await request("PUT", `/api/v1/devices/${encodeURIComponent("adb:"+row.serial)}`, admin, { listingStatus: "listed", deviceName: number });
  await request('PUT','/api/v1/devices/adb%3Afixture-extra',admin,{listingStatus:'listed',deviceName:'67'});
  const discovery='/api/v1/wecom/devices';
  await request('GET',discovery,'',undefined,401);await request('GET',discovery,user,undefined,401);
  await request('GET',discovery+'?onlineOnly=invalid',admin,undefined,400);
  const fullInventory=await request('GET',discovery,admin);
  assert.equal(fullInventory.total,11);assert.ok(fullInventory.updatedAt);assert.deepEqual(fullInventory.capacity,{limit:2,active:0,remaining:2});
  const live59=fullInventory.devices.find(d=>d.deviceNumber==='59');assert.equal(live59.available,true);assert.equal(live59.online,true);assert.equal(live59.busy,false);
  assert.deepEqual(fullInventory.devices.find(d=>d.deviceNumber==='155').appSlots.map(s=>s.appSlot),['main','clone']);
  for (const number of ['200','202']) assert.deepEqual(fullInventory.devices.find(d=>d.deviceNumber===number).appSlots.map(s=>s.appSlot),['main']);
  const other=fullInventory.devices.find(d=>d.deviceNumber==='67');assert.equal(other.online,true);assert.equal(other.wecomAllowed,false);assert.equal(other.available,false);
  assert.equal((await request('GET',discovery+'?onlineOnly=true',admin)).total,11);
  await request('POST','/api/v1/windows-agents/fixture-agent/devices/sync',agent,{agent:{agentId:'fixture-agent'},devices:[...Object.values(pool).map(d=>({adbSerial:d.serial,state:'device',model:'Fixture'})),{adbSerial:'fixture-extra',state:'offline',model:'OtherFixture'}]});
  assert.equal((await request('GET',discovery,admin)).total,11,'default includes offline devices');
  assert.equal((await request('GET',discovery+'?onlineOnly=true',admin)).total,10,'online filter excludes the offline phone');
  const route="/api/v1/user/automation/wecom-preview-tasks";
  const next="/api/v1/windows-agents/fixture-agent/tasks/next";
  cleanupFixture=createSimulatedWecomCleanup({request,agentId:"fixture-agent",token:agent,nextRoute:next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1"});
  const input={deviceId:"adb:"+pool["25"].serial,phoneNumber:"13800138000",requestId:"request_fixture_001",remarkName:"本地客户😀",description:"渠道A\n联调备注"};
  const foreignOrigin = await fetch(base+route, {method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${admin}`,origin:"http://foreign.invalid"},body:JSON.stringify(input)});
  assert.equal(foreignOrigin.status,403,"preview keeps the platform origin guard");
  await request("POST",route,"",input,401);
  await request("POST",route,user,input,401);
  await request("POST",route,admin,{...input,send:true},400);
  await request("POST",route,admin,{...input,remarkName:"字".repeat(21)},400);
  await request("POST",route,admin,{...input,description:null},400);
  const allowed=await request("GET","/api/v1/user/automation/wecom-preview-devices",admin);
  assert.equal(allowed.devices.length,10);assert.equal(allowed.devices.find(d=>d.deviceNumber==="155").androidUser,999);
  assert.deepEqual(allowed.devices.find(d=>d.deviceNumber==="155").appSlots.map(s=>[s.appSlot,s.androidUser]),[["main",0],["clone",999]]);
  await request("POST",route,admin,{...input,appSlot:"clone"},409);
  await request("POST",route,admin,{...input,appSlot:"auto"},400);
  const [a,b]=await Promise.all([request("POST",route,admin,input,201),request("POST",route,admin,input,200)]);
  assert.equal(a.task.jobId,b.task.jobId);assert.equal(b.reused,true);
  const allocated=(await request('GET',discovery,admin)).devices.find(d=>d.deviceNumber==='25');
  assert.equal(allocated.busy,true);assert.equal(allocated.available,false);assert.equal(allocated.busyReason,'企微加客户');
  assert.equal(allocated.occupancy.type,'wecom_customer_preview');assert.equal(allocated.occupancy.taskId,undefined);
  assert.equal((await request('GET',discovery,admin)).capacity.remaining,1);

  await request("POST",route,admin,{...input,phoneNumber:"13900139000"},409);
  await request("POST",route,admin,{...input,requestId:"request_fixture_002"},409);
  assert.equal((await request("GET",next,agent)).task,null,"old Agent cannot claim a preview task");
  assert.equal((await request("GET",next+"?wecomPreview=wecom-preview-v1",agent)).task,null,"v1 cannot claim slot-aware tasks");
  assert.equal((await request("GET",next+"?wecomPreview=wecom-preview-v2",agent)).task,null,"v2 cannot consume custom remark tasks");
  assert.equal((await request("GET",next+"?wecomPreview=wecom-preview-v3",agent)).task,null,"v3 cannot consume invitation-aware tasks");
  assert.equal((await request("GET",next+"?wecomPreview=wecom-invitation-v4",agent)).task,null,"old v4 needs physical cleanup protocol capability");
  assert.equal((await request("GET",next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1",agent)).task,null,"old physical capability cannot claim causal tasks");
  const picked=(await request("GET",next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1",agent)).task;
  assert.equal(picked.type,"wecom_customer_preview");assert.equal(picked.payload.androidUser,0);assert.equal(picked.payload.previewOnly,true);
  assert.equal(picked.payload.appSlot,"main");
  assert.equal(picked.payload.remarkName,input.remarkName);assert.equal(picked.payload.description,input.description);
  await request("POST",route,admin,{...input,remarkName:"变更备注"},409);
  await request("POST",route,admin,{...input,description:"变更描述"},409);
  const lease=`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${picked.taskId}/lease`;
  const proof=await request("GET",lease,agent);assert.equal(proof.valid,true);
  const {createHash}=await import("node:crypto");assert.equal(proof.remarkFingerprint,createHash("sha256").update(JSON.stringify([input.remarkName,input.description])).digest("hex"));
  assert.equal(proof.remarkName,undefined);assert.equal(a.task.remarkName,undefined);
  await request("GET",lease,admin,undefined,401);
  await request("GET",`${route}/${a.task.jobId}`,user,undefined,401);
  const cloneInput={...input,remarkName:undefined,description:undefined,deviceId:"adb:"+pool["155"].serial,requestId:"request_clone_001"};
  const clone=(await request("POST",route,admin,cloneInput,201)).task;
  assert.equal(clone.appSlot,"clone");
  await request("POST",route,admin,{...cloneInput,appSlot:"main"},409);
  await request("POST",route,admin,{...input,deviceId:"adb:"+pool["23"].serial,requestId:"request_capacity_001"},429);
  assert.equal((await request("POST",route,admin,input,200)).task.jobId,a.task.jobId,"replay is allowed at capacity");
  const clonePicked=(await request("GET",next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1",agent)).task;
  assert.equal(clonePicked.deviceId,cloneInput.deviceId);assert.equal(clonePicked.payload.androidUser,999,"another phone can proceed while first is running");
  assert.equal(clonePicked.payload.remarkName,"测试客户");assert.equal(clonePicked.payload.description,"接口联调测试");
  const cloneLease=`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${clonePicked.taskId}/lease`;
  assert.equal((await request("GET",cloneLease,agent)).appSlot,"clone");
  await request("POST",`/api/v1/windows-agent-tasks/${picked.taskId}/status`,agent,{status:"succeeded",result:{previewStatus:"ready_before_send",previewCode:"preview_ready",invitationSent:false,remarkSaveStatus:"not_needed"}});
  assert.equal((await request("GET",lease,agent)).valid,false);
  const done=(await request("GET",`${route}/${a.task.jobId}`,admin)).task;
  const freed=(await request('GET',discovery,admin)).devices.find(d=>d.deviceNumber==='25');assert.equal(freed.available,true);assert.equal(freed.busy,false);

  assert.equal(done.status,"succeeded");assert.equal(done.result.status,"ready_before_send");assert.equal(done.result.invitationSent,false);
  assert.equal(done.result.errorInfo,undefined);
  const replay=await request("POST",route,admin,input,200);assert.equal(replay.task.jobId,done.jobId);
  await request("POST",route,admin,{...cloneInput,appSlot:"main",requestId:"request_same_phone_main"},409);
  await request("POST",`/api/v1/windows-agent-tasks/${clonePicked.taskId}/status`,agent,{status:"failed",result:{previewStatus:"blocked",previewCode:"remark_persistence_unconfirmed",remarkSaveStatus:"unknown"}});
  const stopped=(await request("GET",`${route}/${clone.jobId}`,admin)).task;
  assert.equal(stopped.result.remarkSaveStatus,"unknown");assert.equal(stopped.result.code,"remark_persistence_unconfirmed");
  assert.equal(stopped.result.errorInfo.category,'result_unconfirmed');assert.equal(stopped.result.errorInfo.outcomeUnconfirmed,true);
  const locks=(await request("GET","/api/v1/device-locks",admin)).locks;
  assert.equal(locks.filter(l=>l.status==="active"&&l.lockType==="wecom_customer_preview").length,0);
  const mainInput={...cloneInput,appSlot:"main",requestId:"request_same_phone_main"};
  const main=(await request("POST",route,admin,mainInput,201)).task;
  assert.equal(main.appSlot,"main");assert.equal(main.androidUser,0);
  const mainPicked=(await request("GET",next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1",agent)).task;
  assert.equal(mainPicked.payload.appSlot,"main");assert.equal(mainPicked.payload.androidUser,0);
  await request("POST",`/api/v1/windows-agent-tasks/${mainPicked.taskId}/status`,agent,{status:"succeeded",result:{previewStatus:"ready_before_send",previewCode:"stopped_before_send",invitationSent:false,remarkSaveStatus:"not_needed"}});
  await stop();await start();
  const restored=(await request("GET",`${route}/${done.jobId}`,admin)).task;
  assert.equal(restored.result.status,"ready_before_send");
  assert.equal((await request("POST",route,admin,input,200)).task.jobId,done.jobId);
  assert.equal((await request("POST",route,admin,mainInput,200)).task.jobId,main.jobId);
  await request("POST",route,admin,{...mainInput,appSlot:"clone"},409);
  assert.equal((await request("GET",next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1",agent)).task,null,"no duplicate physical query after restart");
  const sendInput={...input,appSlot:"main",mode:"send",remarkName:"yyx（坦克）",requestId:"fixture_send_main_001"};
  const sendJob=(await request("POST",route,admin,sendInput,201)).task;
  assert.equal(sendJob.mode,"send");
  await request("POST",route,admin,{...sendInput,mode:"preview"},409);
  const sentTask=(await request("GET",next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1",agent)).task;
  assert.equal(sentTask.payload.previewOnly,false);assert.equal(sentTask.payload.mode,"send");
  const sendLease=`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${sentTask.taskId}/lease`;
  const sendClaim=sendLease.replace(/lease$/,"send-claim");
  assert.equal((await request("GET",sendLease,agent)).mode,"send");
  await request("POST",sendClaim,admin,{},401);
  await request("POST",sendClaim,agent,{send:true},400);
  const claim=(await request("POST",sendClaim,agent,{},201));
  assert.equal(claim.claimed,true);
  assert.equal(claim.operationFingerprint,(await request("GET",sendLease,agent)).operationFingerprint);
  await request("POST",sendClaim,agent,{},409);
  await request("POST",`/api/v1/windows-agent-tasks/${sentTask.taskId}/status`,agent,{status:"succeeded",result:{previewStatus:"send_attempted",previewCode:"invitation_click_issued_delivery_unknown",sendStatus:"unknown",invitationSent:null,remarkSaveStatus:"confirmed"}});
  const sent=(await request("GET",`${route}/${sendJob.jobId}`,admin)).task;
  assert.equal(sent.result.invitationSent,null);assert.equal(sent.result.sendStatus,"unknown");assert.equal(sent.result.sendClaimed,true);
  await request("POST",route,admin,{...sendInput,requestId:"fixture_send_new_key_002"},409);
  assert.equal((await request("POST",route,admin,sendInput,200)).task.jobId,sendJob.jobId);
  // The same target on a different configured account is independent. A clone
  // cannot be substituted for a main-app task, even with the same request ID.
  const cloneSend={...sendInput,deviceId:cloneInput.deviceId,appSlot:"clone",requestId:"fixture_send_clone_003"};
  const cloneSendJob=(await request("POST",route,admin,cloneSend,201)).task;
  await request("POST",route,admin,{...cloneSend,appSlot:"main"},409);
  const cloneSendTask=(await request("GET",next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1",agent)).task;
  assert.equal(cloneSendTask.payload.androidUser,999);
  const cloneClaim=`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${cloneSendTask.taskId}/send-claim`;
  await request("POST",cloneClaim,agent,{},201);
  // The synthetic child reports a terminal unknown outcome and closes before
  // this restart. Pending-runtime epoch loss is covered separately by the
  // actual JSON causal cleanup HTTP cases; never invent its missing close.
  await request("POST",`/api/v1/windows-agent-tasks/${cloneSendTask.taskId}/status`,agent,{status:"failed",result:{previewStatus:"blocked",previewCode:"invitation_outcome_unknown_no_retry",sendStatus:"unknown",invitationSent:null}});
  await stop();await start();
  const held=(await request("GET",`${route}/${cloneSendJob.jobId}`,admin)).task;
  assert.equal(held.result.sendStatus,"unknown");assert.equal(held.result.invitationSent,null);
  await request("POST",cloneClaim,agent,{},409);
  await request("POST",route,admin,{...sendInput,requestId:"fixture_send_after_restart"},409);
  await request("POST",sendClaim,agent,{},409);

  const localUnknown={...sendInput,deviceId:"adb:"+pool["23"].serial,requestId:"fixture_local_claim_unknown"};
  const localJob=(await request("POST",route,admin,localUnknown,201)).task;
  const localTask=(await request("GET",next+"?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1",agent)).task;
  await request("POST",`/api/v1/windows-agent-tasks/${localTask.taskId}/status`,agent,{status:"failed",result:{previewStatus:"blocked",previewCode:"invitation_claim_unconfirmed_no_retry",sendStatus:"unknown",invitationSent:null}});
  const localDone=(await request("GET",`${route}/${localJob.jobId}`,admin)).task;
  assert.equal(localDone.result.sendClaimed,false);assert.equal(localDone.result.sendStatus,"unknown");assert.equal(localDone.result.invitationSent,null);
  await request("POST",route,admin,{...localUnknown,requestId:"fixture_local_new_request"},409);

  // Four-field third-system contract: implicit single-main mapping, no ADB IDs,
  // caller request ID or execution-mode argument; duplicate POST is one task.
  const integration='/api/v1/wecom/customer-invitations';
  const simple={deviceNumber:'59',appSlot:'main',phoneNumber:'13800138000',remarkName:'对接客户'};
  await request('POST',integration,'',simple,401);
  await request('POST',integration,user,simple,401);
  await request('POST',integration,admin,{...simple,mode:'preview'},400);
  await request('POST',integration,admin,{...simple,deviceNumber:'155',appSlot:undefined},400);
  const accepted=await request('POST',integration,admin,simple,202);
  assert.ok(accepted.taskId);assert.equal(accepted.status,'queued');assert.equal(accepted.deviceId,undefined);assert.equal(accepted.requestId,undefined);
  const duplicate=await request('POST',integration,admin,simple,200);
  assert.equal(duplicate.taskId,accepted.taskId);assert.equal(duplicate.reused,true);
  await request('POST',integration,admin,{...simple,remarkName:'不可改写原任务'},409);
  const simpleTask=(await request('GET',next+'?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1',agent)).task;
  assert.equal(simpleTask.payload.mode,'send');assert.equal(simpleTask.payload.remarkName,simple.remarkName);
  assert.equal(simpleTask.adbSerial,pool['59'].serial);
  const simpleClaim=`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${simpleTask.taskId}/send-claim`;
  await request('POST',simpleClaim,agent,{},201);
  await request('POST',`/api/v1/windows-agent-tasks/${simpleTask.taskId}/status`,agent,{status:'succeeded',result:{previewStatus:'send_attempted',previewCode:'invitation_click_issued_delivery_unknown',sendStatus:'unknown',invitationSent:null,remarkSaveStatus:'confirmed'}});
  const externalResult=await request('GET',`${integration}/${accepted.taskId}`,admin);
  assert.equal(externalResult.status,'unknown');assert.equal(externalResult.taskId,accepted.taskId);
  assert.equal(externalResult.errorInfo.category,'result_unconfirmed');assert.equal(externalResult.errorInfo.outcomeUnconfirmed,true);
  await request('GET',`${integration}/${accepted.taskId}`,user,undefined,401);
  assert.equal((await request('POST',integration,admin,simple,200)).taskId,accepted.taskId);
  await stop();await start();
  assert.equal((await request('POST',integration,admin,simple,200)).taskId,accepted.taskId,'lost task ID recovers same request after restart without another invitation');
  assert.equal((await request('GET',`${integration}/${accepted.taskId}`,admin)).status,'unknown');

  await request('GET',`${integration}/${a.task.jobId}`,admin,undefined,404);
  const concurrent={...simple,deviceNumber:145};
  const concurrentResponses=await Promise.all(Array.from({length:3},async()=>{
    const response=await fetch(base+integration,{method:'POST',headers:{authorization:`Bearer ${admin}`,'content-type':'application/json'},body:JSON.stringify(concurrent)});
    return {status:response.status,body:await response.json()};
  }));
  assert.deepEqual(concurrentResponses.map(r=>r.status).sort(),[200,200,202]);
  assert.equal(new Set(concurrentResponses.map(r=>r.body.taskId)).size,1,'simultaneous body-only retries create one durable task');

  const pending145=(await request('GET',next+'?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1',agent)).task;
  const rpcExecution={version:1,phase:'cleanup',failurePhase:'recipient_search',elapsedMs:25000,cleanupConfirmed:true,events:[],transportFailure:{reason:'read_timeout',errorType:'ReadTimeout',elapsedMs:23000}};
  await request('POST',`/api/v1/windows-agent-tasks/${pending145.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'wecom_rpc_delivery_unknown_no_replay',invitationSent:false,remarkSaveStatus:'not_attempted',diagnostic:{wecomExecution:rpcExecution}}});
  const rpcResult=await request('GET',`${integration}/${concurrentResponses[0].body.taskId}`,admin);
  assert.equal(rpcResult.status,'failed');assert.equal(rpcResult.errorInfo.category,'transport');assert.equal(rpcResult.errorInfo.phase,'recipient_search');
  assert.equal(rpcResult.execution.transportFailure.reason,'read_timeout');assert.match(rpcResult.message,/等待响应超时/);
  await request('POST',`/api/v1/windows-agent-tasks/${cloneSendTask.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'invitation_outcome_unknown_no_retry',sendStatus:'unknown',invitationSent:null}});
  const explicitClone={...simple,deviceNumber:155,appSlot:'clone',phoneNumber:'13900139000'};
  const cloneExternal=(await request('POST',integration,admin,explicitClone,202));
  const cloneDelivery=(await request('GET',next+'?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1',agent)).task;
  assert.equal(cloneDelivery.payload.appSlot,'clone');assert.equal(cloneDelivery.payload.androidUser,999);
  assert.equal(cloneDelivery.payload.phoneNumber,explicitClone.phoneNumber);
  await request('POST',`/api/v1/windows-agent-tasks/${cloneDelivery.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'not_found',invitationSent:false,remarkSaveStatus:'not_attempted'}});
  const safeRetry=await request('POST',integration,admin,explicitClone,202);
  assert.notEqual(safeRetry.taskId,cloneExternal.taskId,'explicit pre-write failure can be retried without bypassing any send claim');

  // CPS jobs are gated on an explicit new Agent capability; old v4 workers
  // cannot silently execute a request while ignoring its telephone-field proof.
  const retryPicked=(await request('GET',next+'?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1',agent)).task;
  await request('POST',`/api/v1/windows-agent-tasks/${retryPicked.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'not_found',invitationSent:false,remarkSaveStatus:'not_attempted'}});
  const cpsInput={deviceId:'adb:'+pool['43'].serial,phoneNumber:'13800138000',requestId:'fixture_cps_phone_001',mode:'preview',requireRemarkPhone:true};
  const cpsJob=(await request('POST',route,admin,cpsInput,201)).task;
  await request('POST',route,admin,{...cpsInput,requireRemarkPhone:false},409);
  assert.equal((await request('GET',next+'?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1',agent)).task,null);
  const cpsPoll=next+'?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1&wecomRemarkPhone=verified-v1';
  const cpsPicked=(await request('GET',cpsPoll,agent)).task;assert.equal(cpsPicked.payload.requireRemarkPhone,true);
  await request('POST',`/api/v1/windows-agent-tasks/${cpsPicked.taskId}/status`,agent,{status:'succeeded',result:{previewStatus:'ready_before_send',previewCode:'stopped_before_send',invitationSent:false,remarkPhoneSet:true,remarkSaveStatus:'confirmed'}});
  assert.equal((await request('GET',`${route}/${cpsJob.jobId}`,admin)).task.result.remarkPhoneSet,true);

  // All three CPS interactions over actual loopback HTTP, backed by this real
  // platform fixture and simulated Agent. No phone or external callback.
  const http=await import('node:http');
  const {createStore}=await import('./cps-wecom/store.mjs');
  const {createPlatform}=await import('./cps-wecom/platform.mjs');
  const {createService}=await import('./cps-wecom/service.mjs');
  const {parseClients,signature,stringifyBody,parseBody,ROUTES}=await import('./cps-wecom/protocol.mjs');
  const {createHttpServer,listen}=await import('./cps-wecom/http.mjs');
  const callbackRows=[];const cpsSecret='fixture-cps-contract-secret',singleSecret='fixture-main-document-only';let singleCallbackFailures=1;
  const cpsReceiver=http.createServer(async(req,res)=>{assert.equal(req.method,'POST');assert.equal(req.url,'/api/v1/lead/callback');let raw='';for await(const chunk of req)raw+=chunk;const data=parseBody(raw);assert.equal(signature(data,data.app_id==='fixture_single_main'?singleSecret:cpsSecret),data.sign);callbackRows.push(data);const failed=data.app_id==='fixture_single_main'&&(singleCallbackFailures-- > 0);res.statusCode=failed?500:200;res.setHeader('content-type','application/json');res.end(JSON.stringify({success:!failed,code:failed?500:200}));});
  await listen(cpsReceiver);t.after(()=>{cpsReceiver.closeAllConnections();return new Promise(r=>cpsReceiver.close(r));});
  const singleMembers=[{deviceNumber:'200',appSlot:'main',bindingVerified:true,wecom_phone:'13900139200'},{deviceNumber:'202',appSlot:'main',bindingVerified:true,wecom_phone:'13900139202'}];
  const clients=parseClients(JSON.stringify([{appId:'fixture_cps',secret:cpsSecret,callbackUrl:'http://127.0.0.1:'+cpsReceiver.address().port+'/api/v1/lead/callback',allowLoopbackTest:true,allDeviceStatus:true,members:[{deviceNumber:'43',appSlot:'main',bindingVerified:true,wecom_corp_id:'ww_fixture',wecom_userid:'member_main'},{deviceNumber:'59',appSlot:'main',bindingVerified:true,wecom_corp_id:'ww_fixture',wecom_userid:'busy_member'},{deviceNumber:'155',appSlot:'clone',bindingVerified:true,wecom_corp_id:'ww_fixture',wecom_userid:'idle_clone'}]},
    {appId:'fixture_single_main',secret:singleSecret,callbackUrl:'http://127.0.0.1:'+cpsReceiver.address().port+'/api/v1/lead/callback',allowLoopbackTest:true,allDeviceStatus:true,members:singleMembers}]));
  const cpsDir=await fs.mkdtemp(path.join(os.tmpdir(),'cps-real-http-'));
  const cpsStore=await createStore({file:path.join(cpsDir,'journal.json')});let cpsNow=Date.now();
  const cpsService=createService({store:cpsStore,clients,platform:createPlatform({baseUrl:base,token:admin,mode:'send'}),clock:()=>cpsNow});
  const cpsServer=createHttpServer(cpsService);await listen(cpsServer);
  t.after(async()=>{cpsServer.closeAllConnections();await new Promise(r=>cpsServer.close(r));await cpsService.close();await fs.rm(cpsDir,{recursive:true,force:true});});
  const cpsCall=async(endpoint,input)=>{const body={...input,app_id:'fixture_cps',timestamp:Date.now(),nonce:(await import('node:crypto')).randomBytes(16).toString('hex')};body.sign=signature(body,cpsSecret);const r=await fetch('http://127.0.0.1:'+cpsServer.address().port+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:stringifyBody(body)});assert.equal(r.status,200);return r.json();};
  assert.equal((await request('GET',cpsPoll,agent)).task,null);
  const cpsDevices=await cpsCall(ROUTES.devices,{});assert.equal(cpsDevices.result.total,11);assert.equal(cpsDevices.result.devices.find(d=>d.device_number==='43').accounts[0].wecom_userid,'member_main');
  const lead={lead_id:9223372036854775807n,phone:'13800138000',wecom_corp_id:'ww_fixture',wecom_userid:'member_main'};
  assert.equal((await cpsCall(ROUTES.dispatch,{...lead,lead_id:9223372036854775808n})).code,2003);assert.equal(cpsStore.snapshot().leads.length,0);
  assert.equal((await cpsCall(ROUTES.dispatch,lead)).success,true);assert.equal((await cpsCall(ROUTES.dispatch,lead)).success,true);
  await cpsService.tick();const leadTask=(await request('GET',cpsPoll,agent)).task;assert.equal(leadTask.payload.requireRemarkPhone,true);assert.equal(leadTask.payload.remarkName,'9223372036854775807');assert.equal(leadTask.payload.description,'leadId:9223372036854775807');assert.equal(leadTask.payload.phoneNumber,lead.phone);assert.equal(leadTask.payload.mode,'send');
  await request('POST',`/api/v1/windows-agent-tasks/${leadTask.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'already_contact',invitationSent:false,sendStatus:'not_attempted',remarkSaveStatus:'not_attempted'}});
  cpsNow+=2001;await cpsService.tick();await cpsService.tick();assert.equal(callbackRows.length,1);assert.equal(callbackRows[0].lead_id,9223372036854775807n);assert.equal(callbackRows[0].result,'duplicate');assert.equal(cpsStore.snapshot().leads[0].stage,'completed');
  // A native application acknowledgement is distinct from recipient delivery.
  await request('GET',cpsPoll,agent);
  const sentLead={...lead,lead_id:2n,phone:'13900139001'};assert.equal((await cpsCall(ROUTES.dispatch,sentLead)).success,true);
  await cpsService.tick();const confirmedTask=(await request('GET',cpsPoll,agent)).task;
  await request('POST',`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${confirmedTask.taskId}/send-claim`,agent,{},201);
  await request('POST',`/api/v1/windows-agent-tasks/${confirmedTask.taskId}/status`,agent,{status:'succeeded',result:{previewStatus:'send_attempted',previewCode:'invitation_click_issued_delivery_unknown',invitationSent:null,sendStatus:'unknown',remarkSaveStatus:'confirmed',remarkPhoneSet:true,invitationRequestConfirmed:true,invitationRequestProof:'wecom_system_dialog_v1'}});
  cpsNow+=2001;await cpsService.tick();await cpsService.tick();assert.equal(callbackRows[1].result,'success');assert.equal(callbackRows[1].remark_phone_set,true);
  const originalConfirmed=(await request('GET',`${route}/${cpsStore.snapshot().leads[1].jobId}`,admin)).task;
  assert.equal(originalConfirmed.result.sendStatus,'unknown');assert.equal(originalConfirmed.result.invitationSent,null);
  // A real fixed-vocabulary native frequency proof maps only this member's failure.
  await request('GET',cpsPoll,agent);assert.equal((await cpsCall(ROUTES.dispatch,{...lead,lead_id:3n,phone:'13900139002'})).success,true);
  await cpsService.tick();const limited=(await request('GET',cpsPoll,agent)).task;
  await request('POST',`/api/v1/windows-agent-tasks/${limited.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'wecom_add_friend_too_frequent',invitationSent:false,sendStatus:'not_attempted',addFriendLimitConfirmed:true,addFriendLimitProof:'wecom_system_dialog_v1'}});
  cpsNow+=2001;await cpsService.tick();await cpsService.tick();assert.equal(callbackRows[2].result,'failed');assert.equal(callbackRows[2].fail_reason,'添加好友过于频繁');
  // CPS discovery/admission must preserve an existing real lookup session and
  // its physical lock, while a different idle phone can still accept CPS work.
  await request('GET',cpsPoll,agent); // Refresh the upgraded Agent after the legacy cleanup fixture's poll.
  const lookupPath='/api/v1/user/automation/alipay-name-sessions';
  const lookup=await request('POST',lookupPath,admin,{deviceId:'adb:'+pool['59'].serial},201);
  const locksBefore=(await request('GET','/api/v1/device-locks',admin)).locks.filter(l=>l.deviceId==='adb:'+pool['59'].serial&&l.status==='active');
  assert.equal(locksBefore.length,1);assert.equal(locksBefore[0].lockType,'alipay_name_lookup');
  await request('GET','/api/v1/user/automation/wecom-cps-devices',user,undefined,401);
  const busyList=await cpsCall(ROUTES.devices,{});const occupied=busyList.result.devices.find(d=>d.device_number==='59');
  assert.equal(occupied.busy,true);assert.equal(occupied.available,false);assert.equal(occupied.accounts[0].unavailable_reason,'device_busy');
  assert.equal((await cpsCall(ROUTES.dispatch,{...lead,lead_id:4n,wecom_userid:'busy_member'})).code,2003);
  const idleReply=await cpsCall(ROUTES.dispatch,{...lead,lead_id:5n,phone:'13900139005',wecom_userid:'idle_clone'});assert.equal(idleReply.success,true,JSON.stringify(idleReply));
  await cpsService.tick();assert.equal(cpsStore.snapshot().leads.find(l=>l.leadId==='5').stage,'submitted');
  const locksAfter=(await request('GET','/api/v1/device-locks',admin)).locks.filter(l=>l.deviceId==='adb:'+pool['59'].serial&&l.status==='active');
  assert.deepEqual(locksAfter,locksBefore);
  const preserved=(await request('GET',lookupPath,admin)).sessions.find(s=>s.sessionId===lookup.session.sessionId);
  assert.equal(preserved.status,'starting');assert.equal(preserved.pendingJobId,lookup.session.pendingJobId);

  {
  // New document contract: independent CPS caller, one account per phone,
  // actual bridge/platform HTTP. Agent results and callbacks are synthetic;
  // no native phone or invitation is involved in this fixture.
  const oldIdle=(await request('GET',cpsPoll,agent)).task;
  assert.equal(oldIdle.payload.deviceNumber,'155');
  await request('POST',`/api/v1/windows-agent-tasks/${oldIdle.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'already_contact',invitationSent:false,sendStatus:'not_attempted',remarkSaveStatus:'not_attempted'}});
  cpsNow+=2001;await cpsService.tick();await cpsService.tick();
  await request('GET',cpsPoll,agent);
  const {createHash,randomBytes}=await import('node:crypto');
  // Reimplement only the public document's signing steps, not server.signature.
  const callerSign=body=>createHash('sha256').update(Object.keys(body).filter(k=>k!=='sign'&&body[k]!==null&&body[k]!=='').sort().map(k=>k+'='+String(body[k])).join('&')+'&secret='+singleSecret,'utf8').digest('hex');
  const exchange=[],docPaths={devices:'/api/v1/lead/devices/query',dispatch:'/api/v1/lead/dispatch'};
  const documentCall=async(endpoint,input)=>{
    const body={...input,app_id:'fixture_single_main',timestamp:Date.now(),nonce:randomBytes(16).toString('hex')};body.sign=callerSign(body);
    const response=await fetch('http://127.0.0.1:'+cpsServer.address().port+endpoint,{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify(body)});
    const result=await response.json();assert.equal(response.status,200);exchange.push({endpoint,code:result.code,success:result.success});return result;
  };
  const all=(await documentCall(docPaths.devices,{online_only:false})).result;
  assert.equal(all.total,11);
  for(const m of singleMembers){const d=all.devices.find(d=>d.device_number===m.deviceNumber);assert.equal(d.available,true);assert.deepEqual(d.accounts.map(a=>[a.wecom_phone,a.app_slot]),[[m.wecom_phone,'main']]);}
  assert.ok(all.devices.filter(d=>!['200','202'].includes(d.device_number)).every(d=>d.accounts.length===0),'other app account mappings remain private');
  const mainLead=(id,number,phone='13800138000')=>({lead_id:id,phone,wecom_phone:singleMembers.find(m=>m.deviceNumber===number).wecom_phone,wecom_corp_id:'ww_document_fixture',wecom_userid:'member_'+number});
  const a=mainLead(1000200,'200'),b=mainLead(1000202,'202');
  const accepted=await Promise.all([documentCall(docPaths.dispatch,a),documentCall(docPaths.dispatch,a),documentCall(docPaths.dispatch,b)]);assert.ok(accepted.every(r=>r.success));
  await cpsService.tick();
  const ownLeads=()=>cpsStore.snapshot().leads.filter(l=>l.appId==='fixture_single_main');assert.equal(ownLeads().length,2);
  const busy=(await documentCall(docPaths.devices,{})).result.devices.filter(d=>['200','202'].includes(d.device_number));assert.ok(busy.every(d=>d.busy&&!d.available));
  assert.equal((await documentCall(docPaths.dispatch,mainLead(1000299,'200','13800138099'))).code,2003);
  const picked=[];for(let i=0;i<2;i++){const task=(await request('GET',cpsPoll,agent)).task;assert.equal(task.type,'wecom_customer_preview');assert.equal(task.payload.androidUser,0);assert.equal(task.payload.appSlot,'main');assert.equal(task.payload.requireRemarkPhone,true);picked.push(task);}
  assert.deepEqual(picked.map(t=>t.payload.deviceNumber).sort(),['200','202']);
  const task200=picked.find(t=>t.payload.deviceNumber==='200'),task202=picked.find(t=>t.payload.deviceNumber==='202');
  assert.equal(task200.payload.remarkName,'1000200');assert.equal(task200.payload.description,'leadId:1000200');assert.equal(task200.payload.phoneNumber,a.phone);
  await request('POST',`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${task200.taskId}/send-claim`,agent,{},201);
  await request('POST',`/api/v1/windows-agent-tasks/${task200.taskId}/status`,agent,{status:'succeeded',result:{previewStatus:'send_attempted',previewCode:'invitation_click_issued_delivery_unknown',invitationSent:null,sendStatus:'unknown',remarkSaveStatus:'confirmed',remarkPhoneSet:true,invitationRequestConfirmed:true,invitationRequestProof:'wecom_system_dialog_v1'}});
  await request('POST',`/api/v1/windows-agent-tasks/${task202.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'already_contact',invitationSent:false,sendStatus:'not_attempted',remarkSaveStatus:'not_attempted'}});
  cpsNow+=2001;await cpsService.tick();await cpsService.tick();
  const ownCallbacks=()=>callbackRows.filter(r=>r.app_id==='fixture_single_main');assert.equal(ownCallbacks().length,2);
  assert.equal(ownLeads().find(l=>l.leadId==='1000200').stage,'callback_pending');
  cpsNow+=5000;await cpsService.tick();assert.equal(ownCallbacks().length,3);assert.ok(ownLeads().every(l=>l.stage==='completed'));
  const retryCallbacks=ownCallbacks().filter(r=>String(r.lead_id)==='1000200');assert.equal(retryCallbacks.length,2);assert.notEqual(retryCallbacks[0].nonce,retryCallbacks[1].nonce);
  for(const callback of ownCallbacks())assert.equal(callerSign(callback),callback.sign);
  assert.equal(retryCallbacks[1].result,'success');assert.equal(retryCallbacks[1].remark_phone_set,true);assert.equal(ownCallbacks().find(r=>String(r.lead_id)==='1000202').result,'duplicate');
  const originalJobs=ownLeads().map(l=>l.jobId);assert.equal((await documentCall(docPaths.dispatch,a)).success,true);await cpsService.tick();assert.deepEqual(ownLeads().map(l=>l.jobId),originalJobs);
  await request('GET',cpsPoll,agent); // Restore the full capability after the legacy verification fixture's narrower poll.
  const after=(await documentCall(docPaths.devices,{})).result.devices;assert.ok(after.filter(d=>['200','202'].includes(d.device_number)).every(d=>d.available&&!d.busy),JSON.stringify(after.filter(d=>['200','202'].includes(d.device_number)).map(d=>({number:d.device_number,available:d.available,busy:d.busy,reason:d.unavailable_reason}))));
  const attentionLead=mainLead(1000300,'200','13800138300');assert.equal((await documentCall(docPaths.dispatch,attentionLead)).success,true);await cpsService.tick();
  const interrupted=(await request('GET',cpsPoll,agent)).task;assert.equal(interrupted.payload.deviceNumber,'200');
  await request('POST',`/api/v1/windows-agent-tasks/${interrupted.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'ambiguous_or_missing_element',invitationSent:false,sendStatus:'not_attempted',remarkSaveStatus:'not_attempted'}});
  cpsNow+=2001;await cpsService.tick();await cpsService.tick();
  const attention=ownLeads().find(l=>l.leadId==='1000300');assert.equal(attention.stage,'needs_attention');assert.equal(attention.error,'ambiguous_or_missing_element');assert.equal(ownCallbacks().length,3,'ordinary failure is never disguised as success or frequency');
  assert.equal((await documentCall(docPaths.dispatch,attentionLead)).success,true);await cpsService.tick();assert.equal(ownLeads().length,3);assert.equal(ownLeads().find(l=>l.leadId==='1000300').jobId,attention.jobId);
  await request('GET',cpsPoll,agent);const recovered=(await documentCall(docPaths.devices,{})).result.devices.find(d=>d.device_number==='200');assert.equal(recovered.busy,false);assert.equal(recovered.available,true);
  assert.deepEqual((await request('GET','/api/v1/device-locks',admin)).locks.filter(l=>l.deviceId==='adb:'+pool['59'].serial&&l.status==='active'),locksBefore);
  t.diagnostic(JSON.stringify({contract:'CPS-v0.4-single-account',exchanges:exchange,executionAccounts:2,physicalTasks:3,mainAndroidUser:0,duplicateDispatchReused:true,callbackAttempts:3,callback500RetriedOnlyNotification:true,ordinaryFailurePreserved:true,phoneReleasedAfterFailure:true,lookupLockPreserved:true,syntheticAgent:true,realInvitations:0}));
  }
});
