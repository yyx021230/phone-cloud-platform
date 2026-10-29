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

test("preview HTTP covers authentication, eight phones, leases, original-id reuse and restart", { timeout: 30_000 }, async (t) => {
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
  const request = async (method, route, token, body, expected = 200) => {
    const response = await fetch(`${base}${route}`, { method, headers: {
      "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${result.error || "unexpected status"}`);
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
  assert.equal(fullInventory.total,9);assert.ok(fullInventory.updatedAt);assert.deepEqual(fullInventory.capacity,{limit:2,active:0,remaining:2});
  const live59=fullInventory.devices.find(d=>d.deviceNumber==='59');assert.equal(live59.available,true);assert.equal(live59.online,true);assert.equal(live59.busy,false);
  assert.deepEqual(fullInventory.devices.find(d=>d.deviceNumber==='155').appSlots.map(s=>s.appSlot),['main','clone']);
  const other=fullInventory.devices.find(d=>d.deviceNumber==='67');assert.equal(other.online,true);assert.equal(other.wecomAllowed,false);assert.equal(other.available,false);
  assert.equal((await request('GET',discovery+'?onlineOnly=true',admin)).total,9);
  await request('POST','/api/v1/windows-agents/fixture-agent/devices/sync',agent,{agent:{agentId:'fixture-agent'},devices:[...Object.values(pool).map(d=>({adbSerial:d.serial,state:'device',model:'Fixture'})),{adbSerial:'fixture-extra',state:'offline',model:'OtherFixture'}]});
  assert.equal((await request('GET',discovery,admin)).total,9,'default includes offline devices');
  assert.equal((await request('GET',discovery+'?onlineOnly=true',admin)).total,8,'online filter excludes the offline phone');
  const route="/api/v1/user/automation/wecom-preview-tasks";
  const next="/api/v1/windows-agents/fixture-agent/tasks/next";
  const input={deviceId:"adb:"+pool["25"].serial,phoneNumber:"13800138000",requestId:"request_fixture_001",remarkName:"本地客户😀",description:"渠道A\n联调备注"};
  const foreignOrigin = await fetch(base+route, {method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${admin}`,origin:"http://foreign.invalid"},body:JSON.stringify(input)});
  assert.equal(foreignOrigin.status,403,"preview keeps the platform origin guard");
  await request("POST",route,"",input,401);
  await request("POST",route,user,input,401);
  await request("POST",route,admin,{...input,send:true},400);
  await request("POST",route,admin,{...input,remarkName:"字".repeat(21)},400);
  await request("POST",route,admin,{...input,description:null},400);
  const allowed=await request("GET","/api/v1/user/automation/wecom-preview-devices",admin);
  assert.equal(allowed.devices.length,8);assert.equal(allowed.devices.find(d=>d.deviceNumber==="155").androidUser,999);
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
  const picked=(await request("GET",next+"?wecomPreview=wecom-invitation-v4",agent)).task;
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
  const clonePicked=(await request("GET",next+"?wecomPreview=wecom-invitation-v4",agent)).task;
  assert.equal(clonePicked.deviceId,cloneInput.deviceId);assert.equal(clonePicked.payload.androidUser,999,"another phone can proceed while first is running");
  assert.equal(clonePicked.payload.remarkName,"测试客户");assert.equal(clonePicked.payload.description,"接口联调测试");
  const cloneLease=`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${clonePicked.taskId}/lease`;
  assert.equal((await request("GET",cloneLease,agent)).appSlot,"clone");
  await request("POST",`/api/v1/windows-agent-tasks/${picked.taskId}/status`,agent,{status:"succeeded",result:{previewStatus:"ready_before_send",previewCode:"preview_ready",invitationSent:false,remarkSaveStatus:"not_needed"}});
  assert.equal((await request("GET",lease,agent)).valid,false);
  const done=(await request("GET",`${route}/${a.task.jobId}`,admin)).task;
  const freed=(await request('GET',discovery,admin)).devices.find(d=>d.deviceNumber==='25');assert.equal(freed.available,true);assert.equal(freed.busy,false);

  assert.equal(done.status,"succeeded");assert.equal(done.result.status,"ready_before_send");assert.equal(done.result.invitationSent,false);
  const replay=await request("POST",route,admin,input,200);assert.equal(replay.task.jobId,done.jobId);
  await request("POST",route,admin,{...cloneInput,appSlot:"main",requestId:"request_same_phone_main"},409);
  await request("POST",`/api/v1/windows-agent-tasks/${clonePicked.taskId}/status`,agent,{status:"failed",result:{previewStatus:"blocked",previewCode:"remark_persistence_unconfirmed",remarkSaveStatus:"unknown"}});
  const stopped=(await request("GET",`${route}/${clone.jobId}`,admin)).task;
  assert.equal(stopped.result.remarkSaveStatus,"unknown");assert.equal(stopped.result.code,"remark_persistence_unconfirmed");
  const locks=(await request("GET","/api/v1/device-locks",admin)).locks;
  assert.equal(locks.filter(l=>l.status==="active"&&l.lockType==="wecom_customer_preview").length,0);
  const mainInput={...cloneInput,appSlot:"main",requestId:"request_same_phone_main"};
  const main=(await request("POST",route,admin,mainInput,201)).task;
  assert.equal(main.appSlot,"main");assert.equal(main.androidUser,0);
  const mainPicked=(await request("GET",next+"?wecomPreview=wecom-invitation-v4",agent)).task;
  assert.equal(mainPicked.payload.appSlot,"main");assert.equal(mainPicked.payload.androidUser,0);
  await request("POST",`/api/v1/windows-agent-tasks/${mainPicked.taskId}/status`,agent,{status:"succeeded",result:{previewStatus:"ready_before_send",previewCode:"stopped_before_send",invitationSent:false,remarkSaveStatus:"not_needed"}});
  await stop();await start();
  const restored=(await request("GET",`${route}/${done.jobId}`,admin)).task;
  assert.equal(restored.result.status,"ready_before_send");
  assert.equal((await request("POST",route,admin,input,200)).task.jobId,done.jobId);
  assert.equal((await request("POST",route,admin,mainInput,200)).task.jobId,main.jobId);
  await request("POST",route,admin,{...mainInput,appSlot:"clone"},409);
  assert.equal((await request("GET",next+"?wecomPreview=wecom-invitation-v4",agent)).task,null,"no duplicate physical query after restart");
  const sendInput={...input,appSlot:"main",mode:"send",remarkName:"yyx（坦克）",requestId:"fixture_send_main_001"};
  const sendJob=(await request("POST",route,admin,sendInput,201)).task;
  assert.equal(sendJob.mode,"send");
  await request("POST",route,admin,{...sendInput,mode:"preview"},409);
  const sentTask=(await request("GET",next+"?wecomPreview=wecom-invitation-v4",agent)).task;
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
  const cloneSendTask=(await request("GET",next+"?wecomPreview=wecom-invitation-v4",agent)).task;
  assert.equal(cloneSendTask.payload.androidUser,999);
  const cloneClaim=`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${cloneSendTask.taskId}/send-claim`;
  await request("POST",cloneClaim,agent,{},201);
  // Simulate losing the first claim response and restarting both sides: do not
  // grant a second send even though no terminal result ever arrived.
  await stop();await start();
  const held=(await request("GET",`${route}/${cloneSendJob.jobId}`,admin)).task;
  assert.equal(held.result.sendStatus,"unknown");assert.equal(held.result.invitationSent,null);
  await request("POST",cloneClaim,agent,{},409);
  await request("POST",route,admin,{...sendInput,requestId:"fixture_send_after_restart"},409);
  await request("POST",sendClaim,agent,{},409);

  const localUnknown={...sendInput,deviceId:"adb:"+pool["23"].serial,requestId:"fixture_local_claim_unknown"};
  const localJob=(await request("POST",route,admin,localUnknown,201)).task;
  const localTask=(await request("GET",next+"?wecomPreview=wecom-invitation-v4",agent)).task;
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
  const simpleTask=(await request('GET',next+'?wecomPreview=wecom-invitation-v4',agent)).task;
  assert.equal(simpleTask.payload.mode,'send');assert.equal(simpleTask.payload.remarkName,simple.remarkName);
  assert.equal(simpleTask.adbSerial,pool['59'].serial);
  const simpleClaim=`/api/v1/windows-agents/fixture-agent/wecom-preview-tasks/${simpleTask.taskId}/send-claim`;
  await request('POST',simpleClaim,agent,{},201);
  await request('POST',`/api/v1/windows-agent-tasks/${simpleTask.taskId}/status`,agent,{status:'succeeded',result:{previewStatus:'send_attempted',previewCode:'invitation_click_issued_delivery_unknown',sendStatus:'unknown',invitationSent:null,remarkSaveStatus:'confirmed'}});
  const externalResult=await request('GET',`${integration}/${accepted.taskId}`,admin);
  assert.equal(externalResult.status,'unknown');assert.equal(externalResult.taskId,accepted.taskId);
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

  const pending145=(await request('GET',next+'?wecomPreview=wecom-invitation-v4',agent)).task;
  await request('POST',`/api/v1/windows-agent-tasks/${pending145.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'not_found',invitationSent:false,remarkSaveStatus:'not_attempted'}});
  await request('POST',`/api/v1/windows-agent-tasks/${cloneSendTask.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'invitation_outcome_unknown_no_retry',sendStatus:'unknown',invitationSent:null}});
  const explicitClone={...simple,deviceNumber:155,appSlot:'clone',phoneNumber:'13900139000'};
  const cloneExternal=(await request('POST',integration,admin,explicitClone,202));
  const cloneDelivery=(await request('GET',next+'?wecomPreview=wecom-invitation-v4',agent)).task;
  assert.equal(cloneDelivery.payload.appSlot,'clone');assert.equal(cloneDelivery.payload.androidUser,999);
  assert.equal(cloneDelivery.payload.phoneNumber,explicitClone.phoneNumber);
  await request('POST',`/api/v1/windows-agent-tasks/${cloneDelivery.taskId}/status`,agent,{status:'failed',result:{previewStatus:'blocked',previewCode:'not_found',invitationSent:false,remarkSaveStatus:'not_attempted'}});
  const safeRetry=await request('POST',integration,admin,explicitClone,202);
  assert.notEqual(safeRetry.taskId,cloneExternal.taskId,'explicit pre-write failure can be retried without bypassing any send claim');

});
